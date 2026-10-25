import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker, { _test as helpers } from './worker.mjs';

const place8 = '124087144919678';
const placePro = '99999183305180';
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
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  const method = options.method || 'GET';
  calls.push({address, method, body: options.body});
  if (address.includes('games.roblox.com')) {
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
  if (address.includes('/applications/') && address.includes('/commands')) {
    return Response.json({name:'blr',id:'123456789012345678'});
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
const invalid = await worker.fetch(new Request('https://glutony.example/interactions', {method:'POST',body:'{}'}),env,{});
assert.equal(invalid.status,401,'Unsigned request must fail');
assert.equal(helpers.config(env, '8v8').placeId,place8);
assert.equal(helpers.config(env, 'pro').placeId,placePro);
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
assert.equal(response.type,4);
assert.equal((await worker.fetch(new Request('https://glutony.example/admin/register',{method:'POST'}),env,{})).status,403);
assert.equal((await (await worker.fetch(new Request('https://glutony.example/admin/register',{method:'POST',headers:{authorization:'Bearer '+env.SETUP_KEY}}),env,{})).json()).registered,'blr');

console.log('PASS: Glutony 8v8, Pro, flags, menus, details, join links, signature verification, and registration');
