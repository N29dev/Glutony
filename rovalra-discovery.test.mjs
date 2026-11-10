import assert from 'node:assert/strict';
import {getRoValraDiscovery,_test} from './rovalra-discovery.mjs';
import worker from './worker.mjs';

const originalFetch=globalThis.fetch, originalNow=Date.now;
let now=Date.UTC(2026,10,9,17,30), calls=[];
Date.now=()=>now;
const snapshots=new Map();
let gate=null;
let fail=false;
const rowKey=(mode,code)=>mode+':'+code;
const successes=n=>({meta:{changes:n}});
const db={
  prepare(sql){
    return {
      bind(...params){return make(sql,params);},
      ...make(sql,[])
    };
  }
};
function make(sql,params){
  return {
    async first(){
      if(sql.includes('FROM rovalra_discovery_gate'))return gate?{...gate}:null;
      throw Error('Unmocked SELECT: '+sql);
    },
    async all(){
      if(sql.includes('FROM rovalra_discovery_regions')){
        const [mode,oldest]=params;
        return {results:[...snapshots.values()].filter(s=>s.mode===mode&&s.observed_at>=oldest)
          .sort((a,b)=>b.observed_at-a.observed_at)};
      }
      // Existing website's optional community reports.
      if(sql.includes('server_region_reports'))return {results:[]};
      throw Error('Unmocked D1 all: '+sql);
    },
    async run(){
      if(sql.startsWith('INSERT OR IGNORE INTO rovalra_discovery_gate')){
        if(!gate)gate={key:'global',cursor:0,failures:0,next_allowed_at:0,lease_until:0,lease_token:null};
        return successes(1);
      }
      if(sql.startsWith('UPDATE rovalra_discovery_gate SET lease_token=?')){
        const [token,until,next,point,allowed]=params;
        if(!gate||gate.lease_until>point||gate.next_allowed_at>allowed)return successes(0);
        Object.assign(gate,{lease_token:token,lease_until:until,next_allowed_at:next});
        return successes(1);
      }
      if(sql.startsWith('UPDATE rovalra_discovery_gate SET lease_token=NULL')){
        const [cursor,failures,next,token]=params;
        if(gate?.lease_token!==token)return successes(0);
        Object.assign(gate,{cursor,failures,next_allowed_at:next,lease_until:0,lease_token:null});
        return successes(1);
      }
      if(sql.startsWith('INSERT INTO rovalra_discovery_regions')){
        const [mode,code,observed_at,data_json]=params;
        snapshots.set(rowKey(mode,code),{mode,country_code:code,observed_at,data_json});
        return successes(1);
      }
      throw Error('Unmocked D1 write: '+sql);
    }
  };
}
const ids={};
const countryNames={US:'United States',DE:'Germany',SG:'Singapore',BR:'Brazil',GB:'United Kingdom',JP:'Japan',AU:'Australia'};
globalThis.fetch=async url=>{
  const parsed=new URL(String(url));
  assert.equal(parsed.hostname,'apis.rovalra.com','Must not call Roblox');
  assert.equal(parsed.pathname,'/v1/servers/region');
  const code=parsed.searchParams.get('region');
  const place=parsed.searchParams.get('place_id');
  assert.ok(_test.COUNTRIES.includes(code));
  assert.ok(['124087144919678','99999183305180'].includes(place));
  calls.push({code,place});
  if(fail)return new Response('Too many requests',{status:429,headers:{'retry-after':'600'}});
  const index=_test.COUNTRIES.indexOf(code)+1;
  const pro=place==='99999183305180';
  const id='00000000-0000-4000-8000-'+String(index+(pro?500:0)).padStart(12,'0');
  ids[rowKey(pro?'pro':'8v8',code)]=id;
  return Response.json({status:'success',disabled:false,servers:[
    {server_id:id,city:'City '+code,country:countryNames[code]||code,region_code:code,
      place_version:229,first_seen:'2026-11-09T12:00:00Z',
      ip_address:'192.0.2.1',datacenter_id:1234}
  ],next_cursor:null});
};

const env={CUSTOMS_DB:db,ROVALRA_MATCH_DISCOVERY_ENABLED:'true',ROVALRA_REGIONS_ENABLED:'false'};
try {
  let result=await getRoValraDiscovery(env,'8v8');
  assert.equal(result.source,'rovalra');
  assert.equal(result.servers.length,3);
  assert.equal(result.regionCoverage,3);
  assert.equal(calls.length,6,'Shared scan queries three countries for both modes');
  assert.equal(result.servers[0].playing,null);
  assert.equal(result.servers[0].free,null);
  assert.equal(result.servers[0].ping,null);
  assert.ok(!JSON.stringify(result).includes('192.0.2.1'));
  assert.ok(!JSON.stringify(result).includes('datacenter_id'));
  const before=calls.length;
  result=await getRoValraDiscovery(env,'pro');
  assert.equal(result.servers.length,3,'Pro reuses shared scan');
  assert.equal(calls.length,before);
  result=await getRoValraDiscovery(env,'8v8');
  assert.equal(calls.length,before,'No extra calls for multiple visitors');

  const website=await worker.fetch(new Request('https://glutony.test/api/servers?mode=8v8'),env,{});
  assert.equal(website.status,200);
  const payload=await website.json();
  assert.equal(payload.source,'rovalra');
  assert.equal(payload.countsVerified,false);
  assert.equal(payload.servers.length,3);
  assert.equal(payload.servers[0].playing,null);
  assert.equal(payload.servers[0].maxPlayers,null);
  assert.equal(payload.servers[0].free,null);
  assert.equal(payload.servers[0].countryCode,'DE');
  assert.ok(payload.servers[0].joinPc.includes('/join?'));

  now+=29_000;
  result=await getRoValraDiscovery(env,'8v8');
  assert.equal(calls.length,before,'Page visits within the shared 30-second gate do not rescan');
  now+=2_000;
  result=await getRoValraDiscovery(env,'8v8');
  assert.equal(calls.length,12,'A new visitor after 30 seconds triggers the next regional batch');
  assert.equal(result.regionCoverage,6);
  const example=JSON.stringify(result);
  assert.ok(example.includes('United States')&&example.includes('Brazil'));

  now+=61_000;
  fail=true;
  result=await getRoValraDiscovery(env,'8v8');
  assert.equal(calls.length,13,'Stop immediately on provider rate limit');
  const failureCalls=calls.length;
  now+=3*60_000;
  result=await getRoValraDiscovery(env,'8v8');
  assert.equal(calls.length,failureCalls,'Shared backoff avoids further requests');
  assert.ok(result.servers.length>=3,'Prior observations remain viewable with unknown availability');
  assert.equal(gate.failures,1);
  now+=25*60_000;
  await assert.rejects(()=>getRoValraDiscovery(env,'8v8'),/initial snapshot/);
  assert.equal(calls.length,failureCalls+1,'Retry only after backoff once old observations expire');
  console.log('PASS: RoValra regional discovery, multiple modes, no fabricated occupancy, cache, 429 backoff and expiry');
} finally {Date.now=originalNow;globalThis.fetch=originalFetch;}
