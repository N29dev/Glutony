import assert from 'node:assert/strict';
import { customsFetch, _customsTest as h } from './customs.mjs';

const code = 'c'.repeat(32);
const url = 'https://www.roblox.com/share?code=' + code + '&type=Server';
const invite = h.cleanInvite(url);
assert.ok(invite, 'Legitimate Roblox server share link');
assert.equal(invite.code,code);
assert.equal(invite.url,url);
for(const bad of [
 'https://www.roblox.com.evil.test/share?code='+code+'&type=Server',
 'http://www.roblox.com/share?code='+code+'&type=Server',
 'https://www.roblox.com/share?code='+code+'&type=User',
 'https://www.roblox.com/share?code='+code+'&type=Server&redirect=https://evil.test',
 'https://example.com/share?code='+code+'&type=Server',
 'https://www.roblox.com/games/99999183305180'
]) assert.equal(h.cleanInvite(bad),null,'Unsafe/unsupported link '+bad);

assert.equal(h.validateForm({title:'Play with us',link:url,region:'Asia'}).title,'Play with us');
assert.ok(h.validateForm({title:'Hi',link:url}).error);
assert.ok(h.validateForm({title:'Free Robux at https://bad.test',link:url}).error);
assert.ok(h.validateForm({title:'Test match',link:'https://evil.test'}).error);

const fixture={id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',owner_id:'123456789012345678',owner_name:'Player',title:'Weekend customs',region:'EU',note:'Need teammates',invite_url:url,expires_at:Date.now()+3600000,created_at:Date.now()};
const publicItem=h.publicEntry(fixture);
assert.equal(publicItem.link,url);
assert.equal(publicItem.owner_id,undefined,'Public response must not disclose account IDs');
const browse=h.browseView([fixture],0,true);
assert.equal(browse.flags,32768);
assert.ok(JSON.stringify(browse).includes('Weekend customs'));
assert.ok(JSON.stringify(browse).includes('/servers/customs/'));
const disabled=h.browseView([],0,false);
assert.ok(JSON.stringify(disabled).includes('storage is being configured'));
assert.ok(JSON.stringify(disabled).includes('"disabled":true'));
const modal=h.createModal();
assert.equal(modal.type,9);
assert.equal(modal.data.components[0].type,18,'Modal uses modern Label components');
assert.equal(modal.data.components[0].component.type,4);

const config=await customsFetch(new Request('https://glutony.example/api/customs/config'),{DISCORD_APPLICATION_ID:'1563907646757666926'});
assert.equal(config.status,200);
const c=await config.json();
assert.equal(c.available,false);
assert.equal(c.canPost,false);
const listing=await customsFetch(new Request('https://glutony.example/api/customs'),{});
assert.deepEqual((await listing.json()).listings,[]);
const forbidden=await customsFetch(new Request('https://glutony.example/api/customs',{method:'POST',headers:{origin:'https://evil.test', 'content-type':'application/json'},body:'{}'}),{});
assert.equal(forbidden.status,403);

// Cooldown bypass is checked server-side against a verified Discord user ID.
// Admins can repost immediately (after removing an active listing), without
// a 3-per-day quota; regular users still have both restrictions.
const adminId='123456789012345678';
const guestId='987654321098765432';
const testEnv={
 CUSTOMS_ADMIN_IDS: '  '+adminId+', '+ '112233445566778899' + ' ',
 CUSTOMS_DB:{
  prepare(sql){
   return {
    bind(...args){
     return {
      first:async()=>null, // not banned
      run:async()=>{
       testEnv.lastSQL=sql;
       testEnv.lastArgs=args;
       return {meta:{changes:1}};
      }
     };
    }
   };
  }
 }
};
assert.equal(h.isAdmin(testEnv,adminId),true);
assert.equal(h.isAdmin(testEnv,guestId),false);
assert.equal(h.isAdmin({CUSTOMS_MODERATOR_IDS:adminId},adminId),false,
 'Moderator permissions alone must not bypass posting anti-spam limits');
const first=await h.postMatch(testEnv,{id:guestId,name:'Guest'},{
 title:'Friendly match',link:url,region:'NA'
});
assert.equal(first.ok,true);
assert.equal(testEnv.lastArgs[12],0,'Regular user must not bypass cooldown');
assert.equal(testEnv.lastArgs[15],0,'Regular user must not bypass daily quota');
assert.match(testEnv.lastSQL,/\?=1 OR NOT EXISTS/);
const adminPost=await h.postMatch(testEnv,{id:adminId,name:'Admin'},{
 title:'Admin practice',link:url,region:'EU'
});
assert.equal(adminPost.ok,true);
assert.equal(testEnv.lastArgs[12],1,'Admin skips cooldown check');
assert.equal(testEnv.lastArgs[15],1,'Admin skips daily quota');
assert.ok(testEnv.lastSQL.includes("NOT EXISTS(SELECT 1 FROM customs WHERE owner_id=? AND status='active'"),
 'One active listing per account still applies to admins');
assert.ok(testEnv.lastSQL.includes("NOT EXISTS(SELECT 1 FROM customs WHERE invite_code=?"),
 'Duplicate active share links still blocked for admins');
assert.equal(testEnv.lastArgs.length,20,'All SQL bindings are present');
console.log('PASS: admin identity allowlist, posting exemption, SQL conditions, and ordinary anti-spam limits.');

console.log('PASS: Customs Roblox URL validation, sanitization, public data, Discord modal, CORS, and disabled-first deployment.');
