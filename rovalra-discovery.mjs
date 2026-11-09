// Region-scoped public BL:R server ID discovery using RoValra's documented API.
// Not a Roblox server-list substitute: RoValra does NOT return occupancy/ping.
// Do not scrape, evade rate limits, copy provider IP addresses or promise freshness.
// RoValra terms: https://www.rovalra.com/tou/  Credits: https://www.rovalra.com/
const COUNTRIES = Object.freeze([
  'US','DE','SG','BR','GB','JP','AU','FR','CA','NL','AE','KR',
  'IN','PL','TR','HK','ID','ZA'
]);
const MODES = Object.freeze({'8v8':'124087144919678',pro:'99999183305180'});
const MAX_PER_MODE = 3;
const GLOBAL_GAP_MS = 120_000;
const LEASE_MS = 35_000;
const OBSERVATION_TTL_MS = 25 * 60_000;
const BACKOFF_MS = 15 * 60_000;
const SERVER_LIMIT = 120;
const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const safeText = value => typeof value === 'string'
  ? value.trim().replace(/[^\p{L}\p{N} .,'()-]/gu, '').slice(0, 60) : '';
const changes = result => Number(result?.meta?.changes ?? result?.changes ?? 0);

export function normalizeRoValraRecord(raw, countryFilter) {
  if (!raw || typeof raw.server_id !== 'string' || !UUID.test(raw.server_id)) return null;
  const city=safeText(raw.city), region=safeText(raw.region), country=safeText(raw.country);
  const code=typeof raw.region_code==='string' && /^[A-Z]{2}$/.test(raw.region_code)
    ? raw.region_code : countryFilter;
  const version=Number(raw.place_version);
  const firstSeen=typeof raw.first_seen === 'string' && !Number.isNaN(Date.parse(raw.first_seen))
    ? new Date(raw.first_seen).toISOString() : null;
  // All public fields are whitelisted: no IP address or datacenter IDs retained.
  return {
    id:raw.server_id.toLowerCase(),city,region,country,countryCode:code,
    version:Number.isSafeInteger(version)&&version>0&&version<1e9?version:null,
    firstSeen
  };
}
const buildResult = (mode, rows, now) => {
  const dedup=new Map();
  let regions=0, partial=false, lastScan=0;
  for(const row of rows){
    if(now-Number(row.observed_at)>OBSERVATION_TTL_MS || Number(row.observed_at)>now+60_000)continue;
    regions++;
    const age=now-Number(row.observed_at);
    lastScan=Math.max(lastScan,Number(row.observed_at));
    let payload;
    try{payload=JSON.parse(row.data_json)}catch{continue}
    partial ||= Boolean(payload.partial);
    if(!Array.isArray(payload.servers))continue;
    for(const entry of payload.servers){
      if(!entry || !UUID.test(String(entry.id||'')))continue;
      const id=entry.id.toLowerCase();
      const old=dedup.get(id);
      if(old && old.observedAt >= Number(row.observed_at))continue;
      const details={
        city:safeText(entry.city),region:safeText(entry.region),country:safeText(entry.country),
        version:Number.isSafeInteger(entry.version)?entry.version:null,
        firstSeen:entry.firstSeen||null
      };
      const location=[details.city,details.region,details.country].filter(Boolean).join(', ');
      dedup.set(id,{
        id,playing:null,maxPlayers:null,free:null,ping:null,playerTokens:[],
        details,region:location||null,regionDiagnostic:'resolved',
        discoverySource:'rovalra', observedAt:Number(row.observed_at),
        countryCode:entry.countryCode||row.country_code
      });
    }
  }
  const servers=[...dedup.values()].sort((a,b)=>
    (a.details.country||'').localeCompare(b.details.country||'')
    || (a.details.city||'').localeCompare(b.details.city||'')
    || a.id.localeCompare(b.id)
  ).slice(0,SERVER_LIMIT);
  return {
    mode,placeId:MODES[mode],source:'rovalra',at:lastScan||now,
    servers,scanned:regions,maxPages:COUNTRIES.length,
    hasMore:partial||dedup.size>SERVER_LIMIT||regions<COUNTRIES.length,
    regionCoverage:regions,regionTotal:COUNTRIES.length,
    warmingUp:servers.length===0 && regions<COUNTRIES.length,
    notes:'Provider-observed server IDs only. Player counts, open slots and ping are unknown. Observations may be older than five minutes.'
  };
};
async function readAll(db,mode,now) {
  const result=await db.prepare(
    'SELECT country_code, observed_at, data_json FROM rovalra_discovery_regions '+
    'WHERE mode=? AND observed_at>=? ORDER BY observed_at DESC'
  ).bind(mode,now-OBSERVATION_TTL_MS).all();
  return result?.results||[];
}
// On a cold start the 25-minute live cache may contain only zero-server
// countries. Prefer countries which historically returned matches, instead of
// waiting for the round-robin cursor to travel back to active regions.
// Historical observations determine scan ORDER only; they never become live IDs.
async function preferredColdStartCountries(db,now){
  try{
    const response=await db.prepare(
      'SELECT mode,country_code,observed_at,data_json FROM rovalra_discovery_regions '+
      'WHERE observed_at >= ? ORDER BY observed_at DESC'
    ).bind(now-24*60*60_000).all();
    const scores=new Map();
    for(const row of (response.results||[]).slice(0,COUNTRIES.length*2)){
      const code=row?.country_code;
      if(!COUNTRIES.includes(code))continue;
      const when=Number(row.observed_at);
      if(!Number.isFinite(when)||when>now+60_000 ||now-when<GLOBAL_GAP_MS)continue;
      let data;
      try{data=JSON.parse(row.data_json)}catch{continue}
      const count=Array.isArray(data?.servers)?data.servers.length:0;
      if(count===0)continue;
      const old=scores.get(code)||{count:0,at:0};
      old.count+=Math.min(100,count);
      old.at=Math.max(old.at,when);
      scores.set(code,old);
    }
    return [...scores].sort((a,b)=>b[1].count-a[1].count ||
      b[1].at-a[1].at).map(([code])=>code);
  }catch(err){
    // A priority hint must never break the ordinary bounded rotation.
    console.warn('RoValra scan priority unavailable:',String(err?.message||err));
    return [];
  }
}
async function claim(db,now){
  await db.prepare(
    "INSERT OR IGNORE INTO rovalra_discovery_gate (key,next_allowed_at,lease_until,cursor,failures) VALUES ('global',0,0,0,0)"
  ).run();
  const token=crypto.randomUUID();
  const lock=await db.prepare(
    "UPDATE rovalra_discovery_gate SET lease_token=?,lease_until=?,next_allowed_at=? "+
    "WHERE key='global' AND lease_until<=? AND next_allowed_at<=?"
  ).bind(token,now+LEASE_MS,now+GLOBAL_GAP_MS,now,now).run();
  if(changes(lock)!==1)return null;
  const state=await db.prepare("SELECT cursor,failures FROM rovalra_discovery_gate WHERE key='global'").first();
  return {token,cursor:Number(state?.cursor||0),failures:Number(state?.failures||0)};
}
async function finish(db,lease,next,failures){
  await db.prepare(
    "UPDATE rovalra_discovery_gate SET lease_token=NULL,lease_until=0,cursor=?,failures=?,next_allowed_at=? "+
    "WHERE key='global' AND lease_token=?"
  ).bind(next,failures,Date.now()+(failures?BACKOFF_MS:GLOBAL_GAP_MS),lease.token).run();
}
async function fetchRegion(mode, code, now){
  const url=new URL('https://apis.rovalra.com/v1/servers/region');
  url.searchParams.set('place_id',MODES[mode]);
  url.searchParams.set('region',code);
  let resp;
  try {
    resp=await fetch(url.toString(),{
      headers:{accept:'application/json'},signal:AbortSignal.timeout(5500)
    });
  } catch {
    return {ok:false, reason:'rovalra_unreachable'};
  }
  if(resp.status===429)return {ok:false,reason:'rovalra_rate_limited',limited:true};
  if(resp.status===401||resp.status===403)return {ok:false,reason:'rovalra_access_denied',limited:true};
  if(!resp.ok)return {ok:false,reason:'rovalra_http_error'};
  let data;
  try{data=await resp.json()}catch{return{ok:false,reason:'rovalra_invalid_response'};}
  if(data?.disabled===true)return{ok:false,reason:'rovalra_disabled',limited:true};
  if(data?.status!=='success'||!Array.isArray(data.servers))
    return {ok:false,reason:'rovalra_invalid_response'};
  const servers=[...new Map(data.servers.slice(0,200)
    .map(item=>normalizeRoValraRecord(item,code))
    .filter(Boolean).map(item=>[item.id,item])).values()];
  return {ok:true,code,mode,observedAt:now,partial:Boolean(data.next_cursor),
    servers:servers.slice(0,100)};
}
export async function getRoValraDiscovery(env,mode) {
  if(!MODES[mode] || !env.CUSTOMS_DB)throw Error('RoValra discovery is unavailable.');
  const db=env.CUSTOMS_DB, now=Date.now();
  let rows=await readAll(db,mode,now);
  let result=buildResult(mode,rows,now);
  let lease;
  try {lease=await claim(db,now);}
  catch(error){
    console.warn('RoValra D1 gate unavailable:',String(error?.message||error));
    if(result.servers.length)return result;
    throw new Error('RoValra region cache unavailable.');
  }
  if(lease){
    let failures=0, advanced=0;
    const i=lease.cursor%COUNTRIES.length;
    const roundRobin=Array.from({length:COUNTRIES.length},(_,k)=>COUNTRIES[(i+k)%COUNTRIES.length]);
    // If the requested mode has no fresh servers, fill this scan with
    // high-yield countries first. Preserve a small, globally gated request
    // budget and continue the ordinary rotation on subsequent refreshes.
    const historical=result.servers.length===0
      ? await preferredColdStartCountries(db,Date.now()) : [];
    const selected=[...new Set([...historical,...roundRobin])].slice(0,MAX_PER_MODE);
    try {
      // Only a handful of countries per shared refresh: both game modes reuse
      // this scan, avoiding separate bursts when a visitor changes tabs.
      outer:for(const country of selected){
        for(const gameMode of ['8v8','pro']){
          const feed=await fetchRegion(gameMode,country,Date.now());
          if(!feed.ok){
            console.warn('RoValra discovery stopped:',feed.reason,gameMode,country);
            failures=lease.failures+1;
            break outer;
          }
          await db.prepare(
            'INSERT INTO rovalra_discovery_regions (mode,country_code,observed_at,data_json) VALUES (?,?,?,?) '+
            'ON CONFLICT(mode,country_code) DO UPDATE SET observed_at=excluded.observed_at,data_json=excluded.data_json'
          ).bind(gameMode,country,feed.observedAt,
            JSON.stringify({servers:feed.servers,partial:feed.partial})).run();
        }
        advanced++;
      }
    }catch(error) {
      failures=lease.failures+1;
      console.warn('RoValra discovery scan storage error:',String(error?.message||error));
    }finally{
      try{await finish(db,lease,lease.cursor+advanced,failures)}
      catch(error){console.warn('RoValra discovery gate release failed:',String(error?.message||error));}
    }
    rows=await readAll(db,mode,Date.now());
    result=buildResult(mode,rows,Date.now());
  }
  if(result.servers.length)return result;
  // A valid empty provider result is different from an unavailable feed.
  if(result.regionCoverage) return result;
  const err=new Error('Region discovery is building its initial snapshot. Please retry shortly.');
  err.code='rovalra_snapshot_unavailable';
  throw err;
}
export const _test={COUNTRIES,buildResult,normalizeRoValraRecord};
