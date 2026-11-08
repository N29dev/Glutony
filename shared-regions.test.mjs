import assert from 'node:assert/strict';
import worker, { _test as helpers } from './worker.mjs';

const placeId = '124087144919678';
const serverId = '550e8400-e29b-41d4-a716-446655440000';
const rows = new Map();
const snapshots = new Map();
const quotas = new Map();
let upstreamCalls = 0;
const oldFetch = globalThis.fetch;

const db = {
  prepare(sql) {
    const bound = (...args) => ({
          async all() {
            if (!sql.includes('FROM shared_server_regions')) return {results:[]};
            const [place, now, ...ids] = args;
            return {results: ids.flatMap(id => {
              const row = rows.get(place + ':' + id);
              return row && row.expires_at > now ? [row] : [];
            })};
          },
          async first() {
            if (!sql.includes('FROM server_snapshots')) return null;
            const snapshot = snapshots.get(args[0]);
            return snapshot ? {snapshot:JSON.stringify(snapshot)} : null;
          },
          async run() {
            if (sql.includes('INSERT INTO shared_region_lookup_quota')) {
              const [hash, minute, amount, limit] = args;
              const current = quotas.get(hash);
              if (current && current.minute === minute && current.used + amount > limit) {
                return {meta:{changes:0}};
              }
              quotas.set(hash, {
                minute,
                used:current && current.minute === minute ? current.used + amount : amount
              });
              return {meta:{changes:1}};
            }
            if (!sql.includes('INSERT INTO shared_server_regions')) {
              throw new Error('Unexpected DB write: ' + sql.slice(0, 90));
            }
            const [place, id, details_json, observed_at, expires_at] = args;
            rows.set(place + ':' + id, {
              place_id:place, server_id:id, details_json, observed_at, expires_at
            });
            return {success:true};
          }
    });
    return {
      bind(...args) { return bound(...args); },
      async all() { return bound().all(); },
      async first() { return bound().first(); },
    };
  },
  async batch(statements) {
    return Promise.all(statements.map(statement => statement.run()));
  }
};

const env = {CUSTOMS_DB:db, ROVALRA_REGIONS_ENABLED:'true', SETUP_KEY:'test-only-key-must-be-long-enough-for-HMAC'};
globalThis.fetch = async (url) => {
  const value = String(url);
  if (!value.startsWith('https://apis.rovalra.com/v1/servers/details')) {
    throw new Error('Unexpected provider request: ' + value);
  }
  upstreamCalls++;
  const parsed = new URL(value);
  assert.equal(parsed.searchParams.get('place_id'), placeId);
  const requested = (parsed.searchParams.get('server_ids') || '').split(',');
  assert.ok(requested.length >= 1);
  return Response.json({
    status:'success',
    servers:requested.map(id => ({
      server_id:id,city:'São Paulo',region:'São Paulo',
      country:'Brazil',datacenter_id:'PRIVATE_DC_DO_NOT_STORE',
      playerTokens:['PRIVATE_PLAYER_TOKEN_DO_NOT_STORE'],
      first_seen:'2026-11-08T00:00:00Z', place_version:52
    }))
  });
};

try {
  const sample = {placeId};
  const first = {id:serverId};
  await helpers.attachDetails(sample,[first],env);
  assert.equal(first.details.city,'São Paulo');
  assert.equal(first.details.country,'Brazil');
  assert.equal(upstreamCalls,1);
  assert.ok(rows.has(placeId + ':' + serverId), 'Region written to D1');
  const saved = rows.get(placeId + ':' + serverId);
  assert.ok(saved.expires_at - saved.observed_at <= 180_000);
  assert.ok(saved.expires_at > saved.observed_at);
  assert.ok(!saved.details_json.includes('PRIVATE_DC_DO_NOT_STORE'));
  assert.ok(!saved.details_json.includes('PRIVATE_PLAYER_TOKEN_DO_NOT_STORE'));

  helpers.detailCache.clear();
  const second = {id:serverId};
  await helpers.attachDetails(sample,[second],env);
  assert.equal(second.region,first.region);
  assert.equal(upstreamCalls,1, 'Shared D1 avoids another RoValra call');

  const serverSnapshot = {
    at:Date.now(),mode:'8v8',placeId,servers:[{
      id:serverId,playing:7,maxPlayers:16,free:9,ping:75,playerTokens:[]
    }],scanned:1,hasMore:false
  };
  snapshots.set('8v8:' + placeId + ':1',serverSnapshot);
  helpers.memoryCaches.set('8v8:' + placeId + ':1',serverSnapshot);
  const shared = await worker.fetch(new Request(
    'https://glutony.example/api/servers/regions/shared?mode=8v8&ids=' + serverId
  ),env,{});
  assert.equal(shared.status,200);
  const body = await shared.json();
  assert.equal(body.regions[serverId].city,'São Paulo');
  assert.equal(body.regions[serverId].country,'Brazil');
  assert.equal(upstreamCalls,1,'Thirst and website reuse one cache');

  const invalid = await worker.fetch(new Request(
    'https://glutony.example/api/servers/regions/shared?mode=8v8&ids=not-a-uuid'
  ),env,{});
  assert.equal(invalid.status,400);
  const unknown = await worker.fetch(new Request(
    'https://glutony.example/api/servers/regions/shared?mode=8v8&ids=550e8400-e29b-41d4-a716-446655440099'
  ),env,{});
  assert.equal(unknown.status,200);
  assert.deepEqual((await unknown.json()).regions,{});
  assert.equal(upstreamCalls,1,'Unlisted public IDs cannot proxy requests');

  const status = await worker.fetch(new Request(
    'https://glutony.example/api/servers/regions/status'
  ),env,{});
  assert.equal(status.status,200);
  const statusBody = await status.json();
  assert.equal(statusBody.cacheReady,true);
  assert.equal(statusBody.quotaReady,true);

  // A valid live Roblox UUID need not be in Glutony's own 60-server sample.
  // The guarded read-through endpoint fetches via RoValra and persists it.
  const outsideSample = '550e8400-e29b-41d4-a716-446655440002';
  const protectedURL = 'https://glutony.example/api/servers/regions/lookup?mode=8v8&ids=' + outsideSample;
  const protectedHeaders = {'cf-connecting-ip':'203.0.113.24'};
  const recovered = await worker.fetch(new Request(protectedURL, {headers:protectedHeaders}),env,{});
  assert.equal(recovered.status,200);
  const recoveredBody = await recovered.json();
  assert.equal(recoveredBody.regions[outsideSample].city,'São Paulo');
  assert.ok(rows.has(placeId + ':' + outsideSample), 'Unsampled region written to shared D1');
  assert.equal(recoveredBody.cache.allPersisted,true);
  assert.equal(recoveredBody.cache.foundCount,1);
  assert.equal(recoveredBody.cache.persistedCount,1);

  assert.equal(upstreamCalls,2,'Only the miss is sent to RoValra');

  const cachedAgain = await worker.fetch(
    new Request(protectedURL, {headers:protectedHeaders}),env,{}
  );
  assert.equal(cachedAgain.status,200);
  assert.equal(upstreamCalls,2,'Subsequent launcher lookup uses shared D1');

  const tooMany = Array.from({length:25},(_,i)=>
    '550e8400-e29b-41d4-a716-' + String(i+100).padStart(12,'0')
  );
  const restricted = await worker.fetch(new Request(
    'https://glutony.example/api/servers/regions/lookup?mode=8v8&ids=' + tooMany.join(','),
    {headers:protectedHeaders}
  ),env,{});
  assert.equal(restricted.status,429,'Quota stops repeated cache-miss API access');
  assert.equal(upstreamCalls,2,'Quota rejection makes no external RoValra call');
  assert.ok(quotas.size===1,'Only pseudonymous caller hash is stored');
  assert.ok(![...quotas.keys()][0].includes('203.0.113'),'Raw IP is not retained');

  const missingSource = await worker.fetch(
    new Request('https://glutony.example/api/servers/regions/lookup?mode=8v8&ids=' +
      '550e8400-e29b-41d4-a716-446655440003'),env,{}
  );
  assert.equal(missingSource.status,429,'Unattributed clients fail closed on uncached lookup');
  assert.equal(upstreamCalls,2);

  console.log('PASS: Region cache is shared, sanitized and bounded');
} finally {
  helpers.detailCache.clear();
  helpers.memoryCaches.clear();
  globalThis.fetch = oldFetch;
}
