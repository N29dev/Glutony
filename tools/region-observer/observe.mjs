/**
 * Human-initiated Roblox region diagnostic.
 * Opens an isolated Chrome profile and passively watches one GameJoin response.
 * It NEVER extracts, stores, prints, or uploads cookies, tokens or join scripts.
 * No automatic joins, background polling, Worker calls, or credential forwarding.
 */
import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PROFILE = join(homedir(), '.glutony-alt-region-profile');
const GAMEJOIN_URL = 'https://gamejoin.roblox.com/v2/join-game-instance';
const DATACENTERS_URL = 'https://apis.rovalra.com/v1/datacenters/list';
const DEFAULT_PAGE = 'https://www.roblox.com/games/99999183305180';
const SERVER_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

function parseArgs(args) {
  let expected = null;
  let profile = DEFAULT_PROFILE;
  for (let i=0;i<args.length;i++) {
    const arg = args[i];
    if (arg==='--server') {
      expected=args[++i];
      if (!expected || !SERVER_ID.test(expected)) throw Error('Use --server followed by a valid public Roblox server UUID.');
    } else if(arg==='--profile') {
      profile=args[++i];
      if (!profile)throw Error('--profile needs a dedicated browser profile path.');
    } else if(arg==='--help'||arg==='-h'){
      return {help:true};
    } else throw Error('Unknown option: '+arg);
  }
  return {expected,profile,help:false};
}
function normalizeDatacenter(value){
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return String(value);
  if(typeof value==='string'&&/^\d{1,20}$/.test(value.trim()))return value.trim();
  return null;
}
function pickRegion(items, id) {
  if(!Array.isArray(items)||!id)return null;
  let match=null, ambiguous=false;
  for(const item of items.slice(0,3000)){
    if(!Array.isArray(item?.dataCenterIds) || !item.dataCenterIds.some(x=>normalizeDatacenter(x)===id))continue;
    const location=item.location;
    if(!location || typeof location.country!=='string' || !location.country.trim())continue;
    const found={
      city:typeof location.city==='string'?location.city.trim():'',
      region:typeof location.region==='string'?location.region.trim():'',
      country:location.country.trim(),
    };
    if(match && JSON.stringify(match)!==JSON.stringify(found)) ambiguous=true;
    if(!match)match=found;
  }
  return ambiguous?null:match;
}
async function loadRoValraMap() {
  try{
    const response=await fetch(DATACENTERS_URL,{
      headers:{accept:'application/json'},signal:AbortSignal.timeout(5500)
    });
    if(!response.ok)return null;
    const json=await response.json();
    return Array.isArray(json)?json:null;
  }catch{return null;}
}
function safeText(value) {
  if(typeof value!=='string')return '';
  return value.replace(/[\r\n\u0000-\u001f]/g,' ').slice(0,80).trim();
}
async function main(){
  const {expected,profile,help}=parseArgs(process.argv.slice(2));
  if(help){
    console.log('Usage: npm start [-- --server SERVER_UUID] [--profile DEDICATED_DIRECTORY]');
    console.log('Login manually in the isolated browser and click Join on ONE public server. Ctrl+C exits.');
    return;
  }
  console.log('Starting a separate Chrome profile for a ONE-SERVER, HUMAN-INITIATED diagnostic.');
  console.log('This tool never requests your Roblox password or reads browser cookies.');
  console.log('Login to your spare Roblox account manually, then click Join on a public server.');
  console.log('Session data stays in Chrome profile:',profile);
  const context=await chromium.launchPersistentContext(profile,{
    channel:'chrome',headless:false,viewport:{width:1280,height:850}
  });
  let completed=false,processing=false;
  const seen=new Set();
  const stop=async()=>{try{await context.close()}catch{}};
  for(const page of context.pages())observe(page);
  context.on('page',observe);
  const first=context.pages()[0]??await context.newPage();
  if(first.url()==='about:blank')await first.goto(DEFAULT_PAGE,{waitUntil:'domcontentloaded'}).catch(()=>{});
  context.on('close',()=>process.exit(0));
  function observe(page){
    page.on('response',async response=>{
      if(completed||processing||!response.url().startsWith(GAMEJOIN_URL))return;
      // Page's own real join action, never a synthetic request from the script.
      const req=response.request();
      if(req.method()!=='POST')return;
      let body=null;
      try{body=req.postDataJSON()}catch{}
      if(expected && String(body?.gameId||'').toLowerCase()!==expected.toLowerCase())return;
      if(!response.ok()){
        console.log('Roblox GameJoin returned HTTP '+response.status()+'. This does not prove a region.');
        return;
      }
      processing=true;
      try{
        const data=await response.json().catch(()=>null);
        const dcId=normalizeDatacenter(data?.joinScript?.DataCenterId);
        const id=safeText(body?.gameId || data?.joinScript?.GameId);
        if(!dcId){
          console.log('A Roblox join response was seen'+(id?' for server '+id:'')+', but no DataCenterId was supplied.');
          processing=false;
          return;
        }
        if(seen.has(dcId)){processing=false;return;}
        seen.add(dcId);
        const map=await loadRoValraMap();
        const region=pickRegion(map,dcId);
        console.log('Verified Roblox join metadata'+(id?' for server '+id:'')+'.');
        if(region){
          const place=[region.city,region.region,region.country].filter(Boolean).join(', ');
          console.log('RoValra datacenter map location:',safeText(place));
        }else{
          console.log('A datacenter ID was present, but the public RoValra map did not resolve it.');
        }
        console.log('No cookies, join scripts, or region reports were uploaded. Closing diagnostic browser.');
        completed=true;
        await stop();
      }catch{
        console.log('Join response could not be parsed; no result saved.');
      }finally{processing=false;}
    });
  }
}
main().catch(error=>{
  console.error('Region observer could not start:',error?.message||'Unknown error');
  process.exitCode=1;
});
