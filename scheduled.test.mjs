import assert from 'node:assert/strict';
import worker, { _test as helpers } from './worker.mjs';

// No real Roblox or Cloudflare calls: a fake D1 records successful scheduled scans.
const place8 = '124087144919678';
const placePro = '99999183305180';
const id8 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const idPro = '11111111-2222-3333-4444-555555555555';
const snapshots = new Map();
const calls = [];
const env = {
  ROBLOX_MAX_PAGES: '3',
  ROVALRA_REGIONS_ENABLED: 'false',
  CUSTOMS_DB: {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              assert.match(sql, /SELECT snapshot FROM server_snapshots/);
              const row = snapshots.get(args[0]);
              return row ? {snapshot: JSON.stringify(row)} : null;
            },
            async run() {
              assert.match(sql, /INSERT INTO server_snapshots/);
              snapshots.set(args[0], JSON.parse(args[1]));
              return {success: true};
            },
            async all() { return {results: []}; },
          };
        },
      };
    },
  },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  const address = String(url);
  calls.push(address);
  if (address.includes('games.roblox.com')) {
    const pro = address.includes(placePro);
    return Response.json({data:[{
      id: pro ? idPro : id8,
      playing: pro ? 7 : 12, maxPlayers: pro ? 10 : 16, ping: 70, playerTokens:[],
    }], nextPageCursor: null});
  }
  if (address.includes('apis.rovalra.com')) return Response.json({status:'success', servers:[]});
  if (address.includes('/v1/datacenters/list')) return Response.json([]);
  throw new Error('Unexpected external request: ' + address);
};

try {
  const at = Date.UTC(2026, 10, 4, 20, 0);
  await worker.scheduled({scheduledTime:at}, env, {});
  assert.ok(snapshots.has(`8v8:${place8}:1`), 'Even-minute Cron checks 8v8');
  assert.equal(snapshots.has(`pro:${placePro}:1`), false);
  await worker.scheduled({scheduledTime:at + 60_000}, env, {});
  assert.ok(snapshots.has(`pro:${placePro}:1`), 'Odd-minute Cron checks Pro');
  assert.equal(calls.filter(url=>url.includes('games.roblox.com')).length,2,
    'One Roblox page per scheduled scan, never a three-page burst');

  const robloxCalls = () => calls.filter(url=>url.includes('games.roblox.com')).length;
  const beforePageLoad = robloxCalls();
  const live = await worker.fetch(new Request('https://glutony.example/api/servers?mode=8v8'),env,{});
  assert.equal(live.status,200);
  const liveBody = await live.json();
  assert.equal(liveBody.servers[0].id,id8);
  assert.equal(liveBody.lastKnown,false);
  assert.equal(robloxCalls(),beforePageLoad,'Website must not call Roblox');

  const pro = await worker.fetch(new Request('https://glutony.example/api/servers?mode=pro'),env,{});
  assert.equal(pro.status,200);
  assert.equal((await pro.json()).servers[0].id,idPro);
  assert.equal(robloxCalls(),beforePageLoad,'Pro website must not call Roblox');

  const key = `8v8:${place8}:1`;
  const lastKnown = {...snapshots.get(key),at:Date.now()-8*60_000};
  snapshots.set(key,lastKnown);
  helpers.memoryCaches.set(key,lastKnown);
  const stale = await worker.fetch(new Request('https://glutony.example/api/servers?mode=8v8'),env,{});
  assert.equal(stale.status,200,'Eight-minute samples remain viewable with a warning');
  const staleBody = await stale.json();
  assert.equal(staleBody.stale,true);
  assert.equal(staleBody.lastKnown,true);
  assert.equal(robloxCalls(),beforePageLoad,'Stale webpage must not start a scan');
  assert.ok(JSON.stringify(helpers.listMessage(lastKnown,0,'players')).includes('Last-known servers'),
    'Discord warns users about old server listings');

  // Simulate Roblox rate-limiting a scheduled update. The old D1 sample survives.
  globalThis.fetch = async url => {
    const address = String(url);
    calls.push(address);
    if (address.includes('games.roblox.com')) return new Response('rate limited',{status:429,headers:{'retry-after':'60'}});
    if (address.includes('apis.rovalra.com')) return Response.json({status:'success', servers:[]});
    throw new Error('Unexpected external request: '+address);
  };
  await worker.scheduled({scheduledTime:at + 2*60_000},env,{});
  assert.equal(snapshots.get(key).at,lastKnown.at,'Failed scans never overwrite successful snapshots');
  const fallback = await worker.fetch(new Request('https://glutony.example/api/servers?mode=8v8'),env,{});
  assert.equal(fallback.status,200,'Viewable last-known sample survives rate limit');
  assert.equal((await fallback.json()).lastKnown,true);

  const expired = {...lastKnown,at:Date.now()-16*60_000};
  snapshots.set(key,expired);
  helpers.memoryCaches.set(key,expired);
  const tooOld = await worker.fetch(new Request('https://glutony.example/api/servers?mode=8v8'),env,{});
  assert.equal(tooOld.status,503,'Expired servers are not presented after 15 minutes');
  assert.equal((await tooOld.json()).code,'server_sample_expired');

  snapshots.delete(key);
  helpers.memoryCaches.delete(key);
  const empty = await worker.fetch(new Request('https://glutony.example/api/servers?mode=8v8'),env,{});
  assert.equal(empty.status,503,'No snapshot returns explicit error rather than scanning');
  assert.equal((await empty.json()).code,'server_snapshot_unavailable');
  console.log('PASS: scheduled 8v8/Pro scans, shared D1 reads, rate-limit fallback and expiry');
} finally {
  globalThis.fetch = originalFetch;
}
