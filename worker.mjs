/**
 * Glutony — Discord user-installable Roblox 8v8 and Pro server browser on Cloudflare Workers.
 * No packages or Gateway connection required; paste this whole file in a Worker.
 * The list is a sample of Roblox public servers, NOT guaranteed exhaustive.
 * Roblox does not provide region in its public server list; RoValra may supply it.
 * Attribution: https://www.rovalra.com (external API, unofficial).
 */

const PLACE_IDS_DEFAULT = Object.freeze({
  '8v8': '124087144919678',
  pro: '99999183305180',
});
const MODES = Object.freeze({
  '8v8': {label: '8v8', title: 'BL:R 8v8', configKey: 'BLR_8V8_PLACE_ID'},
  pro: {label: 'Pro', title: 'BL:R Pro Servers', configKey: 'BLR_PRO_PLACE_ID'},
});
const API = 'https://discord.com/api/v10';
const PAGE_SIZE = 4;
const SOFT_CACHE_MS = 35_000;
const memoryCaches = new Map(); // Mode + Place ID -> most recent public server list
const detailCache = new Map(); // Place ID + Job ID -> { details, expiry }; isolate-local, best effort

const COMMAND = {
  name: 'blr',
  description: 'Browse Blue Lock: Rivals 8v8, Pro, and community servers',
  type: 1,
  integration_types: [0, 1],  // Guild Install and User Install
  contexts: [0, 1, 2],          // Servers, bot DMs, other DMs / group DMs
  options: [
    {
      name: 'mode', description: 'Which BL:R mode do you want?', type: 3, required: true,
      choices: [
        { name: '8v8 public servers', value: '8v8' },
        { name: 'Pro servers (10-player)', value: 'pro' },
        { name: 'Custom matches (coming soon)', value: 'customs' },
      ],
    },
    {
      name: 'sort', description: 'How should the servers be sorted?', type: 3, required: false,
      choices: [
        { name: 'Most players', value: 'players' },
        { name: 'Most free slots', value: 'space' },
        { name: 'Lowest reported ping', value: 'ping' },
      ],
    },
  ],
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function hexBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

async function verifyDiscord(request, rawBody, publicKeyHex) {
  const signature = hexBytes(request.headers.get('x-signature-ed25519'));
  const timestamp = request.headers.get('x-signature-timestamp');
  const pubkey = hexBytes(publicKeyHex);
  if (!signature || signature.length !== 64 || !pubkey || pubkey.length !== 32 || !timestamp) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  try {
    const key = await crypto.subtle.importKey('raw', pubkey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, signature, new TextEncoder().encode(timestamp + rawBody));
  } catch (error) {
    console.error('Signature verification unavailable:', error);
    return false;
  }
}

function equalSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function config(env, mode = '8v8') {
  const def = MODES[mode];
  if (!def) throw new Error('Unknown BL:R mode.');
  const placeId = String(env[def.configKey] || PLACE_IDS_DEFAULT[mode]);
  if (!/^\d{5,20}$/.test(placeId)) throw new Error(`${def.configKey} is invalid.`);
  const pages = Math.min(5, Math.max(1, Number.parseInt(env.ROBLOX_MAX_PAGES || '3', 10) || 3));
  return { mode, placeId, pages };
}

function normalizedServer(item) {
  if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.id)) return null;
  const playing = Number(item.playing), maxPlayers = Number(item.maxPlayers);
  if (!Number.isInteger(playing) || !Number.isInteger(maxPlayers) || playing < 0 || maxPlayers <= playing || maxPlayers > 500) return null;
  const ping = item.ping !== null && item.ping !== undefined && Number.isFinite(Number(item.ping)) && Number(item.ping) >= 0
    ? Math.round(Number(item.ping)) : null;
  const playerTokens = Array.isArray(item.playerTokens) ? item.playerTokens.filter(t => typeof t === 'string' && t.length < 500).slice(0, 6) : [];
  return { id: item.id, playing, maxPlayers, free: maxPlayers - playing, ping, playerTokens };
}

async function getServers(env, mode = '8v8', refresh = false) {
  const { placeId, pages } = config(env, mode);
  const cacheKey = `${mode}:${placeId}:${pages}`;
  const cached = memoryCaches.get(cacheKey);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && (age < SOFT_CACHE_MS || (refresh && age < 15_000))) {
    return cached;
  }
  const servers = new Map();
  let cursor = null;
  let pageCount = 0;
  do {
    const url = new URL(`https://games.roblox.com/v1/games/${placeId}/servers/Public`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('sortOrder', 'Asc');
    url.searchParams.set('excludeFullGames', 'true');
    if (cursor) url.searchParams.set('cursor', cursor);
    let response;
    try {
      response = await fetch(url.toString(), {
        headers: { 'accept': 'application/json', 'user-agent': 'GlutonyServerBrowser/1.1' },
        signal: AbortSignal.timeout(6500),
      });
    } catch (_) {
      if (cached) return cached; // Remain useful if Roblox has a temporary outage.
      throw new Error('Roblox did not respond. Please try again later.');
    }
    if (response.status === 429) {
      if (cached) return cached;
      throw new Error('Roblox is rate-limiting server requests. Please try again later.');
    }
    if (response.status === 401 || response.status === 403) throw new Error('Roblox denied API access from Cloudflare.');
    if (!response.ok) throw new Error(`Roblox server API returned HTTP ${response.status}.`);
    let payload;
    try { payload = await response.json(); } catch (_) { throw new Error('Roblox returned invalid JSON.'); }
    if (!payload || !Array.isArray(payload.data)) throw new Error('Roblox returned an unexpected server response.');
    for (const item of payload.data) {
      const server = normalizedServer(item);
      if (server) servers.set(server.id, server);
    }
    cursor = typeof payload.nextPageCursor === 'string' ? payload.nextPageCursor : null;
    pageCount++;
  } while (cursor && pageCount < pages);
  const result = {
    mode, at: Date.now(), placeId, maxPages: pages, servers: Array.from(servers.values()),
    hasMore: !!cursor, scanned: pageCount,
  };
  memoryCaches.set(cacheKey, result);
  return result;
}

// RoValra has a separate, optional server-details endpoint. It reports region,
// place_version, and first_seen. This information can be unavailable/stale.
// Never send Discord or Roblox credentials to it.
function safeLocationPart(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^\p{L}\p{N} .,\-']/gu, '').replace(/\s+/g, ' ').slice(0, 60);
}
function locationFromDetail(detail) {
  const city = safeLocationPart(detail?.city);
  const state = safeLocationPart(detail?.region);
  const country = safeLocationPart(detail?.country);
  const parts = [city, state !== city ? state : '', country]
    .filter(v => v && v.toLowerCase() !== 'unknown');
  return [...new Set(parts)].join(', ').slice(0, 140) || null;
}

const countryNames = {
  US: 'United States', BR: 'Brazil', SG: 'Singapore', DE: 'Germany', FR: 'France',
  GB: 'United Kingdom', UK: 'United Kingdom', JP: 'Japan', AU: 'Australia',
  CA: 'Canada', NL: 'Netherlands', IN: 'India', PL: 'Poland', ES: 'Spain',
  IT: 'Italy', KR: 'South Korea', HK: 'Hong Kong', ID: 'Indonesia',
  MX: 'Mexico', TH: 'Thailand', TR: 'Turkey', AE: 'United Arab Emirates',
};
function countryCode(value) {
  const raw = safeLocationPart(value).toLowerCase();
  if (!raw) return null;
  if (raw === 'uk') return 'GB';
  if (raw.length === 2 && /^[a-z]{2}$/.test(raw)) return raw.toUpperCase();
  const aliases = { 'united states of america': 'US', 'usa': 'US', 'great britain': 'GB', 'korea, republic of': 'KR', 'south korea': 'KR' };
  if (aliases[raw]) return aliases[raw];
  for (const [code, name] of Object.entries(countryNames)) if (name.toLowerCase() === raw) return code === 'UK' ? 'GB' : code;
  return null;
}
function flagEmoji(code) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return '🌐';
  return String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0)));
}
function shortLocation(server) {
  const d = server.details || {};
  const city = safeLocationPart(d.city);
  const state = safeLocationPart(d.region);
  const country = safeLocationPart(d.country);
  if (city) return city + (state && state !== city ? `, ${state}` : '');
  return countryNames[countryCode(country)] || country || 'Unknown region';
}
function regionFlag(server) { return flagEmoji(countryCode(server.details?.country)); }

function applyDetail(server, data) {
  if (!data) return;
  server.details = { ...data };
  server.region = data.location || null;
}

async function attachDetails(result, servers, env) {
  if (String(env.ROVALRA_REGIONS_ENABLED || 'true').toLowerCase() === 'false') return;
  const now = Date.now();
  const missing = [];
  for (const server of servers) {
    const cached = detailCache.get(`${result.placeId}:${server.id}`);
    if (cached && cached.expiry > now) applyDetail(server, cached.details);
    else missing.push(server);
  }
  if (!missing.length) return;
  const url = new URL('https://apis.rovalra.com/v1/servers/details');
  url.searchParams.set('place_id', result.placeId);
  url.searchParams.set('server_ids', missing.map(s => s.id).join(','));
  try {
    const response = await fetch(url.toString(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new Error(`RoValra HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.status !== 'success' || !Array.isArray(payload.servers)) throw new Error('Unexpected RoValra response');
    const found = new Map();
    for (const entry of payload.servers) {
      if (typeof entry?.server_id !== 'string') continue;
      const version = Number(entry.place_version);
      const firstSeen = typeof entry.first_seen === 'string' ? entry.first_seen.slice(0, 40) : null;
      found.set(entry.server_id, {
        location: locationFromDetail(entry),
        city: safeLocationPart(entry.city), region: safeLocationPart(entry.region), country: safeLocationPart(entry.country),
        version: Number.isInteger(version) && version > 0 && version < 1e9 ? version : null,
        firstSeen,
      });
    }
    for (const server of missing) {
      const details = found.get(server.id) || null;
      applyDetail(server, details);
      // Server metadata may arrive before RoValra learns its location. Retry missing
      // regions sooner, even when version and first_seen are already present.
      const lifetime = details?.location ? 180_000 : 45_000;
      detailCache.set(`${result.placeId}:${server.id}`, {details, expiry: now + lifetime});
    }
  } catch (err) {
    console.warn('Optional RoValra details failed:', String(err?.message || err));
    for (const server of missing) detailCache.set(`${result.placeId}:${server.id}`, {details: null, expiry: now + 30_000});
  }
  if (detailCache.size > 800) detailCache.clear();
}

function uptimeLabel(firstSeen) {
  if (!firstSeen) return 'Unknown';
  const ts = Date.parse(firstSeen.endsWith('Z') || /[+\-]\d\d:\d\d$/.test(firstSeen) ? firstSeen : firstSeen + 'Z');
  if (!Number.isFinite(ts)) return 'Unknown';
  const elapsed = Date.now() - ts;
  if (elapsed < 0 || elapsed > 90 * 86_400_000) return 'Unknown';
  const mins = Math.floor(elapsed / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days) return `~${days}d ${hours % 24}h`;
  if (hours) return `~${hours}h ${mins % 60}m`;
  return `~${mins}m`;
}

// Roblox's public server API may provide anonymized playerTokens. A public
// thumbnails batch endpoint can sometimes resolve those tokens to headshot URLs.
// Never attempt to reverse them into player identities; thumbnails are optional.
async function getPlayerHeadshots(server) {
  const tokens = (server.playerTokens || []).slice(0, 4);
  if (!tokens.length) return [];
  const requests = tokens.map((token, idx) => ({
    requestId: `glutony-${idx}-${token.slice(0, 12)}`,
    token, type: 'AvatarHeadShot', size: '150x150', format: 'Png', isCircular: true,
  }));
  try {
    const response = await fetch('https://thumbnails.roblox.com/v1/batch', {
      method: 'POST', headers: {'content-type': 'application/json', 'accept': 'application/json'},
      body: JSON.stringify(requests), signal: AbortSignal.timeout(4500),
    });
    if (!response.ok) throw new Error(`Roblox thumbnails HTTP ${response.status}`);
    const data = await response.json();
    return (Array.isArray(data?.data) ? data.data : [])
      .map(x => typeof x?.imageUrl === 'string' ? x.imageUrl : '')
      .filter(u => {
        try { const url = new URL(u); return url.protocol === 'https:' && (url.hostname === 'rbxcdn.com' || url.hostname.endsWith('.rbxcdn.com')); }
        catch { return false; }
      }).slice(0, 4);
  } catch (err) {
    console.warn('Optional player headshots failed:', String(err?.message || err));
    return [];
  }
}

function sortServers(items, sort) {
  if (sort === 'space') return [...items].sort((a, b) => b.free - a.free || b.playing - a.playing);
  if (sort === 'ping') return [...items].sort((a, b) => (a.ping ?? 1e9) - (b.ping ?? 1e9) || b.playing - a.playing);
  return [...items].sort((a, b) => b.playing - a.playing || b.free - a.free);
}

// Roblox's web /games/start can silently ignore gameInstanceId and matchmake randomly.
// Discord URL buttons require HTTPS, so direct clients through our /join landing page
// and require a user click to invoke the actual Roblox app protocol.
function joinLinks(placeId, jobId, origin = '') {
  const direct = `roblox://experiences/start?placeId=${placeId}&gameInstanceId=${jobId}`;
  const legacy = `roblox://placeId=${placeId}&gameInstanceId=${jobId}`;
  const web = new URL('https://www.roblox.com/games/start');
  web.searchParams.set('placeId', placeId);
  web.searchParams.set('gameInstanceId', jobId);
  const fallbackMobile = new URL('https://ro.blox.com/Ebh5');
  fallbackMobile.searchParams.set('af_dp', direct);
  fallbackMobile.searchParams.set('af_web_dp', web.toString());
  fallbackMobile.searchParams.set('deep_link_value', direct);
  if (!origin) return { pc: web.toString(), mobile: fallbackMobile.toString(), direct, legacy };
  const bridge = new URL('/join', origin);
  bridge.searchParams.set('placeId', placeId);
  bridge.searchParams.set('gameInstanceId', jobId);
  bridge.searchParams.set('device', 'pc');
  const mobile = new URL(bridge);
  mobile.searchParams.set('device', 'mobile');
  return {pc: bridge.toString(), mobile: mobile.toString(), direct, legacy, fallbackMobile: fallbackMobile.toString()};
}

function joinLanding(request, env) {
  const url = new URL(request.url);
  const placeId = url.searchParams.get('placeId') || '';
  const jobId = url.searchParams.get('gameInstanceId') || '';
  const device = url.searchParams.get('device') === 'mobile' ? 'mobile' : 'pc';
  const allowedIds = Object.keys(MODES).map(m => config(env, m).placeId);
  if (!allowedIds.includes(placeId) || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(jobId)) {
    return new Response('Invalid or unsupported BL:R server link.', {status: 400, headers: {'content-type':'text/plain; charset=utf-8'}});
  }
  const links = joinLinks(placeId, jobId);
  const modeName = placeId === config(env, 'pro').placeId ? 'Pro' : '8v8';
  const style = `body{margin:0;background:#0c1222;color:#edf2ff;font:16px system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(560px,92vw);padding:28px;box-sizing:border-box;background:#182238;border:1px solid #354462;border-radius:16px}h1{margin:0 0 10px;font-size:26px}p{color:#bfcee4;line-height:1.5}a.action{display:block;padding:14px 16px;border-radius:10px;background:#5865f2;color:white;text-align:center;text-decoration:none;font-weight:700;margin:16px 0 10px}.secondary{background:#2d405c!important}code{display:block;overflow-wrap:anywhere;padding:12px;background:#0c162b;border-radius:8px;font-size:13px;color:#dbe8fa}small{color:#abbad0}`;
  const mobileNote = device === 'mobile'
    ? `<a class="action secondary" rel="noreferrer" href="${links.mobile}">Try mobile universal link</a><p><small>If your browser blocks app links, open this page in Safari/Chrome and tap again.</small></p>`
    : `<p><small>On macOS, you can also run this Terminal command:</small></p><code>open &quot;${links.direct}&quot;</code>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Join BL:R ${modeName} — Glutony</title><style>${style}</style></head><body><main class="card"><h1>⚽ Join BL:R ${modeName}</h1><p>Target server ID:</p><code>${jobId}</code><a class="action" href="${links.direct}">Open target server in Roblox</a><a class="action secondary" href="${links.legacy}">Try alternate Roblox launch</a>${mobileNote}<p>⚠️ Roblox may ignore the server ID and send you to a different server. If that happens, the Roblox client did not honor this request; Glutony cannot force the join.</p><p><small>This is an unofficial Glutony server link. No Roblox login, cookies, or passwords are needed here.</small></p></main></body></html>`;
  return new Response(html, {headers: {'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",'referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
}

const V2 = 1 << 15;
const textPart = content => ({type: 10, content});
const actionRow = components => ({type: 1, components});
const button = (label, custom_id, disabled = false, primary = false) => ({type: 2, style: primary ? 1 : 2, custom_id, label, disabled});
const urlButton = (label, url) => ({type: 2, style: 5, label, url});
function v2Message(components) {
  return {flags: V2, components, allowed_mentions: {parse: []}};
}
function pagedServers(result, page, sort) {
  const items = sortServers(result.servers, sort);
  const total = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.max(0, Math.min(total - 1, page));
  return {items, total, current, visible: items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)};
}
function pingLabel(s) {return s.ping == null ? 'N/A' : `${s.ping} ms`;}

function listMessage(result, page, sort) {
  const {items, total, current, visible} = pagedServers(result, page, sort);
  const children = [
    textPart(`## ⚽ Glutony · ${MODES[result.mode || '8v8'].title}\n-# Public servers · Select one to join`),
  ];
  if (!items.length) children.push(textPart('No joinable servers found in the scanned pages. Try **Refresh**.'));
  for (const [i, s] of visible.entries()) {
    const number = current * PAGE_SIZE + i + 1;
    const region = shortLocation(s);
    const version = s.details?.version ? ` · v${s.details.version}` : '';
    children.push(textPart(`**${number}. ${regionFlag(s)} ${region}**\n${s.playing}/${s.maxPlayers} players · ${s.free} open · ${pingLabel(s)}${version}`));
  }
  children.push(textPart(`-# Page ${current + 1}/${total} · ${items.length} joinable server${items.length === 1 ? '' : 's'} in ${result.scanned} API page(s)${result.hasMore ? ' · More may exist' : ''}\n-# Locations and version: RoValra, when available · Ping: Roblox-reported`));
  const rows = [];
  if (visible.length) rows.push(actionRow([{
    type: 3, custom_id: `g:s:${result.mode || '8v8'}:${current}:${sort}`, placeholder: 'Choose a server to view & join',
    min_values: 1, max_values: 1,
    options: visible.map((s, i) => ({
      label: `${current * PAGE_SIZE + i + 1}. ${shortLocation(s)}`.slice(0, 100),
      value: s.id,
      description: `${s.playing}/${s.maxPlayers} players · ${pingLabel(s)}`.slice(0, 100),
      emoji: {name: regionFlag(s)},
    })),
  }]));
  rows.push(actionRow([
    button('◀ Previous', `g:p:${result.mode || '8v8'}:${current - 1}:${sort}`, current === 0),
    button('↻ Refresh', `g:r:${result.mode || '8v8'}:${current}:${sort}`, false, true),
    button('Next ▶', `g:p:${result.mode || '8v8'}:${current + 1}:${sort}`, current + 1 >= total),
  ]));
  return v2Message([{type: 17, accent_color: 0x32c99a, components: children}, ...rows]);
}

function detailMessage(result, server, page, sort, headshots, origin = '') {
  const links = joinLinks(result.placeId, server.id, origin);
  const country = countryCode(server.details?.country);
  const flag = country ? `https://flagcdn.com/w80/${country.toLowerCase()}.png` : null;
  const fullRegion = server.region || 'Unknown region';
  const age = uptimeLabel(server.details?.firstSeen);
  const version = server.details?.version ? `v${server.details.version}` : 'Unknown';
  const children = [
    textPart(`## ${regionFlag(server)} ${fullRegion}\n-# ${MODES[result.mode || '8v8'].title} · Public server`),
    {type: 14, divider: true, spacing: 1},
    textPart(`### ${server.playing} / ${server.maxPlayers} players\n${server.free} slots available · **${pingLabel(server)}** Roblox-reported ping`),
    textPart(`**Place version:** ${version}\n**Uptime:** ${age} (estimated from first seen)\n**Server ID:** \`${server.id}\``),
  ];
  if (headshots.length) {
    children.push({type: 14, divider: true, spacing: 1});
    children.push(textPart(`**Players** · ${headshots.length} preview${headshots.length === 1 ? '' : 's'}${server.playing > headshots.length ? ` · +${server.playing - headshots.length} others` : ''}`));
    children.push({type: 12, items: headshots.map((url, i) => ({media: {url}, description: `Player avatar preview ${i + 1}`}))});
  } else {
    children.push(textPart('-# Player headshots unavailable from Roblox right now.'));
  }
  children.push(textPart('-# Region, version and age via RoValra where available · Slots may change before joining\n-# Roblox can ignore target instance IDs; join links are best-effort.'));
  // Discord Components V2 allows a thumbnail beside a section. Use the emoji
  // in the heading, plus the flag image when the country is known.
  if (flag) {
    children[0] = {type: 9, components: [children[0]], accessory: {type: 11, media: {url: flag}, description: `${country} flag`}};
  }
  return v2Message([
    {type: 17, accent_color: 0x32c99a, components: children},
    actionRow([urlButton('Join PC', links.pc), urlButton('Join Mobile', links.mobile)]),
    actionRow([button('◀ Back to servers', `g:b:${result.mode || '8v8'}:${page}:${sort}`), button('↻ Refresh details', `g:d:${result.mode || '8v8'}:${server.id}:${page}:${sort}`, false, true)]),
  ]);
}

function errorMessage(title, description, retryId) {
  const data = [ {type:17, accent_color:0xe57373, components:[textPart(`### ⚠️ ${title}\n${String(description).slice(0,800)}`)]} ];
  if (retryId) data.push(actionRow([button('↻ Retry',retryId,false,true)]));
  return v2Message(data);
}

async function editOriginal(interaction, data) {
  const url = `${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const response = await fetch(url, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  if (!response.ok) console.error('Discord edit failed', response.status, (await response.text()).slice(0, 200));
}

function responseCallback(type, data) { return json(data === undefined ? { type } : { type, data }); }

async function renderList(interaction, env, mode, page, sort, refresh) {
  try {
    const result = await getServers(env, mode, refresh);
    const {visible} = pagedServers(result, page, sort);
    await attachDetails(result, visible, env);
    await editOriginal(interaction, listMessage(result, page, sort));
  } catch (error) {
    console.error('Glutony list failure:', error);
    await editOriginal(interaction, errorMessage('Could not load servers', error?.message || 'Unknown error', `g:r:${mode}:0:${sort}`));
  }
}

async function renderDetail(interaction, env, mode, jobId, page, sort, refresh, origin) {
  try {
    const result = await getServers(env, mode, refresh);
    const server = result.servers.find(s => s.id === jobId);
    if (!server) {
      await editOriginal(interaction, errorMessage('Server not found', 'The server may have closed or the listing has changed.', `g:b:${result.mode || '8v8'}:${page}:${sort}`));
      return;
    }
    await attachDetails(result, [server], env);
    const headshots = await getPlayerHeadshots(server);
    await editOriginal(interaction, detailMessage(result, server, page, sort, headshots, origin));
  } catch (error) {
    console.error('Glutony detail failure:', error);
    await editOriginal(interaction, errorMessage('Could not load details', error?.message || 'Unknown error', `g:b:${mode}:${page}:${sort}`));
  }
}

async function onInteraction(interaction, env, ctx, origin) {
  if (interaction.type === 1) return responseCallback(1);
  if (interaction.type === 2 && interaction.data?.name === 'blr') {
    const params = Object.fromEntries((interaction.data.options || []).map(v => [v.name, v.value]));
    if (params.mode === 'customs') return responseCallback(4, {
      content: '⚽ **Glutony Customs is planned!** Soon, players will be able to share private-server invitations and find teammates.',
      flags: 64, allowed_mentions: {parse: []},
    });
    if (!MODES[params.mode]) return responseCallback(4, {content: 'Unknown mode.', flags:64});
    const sort = ['players', 'space', 'ping'].includes(params.sort) ? params.sort : 'players';
    ctx.waitUntil(renderList(interaction, env, params.mode, 0, sort, false));
    // Public response: omit EPHEMERAL (64) so the server browser is visible in chat.
    return responseCallback(5);
  }
  if (interaction.type === 3) {
    const id = interaction.data?.custom_id || '';
    // Current IDs include mode to avoid accidentally switching to 8v8 when
    // navigating a Pro server list. Older 8v8 messages are still supported.
    const nav = /^g:(p|r|b):(?:(8v8|pro):)?(-?\d{1,3}):(players|space|ping)$/.exec(id);
    if (nav) {
      const mode = nav[2] || '8v8';
      const page = Math.min(99, Math.max(0, Number(nav[3])));
      ctx.waitUntil(renderList(interaction, env, mode, page, nav[4], nav[1] === 'r'));
      return responseCallback(6);
    }
    const select = /^g:s:(?:(8v8|pro):)?(\d{1,3}):(players|space|ping)$/.exec(id);
    if (select) {
      const jobId = interaction.data?.values?.[0] || '';
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(jobId))
        return responseCallback(4, {content:'Invalid server selection.', flags:64});
      ctx.waitUntil(renderDetail(interaction, env, select[1] || '8v8', jobId, Number(select[2]), select[3], false, origin));
      return responseCallback(6);
    }
    const detail = /^g:d:(?:(8v8|pro):)?([0-9a-f-]{36}):(\d{1,3}):(players|space|ping)$/i.exec(id);
    if (detail) {
      ctx.waitUntil(renderDetail(interaction, env, detail[1] || '8v8', detail[2], Number(detail[3]), detail[4], true, origin));
      return responseCallback(6);
    }
    return responseCallback(4, {content:'This button is no longer supported. Run `/blr` again.', flags:64});
  }
  return responseCallback(4, {content:'Unsupported command.', flags:64});
}

// Public, read-only endpoint for https://blr.n29.kz/servers/.
// Never return Discord credentials or raw anonymous player tokens.
const SITE_ORIGIN = 'https://blr.n29.kz';
const websiteHeaders = {
  'access-control-allow-origin': SITE_ORIGIN,
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'vary': 'Origin',
  'cache-control': 'public, max-age=20, stale-while-revalidate=30',
  'x-content-type-options': 'nosniff',
};
function siteJson(data, status = 200) {
  return new Response(JSON.stringify(data), {status, headers:{...websiteHeaders, 'content-type':'application/json; charset=utf-8'}});
}
async function websiteServers(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || '8v8';
  if (!MODES[mode]) return siteJson({error:'Unknown mode; choose 8v8 or pro.'}, 400);
  try {
    const result = await getServers(env, mode, false);
    // Fetch regional details in a single RoValra batch. Cap it for rate limits.
    const entries = result.servers.slice(0, 60);
    for (let i=0; i<Math.min(entries.length, 60); i+=20) {
      await attachDetails(result, entries.slice(i, i+20), env);
    }
    const servers = entries.map(s => ({
      id: s.id, playing: s.playing, maxPlayers: s.maxPlayers,
      free: s.free, ping: s.ping, region: s.region || null,
      city: s.details?.city || null, state: s.details?.region || null,
      country: s.details?.country || null,
      countryCode: countryCode(s.details?.country),
      version: s.details?.version ?? null,
      firstSeen: s.details?.firstSeen ?? null,
      // Join links lead to a click-to-launch page, not broken Roblox web matchmaking.
      joinPc: joinLinks(result.placeId, s.id, url.origin).pc,
      joinMobile: joinLinks(result.placeId, s.id, url.origin).mobile,
    }));
    return siteJson({
      mode, placeId: result.placeId, servers, count: servers.length,
      scanned: result.scanned, hasMore: result.hasMore || result.servers.length > entries.length,
      updatedAt: new Date(result.at).toISOString(),
      disclaimer: 'Locations and versions are provided by RoValra where available. Roblox may ignore target instance IDs.'
    });
  } catch (error) {
    console.error('Website server API failed:', error);
    return siteJson({error:'Server list unavailable. Try refreshing shortly.'}, 503);
  }
}
// Website background lookup: only recheck up to 8 still-active servers.
// Frontend schedules this every ~75s while visible; positive locations cached 3 min.
// No user/session credentials or player tokens are returned.
async function websiteRegions(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || '8v8';
  if (!MODES[mode]) return siteJson({error:'Unknown mode.'}, 400);
  const rawIds = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
  if (!rawIds.length || rawIds.length > 8 ||
      rawIds.some(id => !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
    return siteJson({error:'Provide 1–8 valid server IDs.'}, 400);
  }
  try {
    const result = await getServers(env, mode, false);
    const selected = [...new Set(rawIds.map(id => id.toLowerCase()))]
      .map(id => result.servers.find(server => server.id.toLowerCase() === id))
      .filter(Boolean);
    if (!selected.length) return siteJson({regions:{}, checkedAt:new Date().toISOString()});
    await attachDetails(result, selected, env);
    const regions = {};
    for (const server of selected) {
      const d = server.details;
      regions[server.id] = {
        region: server.region || null,
        city: d?.city || null,
        state: d?.region || null,
        country: d?.country || null,
        countryCode: countryCode(d?.country),
        version: d?.version ?? null,
        firstSeen: d?.firstSeen ?? null,
      };
    }
    return siteJson({regions, checkedAt:new Date().toISOString()});
  } catch (error) {
    console.warn('Passive region refresh failed:', String(error?.message || error));
    return siteJson({error:'Region lookup unavailable.'},503);
  }
}

async function websiteHeadshots(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || '8v8';
  const jobId = url.searchParams.get('id') || '';
  if (!MODES[mode] || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(jobId)) {
    return siteJson({error:'Invalid mode or server ID.'}, 400);
  }
  try {
    const result = await getServers(env, mode, false);
    const server = result.servers.find(s => s.id.toLowerCase() === jobId.toLowerCase());
    if (!server) return siteJson({error:'Server is no longer listed.'}, 404);
    const headshots = await getPlayerHeadshots(server);
    return siteJson({images:headshots, playing:server.playing});
  } catch (error) {
    console.warn('Public avatar lookup failed:', String(error));
    return siteJson({images:[]});
  }
}

async function registerCommand(request, env) {
  if (!env.SETUP_KEY || env.SETUP_KEY.length < 20 || !equalSecret(request.headers.get('authorization'), `Bearer ${env.SETUP_KEY}`)) {
    return json({ error: 'Not authorized. Provide an Authorization: Bearer header with your long SETUP_KEY.' }, 403);
  }
  if (!env.DISCORD_BOT_TOKEN || !/^\d{15,22}$/.test(String(env.DISCORD_APPLICATION_ID || ''))) {
    return json({ error: 'Configure DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID first.' }, 400);
  }
  const response = await fetch(`${API}/applications/${env.DISCORD_APPLICATION_ID}/commands`, {
    method: 'POST',
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(COMMAND),
  });
  const body = await response.text();
  if (!response.ok) return json({ error: 'Discord rejected /blr registration', status: response.status, detail: body.slice(0, 1200) }, 502);
  const command = JSON.parse(body);
  return json({ ok: true, registered: command.name, command_id: command.id, user_install_enabled: true });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/') {
      return json({ bot: 'Glutony', status: 'online', mode: 'Cloudflare Workers', interaction_endpoint: '/interactions' });
    }
    if (request.method === 'OPTIONS' && pathname.startsWith('/api/servers')) {
      return new Response(null, {status:204,headers:websiteHeaders});
    }
    if (request.method === 'GET' && pathname === '/api/servers') return websiteServers(request, env);
    if (request.method === 'GET' && pathname === '/api/servers/regions') return websiteRegions(request, env);
    if (request.method === 'GET' && pathname === '/api/servers/avatars') return websiteHeadshots(request, env);
    if (request.method === 'GET' && pathname === '/join') return joinLanding(request, env);
    if (request.method === 'POST' && pathname === '/admin/register') return registerCommand(request, env);
    if (request.method !== 'POST' || pathname !== '/interactions') return json({ error: 'Not found' }, 404);
    if (!env.DISCORD_PUBLIC_KEY) return json({ error: 'DISCORD_PUBLIC_KEY is not configured.' }, 500);
    const rawBody = await request.text();
    if (!await verifyDiscord(request, rawBody, env.DISCORD_PUBLIC_KEY)) return json({ error: 'Invalid Discord signature.' }, 401);
    let interaction;
    try { interaction = JSON.parse(rawBody); } catch (_) { return json({ error: 'Malformed JSON' }, 400); }
    try { return await onInteraction(interaction, env, ctx, new URL(request.url).origin); }
    catch (error) { console.error(error); return responseCallback(4, { content: 'An unexpected error occurred.', flags: 64 }); }
  },
};

export const _test = { config, memoryCaches, hexBytes, verifyDiscord, equalSecret, normalizedServer, sortServers, joinLinks, joinLanding, listMessage, detailMessage, pagedServers, getServers, attachDetails, locationFromDetail, flagEmoji, countryCode, uptimeLabel, getPlayerHeadshots, COMMAND };