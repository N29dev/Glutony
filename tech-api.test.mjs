import test from 'node:test';
import assert from 'node:assert/strict';
import {techFetch,validateTechEntry} from './tech-api.mjs';

const ORIGIN='https://blr.n29.kz';
const BASE='https://glutony.example';
const SECRET='TEST_TECH_ADMIN_KEY_abcdefghijklmnopqrstuvwxyz_9876543210';
function dbMock(){
  const rows=new Map();
  return {
    rows,
    prepare(sql){
      return {
        async all(){
          if(sql.startsWith('SELECT id,data,hidden,updated_at'))return {results:[...rows.values()].sort((a,b)=>a.id.localeCompare(b.id))};
          if(sql.startsWith('SELECT id FROM tech_overrides'))return {results:[]};
          throw Error('Unexpected query: '+sql);
        },
        bind(...args){
          return {
            async run(){
              if(!sql.startsWith('INSERT INTO tech_overrides'))throw Error('Unexpected write');
              const id=args[0];
              rows.set(id,{
                id,
                data:args.length>1?args[1]:null,
                hidden:args.length>1?0:1,
                updated_at:'2026-11-02T00:00:00Z'
              });
              return {success:true};
            }
          };
        }
      };
    }
  };
}
function req(path,method='GET',body=null,key=SECRET,origin=ORIGIN){
  const headers={origin};
  if(key!==null)headers.authorization='Bearer '+key;
  if(body!==null)headers['content-type']='application/json';
  return new Request(BASE+path,{method,headers,...(body!==null?{body:JSON.stringify(body)}:{})});
}
const valid={name:'Delay Trap',status:'allowed',styles:['Nagi'],video:'https://www.youtube.com/shorts/dQw4w9WgXcQ',note:'A documented tech'};
const keyEnv={TECH_ADMIN_KEY:SECRET,CUSTOMS_DB:dbMock()};

test('entry validation rejects bad statuses, markup and unknown video hosts',()=>{
  assert.equal(validateTechEntry(valid,'nagi-delay-trap')?.name,'Delay Trap');
  assert.equal(validateTechEntry({...valid,status:'allowedish'},'nagi-delay-trap'),null);
  assert.equal(validateTechEntry({...valid,status:'punishable'},'nagi-delay-trap'),null);
  const manyStyles=Array.from({length:45},(_,i)=>'Style '+i);
  assert.equal(validateTechEntry({...valid,styles:manyStyles},'nagi-delay-trap')?.styles.length,45);
  assert.equal(validateTechEntry({...valid,name:'<script>alert(1)</script>'},'nagi-delay-trap'),null);
  assert.equal(validateTechEntry({...valid,video:'https://youtube.com.attacker.test/shorts/dQw4w9WgXcQ'},'nagi-delay-trap'),null);
  assert.equal(validateTechEntry({...valid,styles:[]},'nagi-delay-trap'),null);
  assert.equal(validateTechEntry(valid,'../secret'),null);
});

test('public feed + auth + write + update + hide are isolated and safe',async()=>{
  const env={TECH_ADMIN_KEY:SECRET,CUSTOMS_DB:dbMock()};
  const initial=await techFetch(req('/api/tech','GET',null,null),env);
  assert.equal(initial.status,200);
  assert.deepEqual((await initial.json()).entries,[]);

  assert.equal((await techFetch(req('/api/tech/admin/session','GET',null,null),env)).status,403);
  assert.equal((await techFetch(req('/api/tech/admin/session','GET',null,'wrong'),env)).status,403);
  assert.equal((await techFetch(req('/api/tech/admin/session','GET',null,SECRET,'https://evil.test'),env)).status,403);
  assert.equal((await techFetch(req('/api/tech/admin/session'),env)).status,200);

  const created=await techFetch(req('/api/tech/admin/entry/nagi-delay-trap','PUT',valid),env);
  assert.equal(created.status,200);
  assert.equal((await created.json()).entry.video,'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const publicPayload=await (await techFetch(req('/api/tech','GET',null,null),env)).json();
  assert.equal(publicPayload.entries.length,1);
  assert.equal(publicPayload.entries[0].status,'allowed');
  assert.ok(!JSON.stringify(publicPayload).includes(SECRET));

  const updated={...valid,status:'disallowed',name:'Delay Trap (updated)',styles:['Nagi','NEL Nagi']};
  assert.equal((await techFetch(req('/api/tech/admin/entry/nagi-delay-trap','PUT',updated),env)).status,200);
  const current=(await (await techFetch(req('/api/tech','GET',null,null),env)).json()).entries[0];
  assert.equal(current.status,'disallowed');
  assert.equal(current.styles.length,2);
  assert.equal(current.name,'Delay Trap (updated)');

  assert.equal((await techFetch(req('/api/tech/admin/entry/nagi-delay-trap','DELETE'),env)).status,200);
  const hidden=(await (await techFetch(req('/api/tech','GET',null,null),env)).json()).entries[0];
  assert.deepEqual(hidden.id,'nagi-delay-trap');
  assert.equal(hidden.hidden,true);
  assert.ok(!('name' in hidden));
});

test('invalid edits, unconfigured secret, missing database, preflight',async()=>{
  const env={TECH_ADMIN_KEY:SECRET,CUSTOMS_DB:dbMock()};
  assert.equal((await techFetch(req('/api/tech/admin/entry/nagi-delay-trap','PUT',{...valid,status:'unknown'}),env)).status,400);
  assert.equal((await techFetch(req('/api/tech/admin/entry/../secret','PUT',valid),env)).status===404,true);
  assert.equal((await techFetch(req('/api/tech/admin/entry/nagi-delay-trap','PUT',valid,SECRET,'https://evil.test'),env)).status,403);
  assert.equal((await techFetch(req('/api/tech/admin/session'),{CUSTOMS_DB:dbMock()})).status,503);
  assert.equal((await techFetch(req('/api/tech','GET',null,null),{})).status,503);
  const preflight=await techFetch(req('/api/tech/admin/session','OPTIONS',null,null),env);
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),ORIGIN);
  assert.equal(await techFetch(req('/unrelated','GET',null,null),env),null);
});

test('ratings, tags and counterplay round-trip and stay optional for old entries',async()=>{
  const env={TECH_ADMIN_KEY:SECRET,CUSTOMS_DB:dbMock()};
  const entry={...valid,
    ratings:{execution:4,counter:5,advantage:5,consistency:3,save:5},
    tags:['Shooting','Precise timing','GK-saveable'],
    counterplay:'Predict the second shot.\nDo not dive on the first fake.'
  };
  const result=await techFetch(req('/api/tech/admin/entry/nagi-delay-trap','PUT',entry),env);
  assert.equal(result.status,200);
  const received=(await (await techFetch(req('/api/tech','GET',null,null),env)).json()).entries[0];
  assert.deepEqual(received.ratings,entry.ratings);
  assert.deepEqual(received.tags,entry.tags);
  assert.equal(received.counterplay,entry.counterplay);
  const legacy=await techFetch(req('/api/tech/admin/entry/legacy-tech','PUT',valid),env);
  assert.equal(legacy.status,200);
  const old=(await legacy.json()).entry;
  assert.deepEqual(old.ratings,{});
  assert.deepEqual(old.tags,[]);
  assert.equal(old.counterplay,'');
});

test('invalid gameplay assessments and markup are rejected',()=>{
  assert.equal(validateTechEntry({...valid,ratings:{execution:0}},'valid-id'),null);
  assert.equal(validateTechEntry({...valid,ratings:{counter:6}},'valid-id'),null);
  assert.equal(validateTechEntry({...valid,ratings:{advantage:2.5}},'valid-id'),null);
  assert.equal(validateTechEntry({...valid,ratings:{unknown:4}},'valid-id'),null);
  assert.equal(validateTechEntry({...valid,tags:['Shooting','Shooting']},'valid-id'),null);
  assert.equal(validateTechEntry({...valid,tags:['Injected tag']},'valid-id'),null);
  assert.equal(validateTechEntry({...valid,counterplay:'<script>alert(1)</script>'},'valid-id'),null);
  assert.equal(validateTechEntry({...valid,counterplay:'A'.repeat(1201)},'valid-id'),null);
  assert.ok(validateTechEntry({...valid,ratings:{execution:3},counterplay:'Watch your position.'},'valid-id'));
});
