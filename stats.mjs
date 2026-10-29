// Glutony usage analytics. Discord IDs are HMAC-pseudonymized before storage.
// Analytics are collected only from signature-verified Discord slash commands.
export const STATS_COMMAND = {
  name: 'stats',
  description: 'Glutony usage statistics and sampled BL:R server activity',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [{
    name: 'view',
    description: 'Bot usage or a live sample of public BL:R servers',
    type: 3,
    required: false,
    choices: [
      { name: 'Bot usage (last 7 days)', value: 'bot' },
      { name: '8v8 server activity', value: '8v8' },
      { name: 'Pro server activity', value: 'pro' },
      { name: 'Main lobby activity', value: 'main' },
    ],
  }],
};

const DAY_MS = 86_400_000;
const KNOWN_COMMANDS = new Set(['blr', 'download', 'stats', 'info']);
const KNOWN_MODES = new Set(['8v8', 'pro', 'main', 'customs']);
const number = v => Number(v || 0).toLocaleString('en-US');
const dayAt = ms => new Date(ms).toISOString().slice(0, 10);
const snowflake = value => /^\d{15,22}$/.test(String(value || ''));

function hmacInput(interaction) {
  const actor = interaction.member?.user?.id || interaction.user?.id || '';
  return {
    actor: snowflake(actor) ? String(actor) : '',
    guild: snowflake(interaction.guild_id) ? String(interaction.guild_id) : '',
  };
}
async function tokenFor(secret, dimension, id) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dimension + ':' + id));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

// This function runs through ctx.waitUntil and must never delay or fail a command.
export async function recordStats(env, interaction) {
  const db = env.CUSTOMS_DB;
  if (!db || interaction.type !== 2 || !snowflake(interaction.id)) return;
  const command = String(interaction.data?.name || '');
  if (!KNOWN_COMMANDS.has(command)) return;
  const modeValue = command === 'blr'
    ? (interaction.data?.options || []).find(option => option.name === 'mode')?.value
    : '';
  const mode = KNOWN_MODES.has(modeValue) ? modeValue : '';
  const now = Date.now();
  const day = dayAt(now);

  try {
    // Deduplicate Discord retries. A single unique insert gates all aggregates.
    const seen = await db.prepare(
      'INSERT OR IGNORE INTO stats_seen (interaction_id, created_at) VALUES (?, ?)'
    ).bind(String(interaction.id), now).run();
    if (seen.meta?.changes !== 1) return;
    await db.prepare(
      'INSERT INTO stats_daily (day, command, mode, uses) VALUES (?, ?, ?, 1) ' +
      'ON CONFLICT(day, command, mode) DO UPDATE SET uses = uses + 1'
    ).bind(day, command, mode).run();

    // SETUP_KEY is already a secret in Glutony; a separate STATS_HASH_KEY can override it.
    // Without a secret, count command calls but do not persist user/guild identifiers.
    const secret = String(env.STATS_HASH_KEY || env.SETUP_KEY || '');
    if (secret.length >= 20) {
      const ids = hmacInput(interaction);
      for (const [dimension, id] of [['user', ids.actor], ['guild', ids.guild]]) {
        if (!id) continue;
        const hashed = await tokenFor(secret, dimension, id);
        await db.prepare(
          'INSERT OR IGNORE INTO stats_unique (day, dimension, token) VALUES (?, ?, ?)'
        ).bind(day, dimension, hashed).run();
      }
    }
    // Opportunistic cleanup; preserve aggregate daily counts indefinitely.
    // Stats are not based on these short-lived dedupe and uniqueness rows after 30 days.
    if (now % 97 === 0) {
      await db.prepare('DELETE FROM stats_seen WHERE created_at < ?')
        .bind(now - 14 * DAY_MS).run();
      await db.prepare('DELETE FROM stats_unique WHERE day < ?')
        .bind(dayAt(now - 30 * DAY_MS)).run();
    }
  } catch (error) {
    console.warn('Glutony stats collection unavailable (apply migration 0003):', String(error));
  }
}

export async function botStatsMessage(env, now = Date.now()) {
  if (!env.CUSTOMS_DB) {
    return '📊 **Glutony statistics**\nStats database is not configured (CUSTOMS_DB).';
  }
  const cutoff = dayAt(now - 6 * DAY_MS);
  try {
    const db = env.CUSTOMS_DB;
    const allTime = await db.prepare('SELECT COALESCE(SUM(uses), 0) AS n FROM stats_daily').first();
    const week = await db.prepare(
      'SELECT command, mode, SUM(uses) AS n FROM stats_daily WHERE day >= ? ' +
      'GROUP BY command, mode ORDER BY n DESC'
    ).bind(cutoff).all();
    const users = await db.prepare(
      "SELECT COUNT(DISTINCT token) AS n FROM stats_unique WHERE day >= ? AND dimension = 'user'"
    ).bind(cutoff).first();
    const guilds = await db.prepare(
      "SELECT COUNT(DISTINCT token) AS n FROM stats_unique WHERE day >= ? AND dimension = 'guild'"
    ).bind(cutoff).first();
    const rows = week.results || [];
    const sum = rows.reduce((acc, item) => acc + Number(item.n || 0), 0);
    const used = command => rows.reduce((acc, row) => acc + (row.command === command ? Number(row.n || 0) : 0), 0);
    const modes = ['8v8', 'pro', 'main', 'customs'];
    const modeLabels = {'8v8': '8v8', pro: 'Pro', main: 'Main', customs: 'Customs'};
    const modeLine = modes.map(mode => {
      const n = rows.filter(row => row.command === 'blr' && row.mode === mode)
        .reduce((acc, row) => acc + Number(row.n || 0), 0);
      return `${modeLabels[mode]}: **${number(n)}**`;
    }).join(' · ');
    return [
      '## 📊 Glutony · Bot statistics',
      '-# Last 7 UTC calendar days, including today',
      `**Command uses:** ${number(sum)} this week · ${number(allTime?.n)} all time`,
      `**Unique users:** ${number(users?.n)} · **Unique servers:** ${number(guilds?.n)}`,
      '',
      '**Command breakdown**',
      `/blr: **${number(used('blr'))}** · /download: **${number(used('download'))}** · /stats: **${number(used('stats'))}** · /info: **${number(used('info'))}**`,
      '',
      '**/blr mode breakdown**',
      modeLine,
      '',
      '-# Counts include attempted commands, not just successful results. User/server counts are anonymized; server count excludes DMs.',
      '-# Stats begin when tracking is deployed and migration 0003 is applied.',
    ].join('\n');
  } catch (error) {
    console.warn('Glutony stats read failed:', String(error));
    return '📊 **Glutony statistics**\nStats are not ready. Apply the latest Cloudflare D1 migration (0003) to enable tracking.';
  }
}

export function serverStatsMessage(result) {
  const servers = Array.isArray(result?.servers) ? result.servers : [];
  const modes = {'8v8': '8v8', pro: 'Pro', main: 'Main lobby'};
  const count = servers.length;
  const players = servers.reduce((n, s) => n + (Number(s.playing) || 0), 0);
  const free = servers.reduce((n, s) => n + (Number(s.free) || 0), 0);
  const total = players + free;
  const pings = servers.map(s => Number(s.ping)).filter((n, i) => servers[i].ping != null && Number.isFinite(n));
  const avg = pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) + ' ms' : 'N/A';
  const occupancy = total ? (players / total * 100).toFixed(1) + '%' : 'N/A';
  return [
    `## ⚽ Glutony · ${modes[result.mode] || 'BL:R'} activity`,
    `**Joinable servers sampled:** ${number(count)}`,
    `**Players in sample:** ${number(players)} · **Free slots:** ${number(free)}`,
    `**Sampled capacity used:** ${occupancy}`,
    `**Average Roblox-reported ping:** ${avg}`,
    '',
    `-# ${number(result.scanned)} public API page(s) scanned${result.hasMore ? ' · More servers may exist' : ''}.`,
    '-# This is not a global player count: full servers and unsampled pages are excluded. Ping is not your personal latency.',
    '-# Refreshed from the same bounded Roblox API sample used by /blr.',
  ].join('\n');
}
