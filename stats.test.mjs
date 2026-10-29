import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {STATS_COMMAND, recordStats, botStatsMessage, serverStatsMessage} from './stats.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class FakeD1 {
  constructor() {
    this.seen = new Map();
    this.daily = new Map();
    this.uniques = new Set();
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...values) {
        return {
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO stats_seen')) {
              const [id, at] = values;
              if (db.seen.has(id)) return {meta:{changes:0}};
              db.seen.set(id,at);
              return {meta:{changes:1}};
            }
            if (sql.includes('INSERT INTO stats_daily')) {
              const [day, command, mode] = values;
              const key = [day, command, mode].join('|');
              db.daily.set(key, (db.daily.get(key) || 0) + 1);
              return {meta:{changes:1}};
            }
            if (sql.includes('INSERT OR IGNORE INTO stats_unique')) {
              const [day,dimension,token] = values;
              db.uniques.add([day,dimension,token].join('|'));
              return {meta:{changes:1}};
            }
            if (sql.includes('DELETE FROM stats_seen')) {
              for (const [key, at] of db.seen) if (at < values[0]) db.seen.delete(key);
              return {meta:{changes:0}};
            }
            if (sql.includes('DELETE FROM stats_unique')) {
              for (const key of db.uniques) if (key.split('|')[0] < values[0]) db.uniques.delete(key);
              return {meta:{changes:0}};
            }
            throw new Error('Unknown run SQL: ' + sql);
          },
          async first() {
            if (sql.includes('SUM(uses)')) return {n:[...db.daily.values()].reduce((a,b)=>a+b,0)};
            if (sql.includes('COUNT(DISTINCT token)')) {
              const dim = sql.includes("'user'") ? 'user' : 'guild';
              return {n:new Set([...db.uniques].map(key=>key.split('|')).filter(row=>row[0]>=values[0]&&row[1]===dim).map(row=>row[2])).size};
            }
            throw new Error('Unknown first SQL: ' + sql);
          },
          async all() {
            if (sql.includes('FROM stats_daily') && sql.includes('GROUP BY')) {
              const groups = new Map();
              for (const [key, n] of db.daily) {
                const [day,command,mode] = key.split('|');
                if(day<values[0])continue;
                const id=command+'|'+mode;
                groups.set(id,(groups.get(id)||0)+n);
              }
              return {results:[...groups].map(([key,n])=>{
                const [command,mode]=key.split('|');
                return {command,mode,n};
              })};
            }
            throw new Error('Unknown all SQL: '+sql);
          },
        };
      },
      async first() { return this.bind().first(); },
    };
  }
}

assert.equal(STATS_COMMAND.name,'stats');
assert.deepEqual(STATS_COMMAND.integration_types,[0,1]);
const db = new FakeD1();
const env = {CUSTOMS_DB:db,SETUP_KEY:'test-secret-key-for-anonymous-usage-123'};
const id='1555555555555555500';
const actor='1444444444444444400';
const server='1333333333333333300';
const first={type:2,id,data:{name:'blr',options:[{name:'mode',value:'pro'}]},user:{id:actor},guild_id:server};
await recordStats(env,first);
await recordStats(env,first);
assert.equal(db.seen.size,1,'Discord retry does not double count');
assert.equal([...db.daily.values()].reduce((a,b)=>a+b,0),1);
assert.equal(db.uniques.size,2,'One user and one guild recorded anonymously');
assert.ok(![...db.uniques].some(key=>key.includes(actor)||key.includes(server)),
  'Do not store raw Discord user or guild IDs');

await recordStats(env,{type:2,id:'1555555555555555501',data:{name:'download'},member:{user:{id:actor}},guild_id:server});
await recordStats(env,{type:2,id:'1555555555555555502',data:{name:'blr',options:[{name:'mode',value:'8v8'}]},user:{id:'1444444444444444401'}});
await recordStats(env,{type:2,id:'1555555555555555503',data:{name:'stats'},user:{id:actor}});
await recordStats(env,{type:3,id:'1555555555555555504',data:{custom_id:'g:p:pro:0:players'},user:{id:actor}});
assert.equal(db.daily.size,4,'Only slash commands are tracked, not component clicks');

const message = await botStatsMessage(env);
assert.ok(message.includes('4 this week · 4 all time'), message);
assert.ok(message.includes('Unique users:** 2'), message);
assert.ok(message.includes('Unique servers:** 1'), message);
assert.ok(message.includes('/blr: **2**'), message);
assert.ok(message.includes('Pro: **1**'), message);
assert.ok(message.includes('8v8: **1**'), message);

const withoutSecret={CUSTOMS_DB:new FakeD1()};
await recordStats(withoutSecret,{type:2,id:'1555555555555555505',data:{name:'blr'},user:{id:actor}});
assert.equal(withoutSecret.CUSTOMS_DB.uniques.size,0,
  'Never store unhashed identifiers when the secret is missing');

const sample=serverStatsMessage({
  mode:'pro',scanned:2,hasMore:true,
  servers:[{playing:7,free:3,ping:90},{playing:4,free:6,ping:null}],
});
assert.ok(sample.includes('Players in sample:** 11'),sample);
assert.ok(sample.includes('Free slots:** 9'),sample);
assert.ok(sample.includes('55.0%'),sample);
assert.ok(sample.includes('90 ms'),sample);
assert.ok(sample.includes('More servers may exist'),sample);

console.log('PASS: private /stats metrics, sampled server calculations, deduplicated commands and anonymized users');
