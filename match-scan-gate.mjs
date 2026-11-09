// Shared Roblox request gate. One D1 row coordinates all 8v8/Pro scans across
// Cloudflare isolates and modes; website/Discord do not bypass provider backoff.
const KEY = 'roblox-public-server-list';
const MIN_GAP_MS = 15_000;
const LEASE_MS = 15_000;
const BACKOFF_BASE_MS = 180_000;
const BACKOFF_MAX_MS = 60 * 60_000;

const seconds = ms => Math.max(1, Math.ceil(ms / 1000));
const changed = result => Number(result?.meta?.changes ?? result?.changes ?? 0) === 1;

function retryDelay(failures, retryAfterMs) {
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(8, failures - 1));
  const header = Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.min(BACKOFF_MAX_MS, Math.max(exponential, header));
}

// Never expose raw upstream payloads or tokens through D1/status responses.
const safeReason = error =>
  ['roblox_rate_limited','roblox_access_denied','roblox_timeout',
   'roblox_http_error','roblox_invalid_response','server_api_error',
   'scanner_storage_unavailable'].includes(error?.code)
    ? error.code : 'server_api_error';

export async function withServerScanGate(db, run) {
  if (!db) throw new Error('D1 scan coordination unavailable');
  // On missing table or DB failure, fail closed: never burst directly to Roblox.
  await db.prepare(
    'INSERT OR IGNORE INTO server_scan_gate (gate_key,next_allowed_at,lease_until,failures) VALUES (?,0,0,0)'
  ).bind(KEY).run();

  const now = Date.now();
  const token = crypto.randomUUID();
  const claim = await db.prepare(
    'UPDATE server_scan_gate SET lease_token=?,lease_until=?,next_allowed_at=?,last_attempt_at=? ' +
    'WHERE gate_key=? AND lease_until<=? AND next_allowed_at<=?'
  ).bind(token, now + LEASE_MS, now + MIN_GAP_MS, now, KEY, now, now).run();

  if (!changed(claim)) {
    const status = await db.prepare(
      'SELECT next_allowed_at,lease_until,last_error FROM server_scan_gate WHERE gate_key=?'
    ).bind(KEY).first();
    const busy = Number(status?.lease_until || 0) > now;
    const delay = Math.max(Number(status?.lease_until || 0), Number(status?.next_allowed_at || 0)) - now;
    return {status: busy ? 'busy' : 'cooldown', retryAfterSeconds:seconds(delay),
      reason:status?.last_error || (busy ? 'scan_in_progress' : 'scan_cooldown')};
  }

  try {
    const result = await run();
    await db.prepare(
      'UPDATE server_scan_gate SET lease_token=NULL,lease_until=0,next_allowed_at=?,failures=0,' +
      'last_error=NULL,last_success_at=? WHERE gate_key=? AND lease_token=?'
    ).bind(Date.now() + MIN_GAP_MS, Date.now(), KEY, token).run();
    return {status:'updated',result};
  } catch (error) {
    // Even if recording fails, the initial lease and gap limit immediate retries.
    const previous = await db.prepare('SELECT failures FROM server_scan_gate WHERE gate_key=?')
      .bind(KEY).first().catch(() => ({failures:0}));
    const failures = Math.min(20, Number(previous?.failures || 0) + 1);
    const delay = retryDelay(failures, error?.retryAfterMs);
    const reason = safeReason(error);
    await db.prepare(
      'UPDATE server_scan_gate SET lease_token=NULL,lease_until=0,next_allowed_at=?,failures=?,' +
      'last_error=? WHERE gate_key=? AND lease_token=?'
    ).bind(Date.now() + delay, failures, reason, KEY, token).run();
    console.warn('On-demand Roblox scan failed:', reason, 'retry in', seconds(delay), 'seconds');
    return {status:'failed',reason,retryAfterSeconds:seconds(delay)};
  }
}

export const _test = {retryDelay, safeReason};
