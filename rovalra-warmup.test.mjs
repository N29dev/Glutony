import assert from 'node:assert/strict';
import {getRoValraDiscovery} from './rovalra-discovery.mjs';

// A visitor opens Glutony after 2+ hours of inactivity. Existing D1 snapshots
// remember positive countries, but all are too old to list as active servers.
// Cold-start discovery must immediately target productive countries, not resume
// an arbitrary zero-server country from the round-robin cursor.
const originalFetch=globalThis.fetch, originalNow=Date.now;
let now=Date.UTC(2026,10,9,21,35);
Date.now=()=>now;
const historical=now-2*60*60_000;
const regions=new Map();
for(const [country,n] of [['US',3],['FR',2],['BR',2],['GB',1]]){
 for(const mode of ['8v8','pro']){
  const fake=Array.from({length:n},(_,i)=>({id:'aaaaaaaa-bbbb-cccc-dddd-'+
    String((country.charCodeAt(0)*200)+i+(mode==='pro'?100000:0)).padStart(12,'0')}));
  regions.set(mode+':'+country,{mode,country_code:country,observed_at:historical,
    data_json:JSON.stringify({servers:fake,partial:false})});
 }
}
let gate={key:'global',cursor:15,failures:0,next_allowed_at:0,lease_until:0,lease_token:null};
const reads=[];
const changed=n=>({meta:{changes:n}});
const db={prepare(sql){
 return {
  async first(){
    if(sql.includes('FROM rovalra_discovery_gate'))return gate?{...gate}:null;
    throw Error('Unexpected unbound read '+sql);
  },
  async run(){
    if(sql.startsWith('INSERT OR IGNORE INTO rovalra_discovery_gate'))return changed(0);
    throw Error('Unexpected unbound write '+sql);
  },
  bind(...params){return {
  async first(){
   if(sql.includes('FROM rovalra_discovery_gate'))return gate?{...gate}:null;
   throw Error('Unexpected first '+sql);
  },
  async all(){
   if(sql.includes('SELECT mode,country_code,observed_at,data_json FROM rovalra_discovery_regions')){
    const [oldest]=params;
    return {results:[...regions.values()].filter(x=>x.observed_at>=oldest)};
   }
   if(sql.includes('FROM rovalra_discovery_regions')){
    const [mode,oldest]=params;
    return{results:[...regions.values()].filter(x=>x.mode===mode&&x.observed_at>=oldest)};
   }
   throw Error('Unexpected all '+sql);
  },
  async run(){
   if(sql.startsWith('INSERT OR IGNORE INTO rovalra_discovery_gate'))return changed(0);
   if(sql.startsWith('UPDATE rovalra_discovery_gate SET lease_token=?')){
    const [token,until,next,point,allowed]=params;
    if(gate.lease_until>point||gate.next_allowed_at>allowed)return changed(0);
    Object.assign(gate,{lease_token:token,lease_until:until,next_allowed_at:next});
    return changed(1);
   }
   if(sql.startsWith('UPDATE rovalra_discovery_gate SET lease_token=NULL')){
    const [cursor,failures,next,token]=params;
    if(gate.lease_token!==token)return changed(0);
    Object.assign(gate,{lease_token:null,lease_until:0,cursor,failures,next_allowed_at:next});
    return changed(1);
   }
   if(sql.startsWith('INSERT INTO rovalra_discovery_regions')){
    const [mode,country_code,observed_at,data_json]=params;
    regions.set(mode+':'+country_code,{mode,country_code,observed_at,data_json});
    return changed(1);
   }
   throw Error('Unexpected write '+sql);
  }
 };}};
}};
globalThis.fetch=async url=>{
 const q=new URL(url), country=q.searchParams.get('region');
 assert.equal(q.hostname,'apis.rovalra.com');
 reads.push(country);
 const idx=reads.length, id='ffffffff-aaaa-bbbb-cccc-'+String(idx).padStart(12,'0');
 return Response.json({status:'success',disabled:false,servers:[
  {server_id:id,city:'City',country,region_code:country,place_version:1}
 ],next_cursor:null});
};
try{
 const sample=await getRoValraDiscovery({CUSTOMS_DB:db},'8v8');
 const scanned=reads.filter((_,i)=>i%2===0);
 assert.deepEqual(scanned,['US','FR','BR'],
   'Initial cold-start scan must prefer historical server regions over cursor=15 (HK/ID/ZA)');
 assert.equal(reads.length,6,'Never increases provider request count');
 assert.equal(sample.regionCoverage,3);
 assert.equal(sample.servers.length,3);
 assert.ok(sample.servers.every(s=>s.playing===null));
 assert.ok(!sample.servers.some(s=>s.id.startsWith('aaaaaaaa')),
   'Historical Job IDs must not be presented as active server records');

 // Once useful data exists, proceed with ordinary rotating coverage.
 now+=121_000;
 reads.length=0;
 await getRoValraDiscovery({CUSTOMS_DB:db},'8v8');
 const nextCountries=reads.filter((_,i)=>i%2===0);
 assert.deepEqual(nextCountries,['HK','ID','ZA']);
 console.log('PASS: 2-hour cold start prioritizes previously productive regions, never stale IDs, and preserves request budget');
}finally{
 Date.now=originalNow;
 globalThis.fetch=originalFetch;
}
