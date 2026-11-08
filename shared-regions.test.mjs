import assert from 'node:assert/strict';
import worker, { _test as helpers } from './worker.mjs';

const placeId = '124087144919678';
const serverId = '550e8400-e29b-41d4-a716-446655440000';
const rows = new Map();
const snapshots = new Map();
let upstreamCalls = 0;
const oldFetch = globalThis.fetch;

const db = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
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
            if (!sql.includes('INSERT INTO shared_server_regions')) {
              throw new Error('Unexpected DB write: ' + sql.slice(0, 90));
            }
            const [place, id, details_json, observed_at, expires_at] = args;
            rows.set(place + ':' + id, {
              place_id:place, server_id:id, details_json, observed_at, expires_at
            });
            return {success:true};
          }
        };
      }
    };
  },
  async batch(statements) {
    return Promise.all(statements.map(statement => statement.run()));
  }
};

const env = {CUSTOMS_DB:db, ROVALRA_REGIONS_ENABLED:'true'};
globalThis.fetch = async (url) => {
  const value = String(url);
  if (!value.startsWith('https://apis.rovalra.com/v1/servers/details')) {
    throw new Error('Unexpected provider request: ' + value);
  }
  upstreamCalls++;
  const parsed = new URL(value);
  assert.equal(parsed.searchParams.get('place_id'), placeId);
  assert.ok(parsed.searchParams.get('server_ids')?.includes(serverId));
  return Response.json({
    status:'success',
    servers:[{
      server_id:serverId,city:'São Paulo',region:'São Paulo',
      country:'Brazil',datacenter_id:'PRIVATE_DC_DO_NOT_STORE',
      playerTokens:['PRIVATE_PLAYER_TOKEN_DO_NOT_STORE'],
      first_seen:'2026-11-08T00:00:00Z', place_version:52
    }]
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

  console.log('PASS: Region cache is shared, sanitized and bounded');
} finally {
  helpers.detailCache.clear();
  helpers.memoryCaches.clear();
  globalThis.fetch = oldFetch;
}
