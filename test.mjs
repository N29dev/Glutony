import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, { _test as helpers } from './worker.mjs';
import { DOWNLOAD_COMMAND, cleanTikTokURL } from './download.mjs';

const place8 = '124087144919678';
const placePro = '99999183305180';
const placeMain = '18668065416';
const server8 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const serverPro = '11111111-2222-3333-4444-555555555555';
const keys = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const env = {
  DISCORD_PUBLIC_KEY: Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'),
  DISCORD_APPLICATION_ID: '123456789012345678',
  DISCORD_BOT_TOKEN: 'fake-token-for-offline-test',
  SETUP_KEY: 'local-test-secret-do-not-deploy',
  ROBLOX_MAX_PAGES: '1',
};
env.TIKTOK_SERVICE_URL = 'https://media.example';
env.TIKTOK_SERVICE_TOKEN = 'test-video-secret';
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  const method = options.method || 'GET';
  calls.push({address, method, body: options.body});
  if (address.includes('games.roblox.com')) {
    if(address.includes(placeMain)) {
      // Main is intentionally sampled: return 30 joinable entries in the first
      // (and only) Roblox API page so the Worker must cap the public list at 24.
      const data=Array.from({length:30},(_,i)=>({
        id:'70000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
        playing:4,maxPlayers:10,ping:65,playerTokens:[]
      }));
      return Response.json({data,nextPageCursor:'more-results-not-fetched'});
    }
    const pro = address.includes(placePro);
    return Response.json({data: [{
      id: pro ? serverPro : server8,
      playing: pro ? 7 : 12,
      maxPlayers: pro ? 10 : 16,
      ping: pro ? 90 : 70,
      playerTokens: ['preview1'],
    }], nextPageCursor: null});
  }
  if (address.includes('apis.rovalra.com')) {
    const pro = address.includes(placePro);
    return Response.json({status: 'success', servers: [{
      server_id: pro ? serverPro : server8,
      city: pro ? 'Paris' : 'Atlanta',
      region: pro ? '' : 'Georgia',
      country: pro ? 'France' : 'United States',
      place_version: pro ? 333 : 224,
      first_seen: '2026-10-25T00:00:00Z',
    }]});
  }
  if (address.includes('thumbnails.roblox.com')) {
    return Response.json({data: [{imageUrl:'https://tr.rbxcdn.com/example/150/150/AvatarHeadshot/Png'}]});
  }
  if (address.includes('/webhooks/')) return Response.json({id:'message'});
  if (address === 'https://media.example/jobs') {
    assert.equal(options.headers.authorization, 'Bearer test-video-secret');
    return Response.json({queued:true}, {status:202});
  }
  if (address.includes('/applications/') && address.includes('/commands')) {
    return Response.json({name:JSON.parse(options.body).name,id:'123456789012345678'});
  }
  throw new Error('Unmocked request: '+address);
};
async function invoke(interaction) {
  const body = JSON.stringify(interaction);
  const timestamp = String(Math.floor(Date.now()/1000));
  const signature = Buffer.from(await webcrypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp+body))).toString('hex');
  const promises = [];
  const request = new Request('https://glutony.example/interactions', {
    method:'POST',
    headers:{'x-signature-ed25519':signature,'x-signature-timestamp':timestamp},
    body,
  });
  const response = await worker.fetch(request, env, {waitUntil:p=>promises.push(p)});
  await Promise.all(promises);
  return response.json();
}
const lastEdit = () => {
  const request = calls.filter(x=>x.method==='PATCH').at(-1);
  assert.ok(request, 'Expected Discord PATCH');
  return JSON.parse(request.body);
};
const contains = (payload, word) => JSON.stringify(payload).includes(word);

assert.deepEqual(await invoke({type:1}), {type:1}, 'Discord PING');
assert.equal(DOWNLOAD_COMMAND.name, 'download');
const about = await invoke({type:2,id:'1563900000000000100', application_id:env.DISCORD_APPLICATION_ID,
  token:'about-glutony', data:{name:'info'}});
assert.equal(about.type,4,'/info responds immediately');
assert.equal(about.data.flags,32768,'/info uses Components V2 and is public');
assert.deepEqual(about.data.allowed_mentions,{parse:[]},'Creator mention must not ping');
assert.ok(contains(about.data,'1479778096834941099'));
assert.ok(contains(about.data,'https://discord.com/users/1479778096834941099'));
assert.ok(contains(about.data,'https://blr.n29.kz/servers/'));
assert.ok(contains(about.data,'https://github.com/N29dev/Glutony'));
assert.ok(contains(about.data,'/stats'));
assert.ok(cleanTikTokURL('https://www.tiktok.com/@0nlyhunger/video/7701407832926637333'));
assert.ok(cleanTikTokURL('https://vt.tiktok.com/Abc123/'));
assert.equal(cleanTikTokURL('https://tiktok.com.evil.test/@x/video/123'), null);
assert.equal(cleanTikTokURL('http://www.tiktok.com/@x/video/123'), null);
assert.equal(cleanTikTokURL('https://www.tiktok.com/@x'), null);
assert.equal(cleanTikTokURL('https://www.tiktok.com/@x/photo/123'), null);
assert.equal(cleanTikTokURL('https://www.tiktok.com@127.0.0.1/@x/video/123'), null);
let videoResp = await invoke({type:2,application_id:env.DISCORD_APPLICATION_ID,token:'download-token',
  data:{name:'download',options:[{name:'url',value:'https://www.tiktok.com/@0nlyhunger/video/7701407832926637333?share=1'}]}});
assert.equal(videoResp.type,5, 'TikTok should publicly defer its reply');
const jobCall = calls.find(c=>c.address==='https://media.example/jobs');
assert.ok(jobCall, 'TikTok job sent to separate processor');
assert.equal(JSON.parse(jobCall.body).interaction_token,'download-token');
assert.equal(JSON.parse(jobCall.body).url,'https://www.tiktok.com/@0nlyhunger/video/7701407832926637333');
assert.ok(contains(lastEdit(),'Downloading'));
videoResp = await invoke({type:2,application_id:env.DISCORD_APPLICATION_ID,token:'bad-video',
  data:{name:'download',options:[{name:'url',value:'https://example.com/video'}]}});
assert.equal(videoResp.type,4);
assert.equal(videoResp.data.flags,64);
delete env.TIKTOK_SERVICE_URL;
videoResp = await invoke({type:2,application_id:env.DISCORD_APPLICATION_ID,token:'missing-service',
  data:{name:'download',options:[{name:'url',value:'https://vt.tiktok.com/Abc123/'}]}});
assert.equal(videoResp.type,4, 'Unconfigured service should fail privately');
env.TIKTOK_SERVICE_URL = 'https://media.example';
const invalid = await worker.fetch(new Request('https://glutony.example/interactions', {method:'POST',body:'{}'}),env,{});
assert.equal(invalid.status,401,'Unsigned request must fail');
assert.equal(helpers.config(env, '8v8').placeId,place8);
assert.equal(helpers.config(env, 'pro').placeId,placePro);
assert.equal(helpers.config(env, 'main').placeId,placeMain);
assert.equal(helpers.config(env, 'main').pages,1,'Main always uses one Roblox API page');
let statsReply = await invoke({type:2, id:'1563900000000000001', application_id:env.DISCORD_APPLICATION_ID,
  token:'bot-stats', user:{id:'1563900000000000002'},data:{name:'stats'}});
assert.equal(statsReply.type,5);
assert.equal(statsReply.data.flags,64,'Stats response should be ephemeral');
assert.ok(contains(lastEdit(),'database is not configured'));
statsReply = await invoke({type:2, id:'1563900000000000003', application_id:env.DISCORD_APPLICATION_ID,
  token:'pro-stats', data:{name:'stats',options:[{name:'view',value:'pro'}]}});
assert.equal(statsReply.type,5);
assert.ok(contains(lastEdit(),'Players in sample'));
assert.ok(contains(lastEdit(),'7'));
assert.ok(contains(lastEdit(),'not a global player count'));
const spread=helpers.sampleSpread(Array.from({length:300},(_,i)=>i),60);
assert.equal(spread.length,60,'60 globe/list candidates sampled across scanned pages');
assert.ok(spread[0]<5&&spread.at(-1)>290,'Spread includes first and last page');
assert.equal(new Set(spread).size,60,'No duplicate sample indices');
assert.deepEqual(helpers.sampleSpread([1,2,3],24),[1,2,3],'Short lists are unchanged');
assert.equal(helpers.flagEmoji('BR'),'🇧🇷');
assert.equal(helpers.normalizedServer({id:server8,playing:16,maxPlayers:16}),null,'Exclude full servers');

let response = await invoke({type:2, application_id:env.DISCORD_APPLICATION_ID, token:'8v8', data:{name:'blr',options:[{name:'mode',value:'8v8'}]}});
assert.equal(response.type,5,'Must acknowledge quickly');
assert.equal(response.data,undefined,'Public deferred response must not set the ephemeral flag');
let edited = lastEdit();
assert.equal(edited.flags,32768,'Components V2');
assert.ok(contains(edited,'12/16'));
assert.ok(contains(edited,'Atlanta'));
assert.equal(edited.components[1].components[0].custom_id,'g:s:8v8:0:players');
assert.ok(calls.some(x=>x.address.includes('/v1/games/'+place8+'/')));

response = await invoke({type:2,application_id:env.DISCORD_APPLICATION_ID,token:'pro',data:{name:'blr',options:[{name:'mode',value:'pro'}]}});
assert.equal(response.type,5);
edited = lastEdit();
assert.ok(contains(edited,'BL:R Pro Servers'));
assert.ok(contains(edited,'7/10'));
assert.ok(contains(edited,'Paris'));
assert.ok(calls.some(x=>x.address.includes('/v1/games/'+placePro+'/')));
assert.equal(edited.components[1].components[0].custom_id,'g:s:pro:0:players');

response = await invoke({type:2,application_id:env.DISCORD_APPLICATION_ID,token:'main',data:{name:'blr',options:[{name:'mode',value:'main'}]}});
assert.equal(response.type,5);
edited=lastEdit();
assert.ok(contains(edited,'BL:R Main Lobby'));
assert.ok(contains(edited,'24 joinable servers'));
assert.equal(edited.components[1].components[0].custom_id,'g:s:main:0:players');
assert.ok(calls.some(x=>x.address.includes('/v1/games/'+placeMain+'/')));
response = await invoke({type:3,application_id:env.DISCORD_APPLICATION_ID,token:'pro-selected',data:{custom_id:'g:s:pro:0:players',values:[serverPro]}});
assert.equal(response.type,6);
edited = lastEdit();
assert.ok(contains(edited,'v333'));
assert.ok(contains(edited,serverPro));
assert.ok(contains(edited,'Join Mobile'));
assert.ok(contains(edited,placePro));
assert.ok(contains(edited,'🇫🇷'));

// Discord buttons must link through our HTTPS landing page, not Roblox's broken website matchmaking route.
const proJoin = helpers.joinLinks(placePro, serverPro, 'https://glutony.example');
assert.equal(new URL(proJoin.pc).pathname,'/join');
assert.equal(new URL(proJoin.pc).searchParams.get('gameInstanceId'),serverPro);
assert.equal(new URL(proJoin.mobile).searchParams.get('device'),'mobile');
assert.ok(proJoin.direct.startsWith('roblox://experiences/start?'));
assert.equal(new URL(proJoin.fallbackMobile).searchParams.get('deep_link_value'),proJoin.direct);
const joinPage = await worker.fetch(new Request(proJoin.pc),env,{});
assert.equal(joinPage.status,200);
assert.match(joinPage.headers.get('content-type'),/text\/html/);
const joinHtml = await joinPage.text();
assert.ok(joinHtml.includes(serverPro));
assert.ok(joinHtml.includes(proJoin.direct.replaceAll('&','&')),'Landing page includes direct app protocol');
assert.ok(!joinHtml.includes('Join randomly'));
const invalidJoin = await worker.fetch(new Request('https://glutony.example/join?placeId='+placePro+'&gameInstanceId=invalid'),env,{});
assert.equal(invalidJoin.status,400);

response = await invoke({type:3,application_id:env.DISCORD_APPLICATION_ID,token:'pro-back',data:{custom_id:'g:b:pro:0:players'}});
assert.equal(response.type,6);
assert.ok(contains(lastEdit(),'BL:R Pro Servers'));

response = await invoke({type:2,application_id:env.DISCORD_APPLICATION_ID,token:'customs',data:{name:'blr',options:[{name:'mode',value:'customs'}]}});
assert.equal(response.type,5, 'Customs currently uses a deferred public reply');
assert.equal((await worker.fetch(new Request('https://glutony.example/admin/register',{method:'POST'}),env,{})).status,403);
const registeredResponse = await (await worker.fetch(new Request('https://glutony.example/admin/register',{method:'POST',headers:{authorization:'Bearer '+env.SETUP_KEY}}),env,{})).json();
assert.equal(registeredResponse.registered,'blr');
assert.deepEqual(registeredResponse.commands.map(c=>c.name),['blr','download','stats','info']);

// Browser-facing JSON API (used by blr.n29.kz/servers).
const publicPro = await worker.fetch(new Request('https://glutony.example/api/servers?mode=pro',{headers:{origin:'https://blr.n29.kz'}}),env,{});
assert.equal(publicPro.status,200);
assert.equal(publicPro.headers.get('access-control-allow-origin'),'https://blr.n29.kz');
const proList=await publicPro.json();
assert.equal(proList.placeId,placePro);
assert.equal(proList.servers.length,1);
assert.equal(proList.servers[0].id,serverPro);
assert.equal(proList.servers[0].free,3);
assert.equal(proList.servers[0].version,333);
assert.ok(new URL(proList.servers[0].joinPc).pathname==='/join');
assert.equal(new URL(proList.servers[0].joinMobile).searchParams.get('device'),'mobile');
assert.ok(!JSON.stringify(proList).includes('preview1'),'Browser data must not disclose raw player tokens');
const mainCallsBefore=calls.filter(x=>x.address.includes('/v1/games/'+placeMain+'/')).length;
const publicMain=await worker.fetch(new Request('https://glutony.example/api/servers?mode=main'),env,{});
const mainList=await publicMain.json();
assert.equal(mainList.placeId,placeMain);
assert.equal(mainList.servers.length,24,'Main website response caps at 24 servers');
assert.equal(mainList.hasMore,true,'Main displays the existence of additional servers');
assert.equal(calls.filter(x=>x.address.includes('/v1/games/'+placeMain+'/')).length-mainCallsBefore,0,
 'Main website response should reuse the recent cached single Roblox API page');
const public8=await worker.fetch(new Request('https://glutony.example/api/servers?mode=8v8'),env,{});
assert.equal((await public8.json()).placeId,place8);
const invalidMode=await worker.fetch(new Request('https://glutony.example/api/servers?mode=customs'),env,{});
assert.equal(invalidMode.status,400);
const avatars=await worker.fetch(new Request('https://glutony.example/api/servers/avatars?mode=pro&id='+serverPro),env,{});
assert.equal(avatars.status,200);
assert.ok(Array.isArray((await avatars.json()).images));
const options=await worker.fetch(new Request('https://glutony.example/api/servers',{method:'OPTIONS'}),env,{});
assert.equal(options.status,204);

// Targeted passive region refresh: only known live Job IDs, no player tokens.
const regionRefresh = await worker.fetch(
  new Request('https://glutony.example/api/servers/regions?mode=8v8&ids='+server8),env,{});
assert.equal(regionRefresh.status,200);
assert.equal(regionRefresh.headers.get('access-control-allow-origin'),'https://blr.n29.kz');
const regionsPayload = await regionRefresh.json();
assert.equal(regionsPayload.regions[server8].region,'Atlanta, Georgia, United States');
assert.equal(regionsPayload.regions[server8].version,224);
assert.ok(!JSON.stringify(regionsPayload).includes('preview1'));
assert.equal((await worker.fetch(new Request(
  'https://glutony.example/api/servers/regions?mode=8v8&ids=bogus'),env,{})).status,400);
const inactive = '99999999-8888-7777-6666-555555555555';
const inactiveResp = await worker.fetch(new Request(
  'https://glutony.example/api/servers/regions?mode=pro&ids='+inactive),env,{});
assert.deepEqual((await inactiveResp.json()).regions,{});
assert.equal((await worker.fetch(new Request(
  'https://glutony.example/api/servers/regions?mode=pro&ids='+Array(9).fill(serverPro).join(',')),env,{})).status,400);

console.log('PASS: passive region refresh validates server IDs, CORS, and known server metadata');

console.log('PASS: website-facing 8v8/Pro JSON, CORS, join links, validation, and optional player avatars');

console.log('PASS: Glutony Main 24-server sample, 8v8, Pro, flags, menus, details, joins, signatures, registration');
