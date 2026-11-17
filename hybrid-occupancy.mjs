// Best-effort occupancy overlay: RoValra discovers public Job IDs; a rare
// Roblox public-server page can verify counts for matching instance IDs.
// It is NEVER a separate lookup by Job ID, and cannot verify unmatched IDs.
import {withServerScanGate} from './match-scan-gate.mjs';

export const OCCUPANCY_MAX_AGE_MS = 60_000;
export const MIN_ROBLOX_PROBE_INTERVAL_MS = 30_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export async function overlayRecentRobloxOccupancy(env, result) {
  if (env.ROBLOX_HYBRID_ENRICH_ENABLED!=='true' || result?.source !== 'rovalra' || !env.CUSTOMS_DB || !Array.isArray(result.servers))return result;
  result.enrichedCount=0;
  result.enrichmentSampleAt=null;
  let row;
  try {
    row=await env.CUSTOMS_DB.prepare('SELECT snapshot FROM server_snapshots WHERE cache_key=?')
      .bind(result.mode+':'+result.placeId+':1').first();
  } catch(error) {
    console.warn('Optional Roblox occupancy snapshot read failed:',String(error?.message||error));
    return result;
  }
  if(!row?.snapshot)return result;
  let snapshot;
  try {snapshot=JSON.parse(row.snapshot);}
  catch {return result;}
  const at=Number(snapshot?.at);
  if(!Number.isFinite(at) || at>Date.now()+10_000 || Date.now()-at>OCCUPANCY_MAX_AGE_MS
     || snapshot.mode!==result.mode || String(snapshot.placeId)!==String(result.placeId)
     || !Array.isArray(snapshot.servers)) return result;

  const byId=new Map();
  for(const item of snapshot.servers.slice(0,100)){
    if(!item || typeof item.id!=='string'|| !UUID.test(item.id))continue;
    const playing=item.playing,maxPlayers=item.maxPlayers;
    if(!Number.isInteger(playing)||!Number.isInteger(maxPlayers)
       ||playing<0||maxPlayers<=0||maxPlayers<playing||maxPlayers>500)continue;
    byId.set(item.id.toLowerCase(),{
      playing,maxPlayers,free:maxPlayers-playing,
      ping:Number.isInteger(item.ping)&&item.ping>=0?item.ping:null
    });
  }

  // A successful, complete one-page Roblox listing is the live roster. RoValra
  // caches regional observations longer, so its unmatched IDs can be closed
  // servers; never present those old observations as additional live matches.
  const complete = snapshot.scanned===1 && snapshot.hasMore===false &&
    snapshot.servers.length===byId.size;
  if(complete){
    const observed=new Map(result.servers.filter(s=>UUID.test(String(s.id||'')))
      .map(s=>[s.id.toLowerCase(),s]));
    const verified=[];
    for(const [id,occupancy] of byId){
      // Keep RoValra location metadata, but include newly live Roblox servers
      // even if regional discovery hasn't seen their IDs yet.
      const existing=observed.get(id);
      const server=existing?{...existing}:{
        id,playing:null,maxPlayers:null,free:null,ping:null,
        region:null,regionDiagnostic:'not_checked',details:null,
        discoverySource:'roblox',observedAt:at
      };
      Object.assign(server,occupancy,{occupancyObservedAt:at,occupancyVerified:true});
      verified.push(server);
    }
    result.unconfirmedRoValraCount=[...observed.keys()].filter(id=>!byId.has(id)).length;
    result.servers=verified;
    result.enrichedCount=verified.length;
    result.countsVerified=true;
    result.rosterSource='roblox';
  }else{
    // Partial scans can verify matching IDs, but cannot disprove the others.
    for(const item of result.servers){
      const matched=byId.get(String(item.id||'').toLowerCase());
      if(!matched)continue;
      Object.assign(item,matched,{occupancyObservedAt:at,occupancyVerified:true});
      result.enrichedCount++;
    }
  }
  result.enrichmentSampleAt=at;
  return result;
}

export async function maybeProbeRobloxOccupancy(env,mode,placeId,scan) {
  if(env.ROBLOX_HYBRID_ENRICH_ENABLED!=='true' || !env.CUSTOMS_DB ||
    !['8v8','pro'].includes(mode) || typeof scan!=='function')return {status:'disabled'};
  try {
    return await withServerScanGate(env.CUSTOMS_DB,
      () => scan(env,mode,mode+':'+placeId+':1'),
      {minimumAttemptIntervalMs:MIN_ROBLOX_PROBE_INTERVAL_MS});
  } catch(error) {
    console.warn('Optional Roblox occupancy probe skipped:',String(error?.message||error));
    return {status:'unavailable'};
  }
}
