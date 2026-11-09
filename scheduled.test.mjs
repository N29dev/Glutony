import assert from 'node:assert/strict';
import worker, { _test as helpers } from './worker.mjs';
import { _test as gateHelpers } from './match-scan-gate.mjs';

// Integration tests: two game modes share one D1 lock and global Roblox cooldown.
const place8='124087144919678', placePro='99999183305180';
const id8='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const idPro='11111111-2222-3333-4444-555555555555';
const snapshots=new Map();
let gate=null, requests=0, limited=false;
const realNow=Date.now, realFetch=globalThis.fetch;
let clock=realNow();
Date.now=()=>clock;
const advance=ms=>{clock+=ms;};
const affected=n=>({meta:{changes:n}});

const db={
  prepare(sql) {
    return {bind(...args) {
      return {
        async first() {
          if(sql.includes('SELECT snapshot FROM server_snapshots')) {
            const snap=snapshots.get(args[0]);
            return snap?{snapshot:JSON.stringify(snap)}:null;
          }
          if(sql.includes('FROM server_scan_gate'))return gate?{...gate}:null;
          throw Error('Unknown D1 SELECT: '+sql);
        },
        async run() {
          if(sql.startsWith('INSERT OR IGNORE INTO server_scan_gate')) {
            if(!gate)gate={gate_key:args[0],next_allowed_at:0,lease_until:0,
              lease_token:null,failures:0,last_error:null};
            return affected(1);
          }
          if(sql.startsWith('UPDATE server_scan_gate SET lease_token=?')) {
            const [token,lease,next,attempt,key,now,allowed]=args;
            if(!gate||gate.gate_key!==key||gate.lease_until>now||gate.next_allowed_at>allowed)return affected(0);
            Object.assign(gate,{lease_token:token,lease_until:lease,next_allowed_at:next,last_attempt_at:attempt});
            return affected(1);
          }
          if(sql.startsWith('UPDATE server_scan_gate SET lease_token=NULL')) {
            const [next,...rest]=args,token=rest.at(-1);
            if(gate?.lease_token!==token)return affected(0);
            gate.lease_token=null;gate.lease_until=0;gate.next_allowed_at=next;
            if(sql.includes('failures=0')) {
              gate.failures=0;gate.last_error=null;gate.last_success_at=rest[0];
            }else {
              gate.failures=rest[0];gate.last_error=rest[1];
            }
            return affected(1);
          }
          if(sql.startsWith('INSERT INTO server_snapshots')) {
            snapshots.set(args[0],JSON.parse(args[1]));
            return affected(1);
          }
          throw Error('Unknown D1 write: '+sql);
        },
        async all() {return {results:[]};},
      };
    }};
  },
};
const env={CUSTOMS_DB:db,ROVALRA_REGIONS_ENABLED:'false',ROBLOX_MAX_PAGES:'3'};
globalThis.fetch=async url=>{
  const target=String(url);
  if(!target.includes('games.roblox.com'))throw Error('Unmocked request: '+target);
  requests++;
  if(limited)return new Response('Too many requests',{status:429,headers:{'retry-after':'60'}});
  const pro=target.includes(placePro);
  return Response.json({data:[{id:pro?idPro:id8,playing:pro?7:12,
    maxPlayers:pro?10:16,ping:75,playerTokens:[]}],nextPageCursor:null});
};
const api=mode=>worker.fetch(new Request('https://glutony.example/api/servers?mode='+mode),env,{});

try {
  assert.equal(typeof worker.scheduled,'undefined','No scheduled polling after rollout');
  assert.equal(gateHelpers.retryDelay(1,60_000),180_000);
  assert.equal(gateHelpers.retryDelay(2,60_000),360_000);

  let response=await api('8v8');
  assert.equal(response.status,200,'Opening website initiates first 8v8 scan');
  assert.equal((await response.json()).servers[0].id,id8);
  assert.equal(requests,1);
  response=await api('8v8');
  assert.equal(response.status,200,'Another website visitor reuses D1');
  assert.equal(requests,1,'No repeat scan while cache fresh');

  response=await api('pro');
  assert.equal(response.status,503,'Global gate spaces out first requests for separate modes');
  assert.equal((await response.json()).code,'server_snapshot_unavailable');
  assert.equal(requests,1);
  advance(16_000);
  response=await api('pro');
  assert.equal(response.status,200);
  assert.equal((await response.json()).servers[0].id,idPro);
  assert.equal(requests,2);

  advance(3*60_000);
  limited=true;
  response=await api('8v8');
  assert.equal(response.status,200,'Fresh-enough sample survives temporary 429');
  assert.equal((await response.json()).stale,true);
  assert.equal(requests,3);
  assert.equal(gate.failures,1);
  assert.equal(gate.last_error,'roblox_rate_limited');

  advance(2*60_000);
  response=await api('8v8');
  assert.equal(response.status,503,'Never advertise matches older than five minutes');
  const cooldown=await response.json();
  assert.equal(cooldown.code,'server_sample_expired');
  assert.equal(cooldown.reason,'roblox_rate_limited');
  assert.ok(cooldown.retryAfterSeconds>=59);
  assert.equal(requests,3,'Repeated visits during cooldown never hit Roblox');

  advance(2*60_000);
  response=await api('8v8');
  assert.equal(response.status,503);
  assert.equal(requests,4,'One retry after initial three-minute backoff');
  assert.equal(gate.failures,2);
  assert.ok(gate.next_allowed_at-clock>=6*60_000,'Exponential shared backoff after another 429');

  response=await api('pro');
  assert.equal(response.status,503,'Pro respects 8v8 Roblox rate limit too');
  assert.equal(requests,4);

  limited=false;
  advance(7*60_000);
  response=await api('8v8');
  assert.equal(response.status,200,'On-demand scanner recovers after rate limit');
  assert.equal(requests,5);
  assert.equal(gate.failures,0,'Success clears shared backoff');
  assert.ok(snapshots.has('8v8:'+place8+':1'));
  assert.ok(snapshots.has('pro:'+placePro+':1'));
  assert.ok(!snapshots.has('8v8:'+place8+':3'),'Only one Roblox page is requested');

  // A failed D1 lock cannot cause an uncontrolled Roblox request.
  const healthy=env.CUSTOMS_DB;
  env.CUSTOMS_DB={prepare(){throw Error('database unavailable');}};
  advance(3*60_000);
  const before=requests;
  response=await api('8v8');
  assert.equal(response.status,503);
  assert.equal(requests,before);
  env.CUSTOMS_DB=healthy;
  console.log('PASS: on-demand match scans, shared D1 lock, Roblox 429 backoff, expiry and recovery');
} finally {
  Date.now=realNow;
  globalThis.fetch=realFetch;
  helpers.memoryCaches.clear();
}
