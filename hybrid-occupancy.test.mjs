import assert from 'node:assert/strict';
import {overlayRecentRobloxOccupancy,maybeProbeRobloxOccupancy,
  OCCUPANCY_MAX_AGE_MS,MIN_ROBLOX_PROBE_INTERVAL_MS} from './hybrid-occupancy.mjs';

const before=Date.now;
let clock=Date.UTC(2026,10,9,20,0);
Date.now=()=>clock;
const idA='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const idB='11111111-2222-3333-4444-555555555555';
const snapshots=new Map();
let gate=null;
let scans=0;
const changed=n=>({meta:{changes:n}});
const db={
  prepare(sql){
    return {
      bind(...args){return statement(sql,args);},
      ...statement(sql,[])
    };
  },
};
function statement(sql,args) {
  return {
    async first() {
      if (sql.startsWith('SELECT snapshot FROM server_snapshots')) {
        const snapshot=snapshots.get(args[0]);
        return snapshot?{snapshot:JSON.stringify(snapshot)}:null;
      }
      if (sql.includes('FROM server_scan_gate'))return gate?{...gate}:null;
      throw Error('Unexpected SQL read: '+sql);
    },
    async run() {
      if(sql.startsWith('INSERT OR IGNORE INTO server_scan_gate')){
        if(!gate)gate={gate_key:args[0],lease_until:0,next_allowed_at:0,last_attempt_at:null,
          last_error:null,failures:0,lease_token:null};
        return changed(1);
      }
      if(sql.startsWith('UPDATE server_scan_gate SET lease_token=?')){
        const [token,lease,next,attempt,key,now,allowed,cutoff]=args;
        if(!gate||gate.gate_key!==key||gate.lease_until>now||gate.next_allowed_at>allowed||
           gate.last_attempt_at!==null && gate.last_attempt_at>cutoff)return changed(0);
        Object.assign(gate,{lease_token:token,lease_until:lease,next_allowed_at:next,last_attempt_at:attempt});
        return changed(1);
      }
      if(sql.startsWith('UPDATE server_scan_gate SET lease_token=NULL')){
        const [next,...tail]=args;
        const token=tail.at(-1);
        if(gate?.lease_token!==token)return changed(0);
        gate.lease_token=null;gate.lease_until=0;gate.next_allowed_at=next;
        if(sql.includes('failures=0')){
          gate.failures=0;gate.last_error=null;gate.last_success_at=tail[0];
        } else {
          gate.failures=tail[0];gate.last_error=tail[1];
        }
        return changed(1);
      }
      throw Error('Unexpected SQL write: '+sql);
    }
  };
}
const env={CUSTOMS_DB:db,ROBLOX_HYBRID_ENRICH_ENABLED:'true'};
const makeListing=(mode='8v8',id=idA)=>({
  source:'rovalra',mode,placeId:mode==='pro'?'99999183305180':'124087144919678',
  servers:[{id,playing:null,maxPlayers:null,free:null,ping:null},
    {id:idB,playing:null,maxPlayers:null,free:null,ping:null}]
});
try {
  snapshots.set('8v8:124087144919678:1',{
    mode:'8v8',placeId:'124087144919678',at:clock-90_000,servers:[
      {id:idA,playing:7,maxPlayers:16,ping:68,playerTokens:['not-exposed']},
      {id:'22222222-3333-4444-5555-666666666666',playing:3,maxPlayers:16,ping:80}
    ]
  });
  let result=await overlayRecentRobloxOccupancy(env,makeListing());
  assert.equal(result.enrichedCount,1);
  assert.equal(result.servers[0].playing,7);
  assert.equal(result.servers[0].free,9);
  assert.equal(result.servers[0].ping,68);
  assert.equal(result.servers[0].occupancyVerified,true);
  assert.equal(result.servers[1].playing,null);
  assert.equal(result.servers[1].occupancyVerified,undefined);
  assert.ok(!JSON.stringify(result).includes('not-exposed'),'Never expose Roblox player tokens');
  result=await overlayRecentRobloxOccupancy(env,makeListing('pro'));
  assert.equal(result.enrichedCount,0,'Never match data from other modes');
  assert.equal(result.servers[0].playing,null);
  clock+=OCCUPANCY_MAX_AGE_MS;
  result=await overlayRecentRobloxOccupancy(env,makeListing());
  assert.equal(result.enrichedCount,0,'Counts expire after 5 minutes');

  const scan=async(_env,mode,cacheKey)=>{
    scans++;
    assert.equal(cacheKey,mode+':'+(_env===env?'124087144919678':'unexpected')+':1');
    return {mode,at:clock};
  };
  let probe=await maybeProbeRobloxOccupancy(env,'8v8','124087144919678',scan);
  assert.equal(probe.status,'updated');
  assert.equal(scans,1);
  probe=await maybeProbeRobloxOccupancy(env,'8v8','124087144919678',scan);
  assert.equal(probe.status,'cooldown');
  assert.equal(scans,1);
  clock+=MIN_ROBLOX_PROBE_INTERVAL_MS-1000;
  probe=await maybeProbeRobloxOccupancy(env,'pro','99999183305180',scan);
  assert.equal(probe.status,'cooldown','Global 20-minute interval applies across 8v8 and Pro');
  assert.equal(scans,1);
  clock+=2000;
  const limited=async()=>{scans++;const e=new Error('Roblox 429');e.code='roblox_rate_limited';e.retryAfterMs=60_000;throw e;};
  probe=await maybeProbeRobloxOccupancy(env,'pro','99999183305180',limited);
  assert.equal(probe.status,'failed');
  assert.equal(probe.reason,'roblox_rate_limited');
  assert.equal(scans,2);
  probe=await maybeProbeRobloxOccupancy(env,'8v8','124087144919678',scan);
  assert.equal(probe.status,'cooldown');
  assert.equal(scans,2,'No retry during provider or global cooldown');

  env.ROBLOX_HYBRID_ENRICH_ENABLED='false';
  clock+=60*60_000;
  probe=await maybeProbeRobloxOccupancy(env,'8v8','124087144919678',scan);
  assert.equal(probe.status,'disabled');
  assert.equal(scans,2);
  console.log('PASS: exact Job-ID occupancy matches, freshness, global probe spacing, rate limits, and off-switch');
} finally {
  Date.now=before;
}
