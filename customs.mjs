// Glutony Customs: shared Discord and website board. Requires D1.
const DISCORD_API='https://discord.com/api/v10';
const SITE='https://blr.n29.kz';
const RE_UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const RE_ID=/^\d{15,22}$/;
// Admins are identified only by verified Discord snowflake IDs, never by
// client-submitted flags, display names, or guild permission claims.
const adminIds=env=>new Set(String(env.CUSTOMS_ADMIN_IDS||'').split(/[,\s]+/).filter(v=>RE_ID.test(v)));
const isAdmin=(env,id)=>RE_ID.test(String(id))&&adminIds(env).has(String(id));
const HEADERS={'access-control-allow-origin':SITE,'access-control-allow-methods':'GET, POST, PATCH, DELETE, OPTIONS','access-control-allow-headers':'authorization, content-type','vary':'Origin','cache-control':'no-store'};
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
const siteJson=(body,status=200)=>json(body,status,HEADERS);
const safe=(v,max=120)=>String(v??'').normalize('NFKC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>@#*_\x60~|\[\]\\]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const actor=i=>({id:String(i.member?.user?.id||i.user?.id||''),name:safe(i.member?.user?.global_name||i.user?.global_name||i.member?.user?.username||i.user?.username||'Player',32)});
function cleanInvite(raw) {
 let url;try{url=new URL(String(raw??'').trim());}catch{return null;}
 if(url.protocol!=='https:'||!['www.roblox.com','roblox.com'].includes(url.hostname)||url.username||url.password||url.port||url.pathname.toLowerCase()!=='/share')return null;
 if(url.searchParams.get('type')!=='Server'||[...url.searchParams.keys()].some(k=>!['type','code'].includes(k)))return null;
 const code=url.searchParams.get('code')||'';
 if(!/^[a-zA-Z0-9_-]{16,80}$/.test(code))return null;
 return {code,url:'https://www.roblox.com/share?code='+encodeURIComponent(code)+'&type=Server'};
}
// Optional host-reported occupancy. This must never be labeled as live Roblox data.
function parsePlayers(form){
 let current=form?.currentPlayers??form?.playerCurrent;
 let capacity=form?.capacity??form?.playerCapacity;
 const text=String(form?.players??'').trim();
 if(text){
  const match=/^(\d{1,3})\s*\/\s*(\d{1,3})$/.exec(text);
  if(!match)return {error:'Players must look like 4/10.'};
  current=match[1];capacity=match[2];
 }
 if((current===undefined||current===null||String(current).trim()==='') &&
    (capacity===undefined||capacity===null||String(capacity).trim()===''))return {current:null,capacity:null};
 if(current===undefined||capacity===undefined || current===null||capacity===null ||
    !/^\d{1,3}$/.test(String(current)) || !/^\d{1,3}$/.test(String(capacity)))return {error:'Enter both current and maximum players (example: 4/10).'};
 const c=Number(current),m=Number(capacity);
 if(c<0||m<1||m>100||c>m)return {error:'Player count must be between 0 and capacity; capacity must be 1–100.'};
 return {current:c,capacity:m};
}
function validateForm(form){
 const title=safe(form?.title,64),region=safe(form?.region||'Any region',35),note=safe(form?.note,180);
 const invite=cleanInvite(form?.link);
 if([form?.title,form?.region,form?.note].some(v=>/(?:https?:\/\/|www\.|discord\.gg\/|roblox\.com\/)/i.test(String(v||''))))return {error:'Links are only allowed in the Roblox invitation field.'};
 if(title.length<4)return {error:'Use a match title of at least 4 characters.'};
 if(!invite)return {error:'Paste a Roblox server share link (https://www.roblox.com/share?code=...&type=Server).'};
 const players=parsePlayers(form);
 if(players.error)return {error:players.error};
 return {title,region,note,...invite,players};
}
function publicEntry(r){
 return {id:r.id,title:r.title,region:r.region,note:r.note,ownerName:r.owner_name,link:r.invite_url,createdAt:r.created_at,expiresAt:r.expires_at,
 playerCurrent:Number.isInteger(r.player_current)?r.player_current:null,
 playerCapacity:Number.isInteger(r.player_capacity)?r.player_capacity:null,
 playerReportedAt:Number.isInteger(r.player_reported_at)?r.player_reported_at:null};
}
async function fetchActive(env){
 if(!env.CUSTOMS_DB)return [];
 const data=await env.CUSTOMS_DB.prepare("SELECT * FROM customs WHERE status='active' AND expires_at>? ORDER BY created_at DESC LIMIT 50").bind(Date.now()).all();
 return data.results||[];
}
async function postMatch(env,user,form){
 if(!env.CUSTOMS_DB)return {status:503,error:'Customs database is not configured.'};
 if(!RE_ID.test(user.id))return {status:401,error:'Discord sign-in required.'};
 const d=validateForm(form);if(d.error)return {status:400,error:d.error};
 if(await env.CUSTOMS_DB.prepare('SELECT 1 FROM customs_bans WHERE owner_id=?').bind(user.id).first())return {status:403,error:'Posting is disabled for this account.'};
 const now=Date.now(),id=crypto.randomUUID(),expires=now+4*3600000;
 const admin=isAdmin(env,user.id);
 // The identity was verified by either a signed Discord interaction or OAuth.
 // Admins can repost immediately after removing/expiring their previous match,
 // and are not subject to the 3-per-day quota. All other safety checks remain:
 // one active listing, duplicate invite check, ban list, validated Roblox URL.
 // Keep each condition inside one INSERT to avoid concurrent submission races.
 // Keep no-count posts compatible with the old schema until migration 0002 runs.
 const counted=d.players.current!==null;
 const columns=counted?',player_current,player_capacity,player_reported_at':'';
 const values=counted?',?,?,?':'';
 const query="INSERT INTO customs(id,owner_id,owner_name,title,region,note,invite_url,invite_code,created_at,expires_at,status"+columns+") "+
 "SELECT ?,?,?,?,?,?,?,?,?,?,'active'"+values+" WHERE "+
 "NOT EXISTS(SELECT 1 FROM customs WHERE owner_id=? AND status='active' AND expires_at>?) AND "+
 "(?=1 OR NOT EXISTS(SELECT 1 FROM customs WHERE owner_id=? AND created_at>?)) AND "+
 "(?=1 OR (SELECT COUNT(*) FROM customs WHERE owner_id=? AND created_at>?) < 3) AND "+
 "NOT EXISTS(SELECT 1 FROM customs WHERE invite_code=? AND status='active' AND expires_at>?)";
 const params=[
  id,user.id,safe(user.name,32),d.title,d.region,d.note,d.url,d.code,now,expires,
  ...(counted?[d.players.current,d.players.capacity,now]:[]),
  user.id,now,admin?1:0,user.id,now-600000,admin?1:0,user.id,now-86400000,d.code,now
 ];
 let result;
 try{result=await env.CUSTOMS_DB.prepare(query).bind(...params).run();}
 catch(error){
  if(counted&&/no such column|has no column|table .* has no column/i.test(String(error?.message||error)))
   return {status:503,error:'Player counts are not enabled in the database yet. Apply the latest D1 migration.'};
  throw error;
 }
 return result.meta?.changes?{ok:true,item:{
  id,title:d.title,region:d.region,note:d.note,ownerName:user.name,link:d.url,createdAt:now,expiresAt:expires,
  playerCurrent:d.players.current,playerCapacity:d.players.capacity,playerReportedAt:counted?now:null
 }}:
 {status:429,error:admin?
  'You already have an active listing or this invite is already listed. Remove the old listing to repost.':
  'Limit: 1 active post, 10-minute cooldown, 3 posts per day, and no duplicate active links.'};
}
// OAuth or signed Discord actor only. Host can refresh self-reported count once/min.
async function updatePlayers(env,user,id,form){
 if(!env.CUSTOMS_DB)return {status:503,error:'Database unavailable.'};
 if(!RE_ID.test(user.id)||!RE_UUID.test(id))return {status:400,error:'Invalid request.'};
 const p=parsePlayers(form);
 if(p.error)return {status:400,error:p.error};
 const now=Date.now();
 const sql="UPDATE customs SET player_current=?,player_capacity=?,player_reported_at=? "+
 "WHERE id=? AND owner_id=? AND status='active' AND expires_at>? "+
 "AND (player_reported_at IS NULL OR player_reported_at<=?)";
 try {
  const out=await env.CUSTOMS_DB.prepare(sql).bind(p.current,p.capacity,p.current===null?null:now,id,user.id,now,now-60_000).run();
  return out.meta?.changes?{ok:true,playerCurrent:p.current,playerCapacity:p.capacity,playerReportedAt:p.current===null?null:now}:
   {status:429,error:'Only the listing owner can update its player count, at most once per minute.'};
 }catch(error){
  if(/no such column/i.test(String(error?.message||error)))return {status:503,error:'Apply Customs D1 migration 0002 to enable player counts.'};
  throw error;
 }
}
async function deleteMatch(env,user,id){
 if(!env.CUSTOMS_DB)return {status:503,error:'Database unavailable.'};
 if(!RE_UUID.test(id))return {status:400,error:'Invalid listing ID.'};
 const moderator=isAdmin(env,user.id)||String(env.CUSTOMS_MODERATOR_IDS||'').split(/[,\s]+/).includes(user.id);
 const q=moderator?"UPDATE customs SET status='removed' WHERE id=? AND status='active'":"UPDATE customs SET status='removed' WHERE id=? AND owner_id=? AND status='active'";
 const res=await env.CUSTOMS_DB.prepare(q).bind(...(moderator?[id]:[id,user.id])).run();
 return res.meta?.changes?{ok:true}:{status:404,error:'Listing not found or you do not own it.'};
}
async function reportMatch(env,user,id){
 if(!env.CUSTOMS_DB)return {status:503,error:'Database unavailable.'};
 if(!RE_ID.test(user.id)||!RE_UUID.test(id))return {status:400,error:'Invalid request.'};
 const now=Date.now();
 const sql="INSERT OR IGNORE INTO customs_reports(listing_id,reporter_id,created_at) SELECT id,?,? FROM customs "+
 "WHERE id=? AND owner_id<>? AND status='active' AND expires_at>? AND "+
 "(SELECT COUNT(*) FROM customs_reports WHERE reporter_id=? AND created_at>?) < 5";
 const res=await env.CUSTOMS_DB.prepare(sql).bind(user.id,now,id,user.id,now,user.id,now-86400000).run();
 if(!res.meta?.changes)return {status:429,error:'Already reported or daily report limit reached.'};
 const r=await env.CUSTOMS_DB.prepare('SELECT COUNT(*) AS n FROM customs_reports WHERE listing_id=?').bind(id).first();
 if(Number(r?.n)>=4)await env.CUSTOMS_DB.prepare("UPDATE customs SET status='hidden' WHERE id=? AND status='active'").bind(id).run();
 return {ok:true};
}
const bytes=s=>new TextEncoder().encode(s);
const base64=a=>btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const from64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
async function sign(key,message){
 const cryptoKey=await crypto.subtle.importKey('raw',bytes(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return base64(new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,bytes(message))));
}
async function tokenFor(env,user){
 const payload=base64(bytes(JSON.stringify({id:user.id,name:safe(user.name,32),exp:Date.now()+4*3600000,nonce:crypto.randomUUID()})));
 return payload+'.'+await sign(env.CUSTOMS_SESSION_SECRET,payload);
}
async function websiteUser(req,env){
 if(!env.CUSTOMS_SESSION_SECRET)return null;
 const auth=req.headers.get('authorization')||'';
 if(!auth.startsWith('Bearer '))return null;
 const raw=auth.slice(7);
 if(raw.length>1024||!/^[\w-]+\.[\w-]+$/.test(raw))return null;
 const [payload,mac]=raw.split('.'),expected=await sign(env.CUSTOMS_SESSION_SECRET,payload);
 if(mac.length!==expected.length)return null;
 let bad=0;for(let i=0;i<mac.length;i++)bad|=mac.charCodeAt(i)^expected.charCodeAt(i);
 if(bad)return null;
 try{
  const p=JSON.parse(new TextDecoder().decode(from64(payload)));
  if(RE_ID.test(String(p.id))&&p.exp>Date.now()&&p.exp<Date.now()+4*3600000+60000)return {id:String(p.id),name:safe(p.name,32)};
 }catch{}
 return null;
}
const redirectUri='https://glutony.scp343hey.workers.dev/auth/discord/callback';
const oauthReady=env=>!!(env.DISCORD_APPLICATION_ID&&env.DISCORD_OAUTH_CLIENT_SECRET&&env.CUSTOMS_SESSION_SECRET);
function startOAuth(env){
 if(!oauthReady(env))return new Response('Discord sign-in not configured.',{status:503});
 const state=crypto.randomUUID().replaceAll('-','');
 const u=new URL('https://discord.com/oauth2/authorize');
 for(const [k,v] of Object.entries({client_id:env.DISCORD_APPLICATION_ID,redirect_uri:redirectUri,response_type:'code',scope:'identify',state}))u.searchParams.set(k,v);
 return new Response(null,{status:302,headers:{location:u.toString(),'set-cookie':'glutony_oauth='+state+'; Path=/auth/discord; Max-Age=600; HttpOnly; Secure; SameSite=Lax','cache-control':'no-store'}});
}
async function callbackOAuth(req,env){
 const u=new URL(req.url),state=u.searchParams.get('state')||'',code=u.searchParams.get('code')||'';
 const cookie=(req.headers.get('cookie')||'').match(/(?:^|;\s*)glutony_oauth=([0-9a-f]{32})(?:;|$)/)?.[1];
 if(!oauthReady(env)||!state||!cookie||state!==cookie||!code)return new Response('Login state expired. Please return to the website.',{status:400});
 const form=new URLSearchParams({client_id:env.DISCORD_APPLICATION_ID,client_secret:env.DISCORD_OAUTH_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:redirectUri});
 const response=await fetch(DISCORD_API+'/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form});
 if(!response.ok)return new Response('Discord token exchange failed.',{status:502});
 const tok=await response.json();
 const r=await fetch(DISCORD_API+'/users/@me',{headers:{authorization:'Bearer '+tok.access_token}});
 if(!r.ok)return new Response('Discord identity lookup failed.',{status:502});
 const who=await r.json();
 if(!RE_ID.test(String(who.id)))return new Response('Invalid account.',{status:400});
 const token=await tokenFor(env,{id:String(who.id),name:who.global_name||who.username});
 return new Response(null,{status:302,headers:{location:SITE+'/servers/customs/#customs_session='+encodeURIComponent(token),'cache-control':'no-store','referrer-policy':'no-referrer','set-cookie':'glutony_oauth=; Path=/auth/discord; Max-Age=0; HttpOnly; Secure; SameSite=Lax'}});
}
// Turnstile Spin existing-widget contract: verify every token against this
// production hostname AND a form-specific action. Fail closed on all errors.
// CUSTOMS_TURNSTILE_SECRET remains exclusively in Cloudflare runtime secrets.
async function checkTurnstile(env,token,expectedAction,clientIP=''){
 if(!env.CUSTOMS_TURNSTILE_SECRET || typeof token!=='string' ||
    token.length===0 || token.length>2048 ||
    !['customs_post','customs_report'].includes(expectedAction))return false;
 try {
  const params=new URLSearchParams({secret:env.CUSTOMS_TURNSTILE_SECRET,response:token});
  if(clientIP)params.set('remoteip',clientIP);
  const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
   method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
   body:params,signal:AbortSignal.timeout(10000)
  });
  if(!response.ok)return false;
  const result=await response.json();
  const verified=result?.success===true &&
    result.hostname==='blr.n29.kz' &&
    result.action===expectedAction;
  if(!verified)console.warn('Customs Turnstile verification rejected:',{
   actionMatched:result?.action===expectedAction,
   hostnameMatched:result?.hostname==='blr.n29.kz',
   errors:Array.isArray(result?.['error-codes'])?result['error-codes'].slice(0,5):[],
  });
  return verified;
 } catch(error) {
  console.warn('Customs Turnstile Siteverify unavailable:',error?.name||'Unknown');
  return false;
 }
}
async function website(req,env){
 const u=new URL(req.url),p=u.pathname;
 if(p==='/auth/discord/start'&&req.method==='GET')return startOAuth(env);
 if(p==='/auth/discord/callback'&&req.method==='GET')return callbackOAuth(req,env);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:HEADERS});
 if(p==='/api/customs/config'&&req.method==='GET')return siteJson({available:!!env.CUSTOMS_DB,authReady:oauthReady(env),sitekey:env.CUSTOMS_TURNSTILE_SITEKEY||null,canPost:!!(env.CUSTOMS_DB&&oauthReady(env)&&env.CUSTOMS_TURNSTILE_SITEKEY&&env.CUSTOMS_TURNSTILE_SECRET),login:'https://glutony.scp343hey.workers.dev/auth/discord/start'});
 if(p==='/api/customs'&&req.method==='GET')return siteJson({available:!!env.CUSTOMS_DB,listings:(await fetchActive(env)).map(publicEntry)});
 const user=await websiteUser(req,env);
 if(p==='/api/customs/me'&&req.method==='GET')return user?siteJson({...user,isAdmin:isAdmin(env,user.id)}):siteJson({error:'Sign in with Discord.'},401);
 if(p==='/api/customs/mine'&&req.method==='GET') {
  if(!user)return siteJson({error:'Sign in with Discord.'},401);
  if(!env.CUSTOMS_DB)return siteJson({ids:[]});
  const rows=await env.CUSTOMS_DB.prepare("SELECT id FROM customs WHERE owner_id=? AND status='active' AND expires_at>?").bind(user.id,Date.now()).all();
  return siteJson({ids:(rows.results||[]).map(x=>x.id)});
 }
 if(!['POST','DELETE','PATCH'].includes(req.method))return siteJson({error:'Not found.'},404);
 if(req.headers.get('origin')!==SITE)return siteJson({error:'Invalid request origin.'},403);
 if(!user)return siteJson({error:'Sign in with Discord.'},401);
 if(p==='/api/customs'&&req.method==='POST'){
  if(!env.CUSTOMS_DB||!env.CUSTOMS_TURNSTILE_SECRET||!env.CUSTOMS_TURNSTILE_SITEKEY)return siteJson({error:'Posting not configured yet.'},503);
  let body;try{body=await req.json();}catch{return siteJson({error:'Invalid JSON.'},400);}
  if(!await checkTurnstile(env,body.turnstile,'customs_post',req.headers.get('CF-Connecting-IP')||''))return siteJson({error:'Anti-spam verification was rejected or expired. Retry the challenge.',status:'rejected'},403);
  const result=await postMatch(env,user,body);
  return siteJson(result,result.status||201);
 }
 const playerMatch=/^\/api\/customs\/([a-f0-9-]{36})\/players$/i.exec(p);
 if(playerMatch&&req.method==='PATCH'){
  let body;try{body=await req.json();}catch{return siteJson({error:'Invalid JSON.'},400);}
  // Signed OAuth bearer token + same-origin request + SQL update throttling.
  const result=await updatePlayers(env,user,playerMatch[1],body);
  return siteJson(result,result.status||200);
 }
 const match=/^\/api\/customs\/([a-f0-9-]{36})(\/report)?$/i.exec(p);
 if(!match)return siteJson({error:'Not found.'},404);
 let result;
 if(req.method==='DELETE'&&!match[2])result=await deleteMatch(env,user,match[1]);
 else if(req.method==='POST'&&match[2]){
  let body;try{body=await req.json();}catch{return siteJson({error:'Invalid JSON.'},400);}
  if(!await checkTurnstile(env,body.turnstile,'customs_report',req.headers.get('CF-Connecting-IP')||''))return siteJson({error:'Anti-spam verification was rejected or expired. Retry the challenge.',status:'rejected'},403);
  result=await reportMatch(env,user,match[1]);
 }else return siteJson({error:'Not found.'},404);
 return siteJson(result,result.status||200);
}
const text=content=>({type:10,content});
const row=components=>({type:1,components});
const button=(label,id,disabled=false)=>({type:2,style:2,label,custom_id:id,disabled});
const linkButton=(label,url)=>({type:2,style:5,label,url});
const msg=components=>({flags:32768,allowed_mentions:{parse:[]},components});
function browseView(items,page,ready=true){
 const total=Math.max(1,Math.ceil(items.length/4)),current=Math.max(0,Math.min(total-1,page));
 const showing=items.slice(current*4,(current+1)*4);
 const parts=[text('## ⚽ Glutony · Customs\n-# Community-hosted private matches · Invites and region are unverified · Listings expire in 4 hours')];
 if(!ready)parts.push(text('Customs is not ready yet: storage is being configured. Please check back soon.'));
 else if(!showing.length)parts.push(text('No matches yet. Post one and invite other players!'));
 for(let i=0;i<showing.length;i++){
  const o=showing[i];
  const shown=publicEntry(o);
  const count=shown.playerCurrent!==null&&shown.playerCapacity!==null
    ?' · '+shown.playerCurrent+'/'+shown.playerCapacity+' players (host reported)'
    :' · Players unknown';
  parts.push(text('**'+(current*4+i+1)+'. '+safe(o.title,64)+'** · Host region: '+safe(o.region,35)+count+'\n'+safe(o.note||'Looking for teammates',150)+'\n-# Hosted by '+safe(o.owner_name,32)+' · Expires <t:'+Math.floor(o.expires_at/1000)+':R>'));
 }
 parts.push(text('-# Only public Roblox server invite links are accepted. Do not share account details.'));
 const partsAll=[{type:17,accent_color:0x32c99a,components:parts}];
 if(showing.length)partsAll.push(row([{type:3,custom_id:'c:select:'+current,placeholder:'Choose a custom match',min_values:1,max_values:1,options:showing.map((o,i)=>({label:(current*4+i+1)+'. '+safe(o.title,55),value:o.id,description:safe(o.region+' · '+o.owner_name,90)}))}]));
 partsAll.push(row([button('◀ Previous','c:browse:'+(current-1),current===0),button('↻ Refresh','c:browse:'+current),button('Next ▶','c:browse:'+(current+1),current+1>=total)]));
 partsAll.push(row([button('＋ Post match','c:add',!ready),linkButton('Website',SITE+'/servers/customs/')]));
 return msg(partsAll);
}
function detailView(item,page){
 return msg([
  {type:17,accent_color:0x32c99a,components:[
   text('## ⚽ '+safe(item.title,64)+'\n-# Community-hosted private match · Host-selected region: '+safe(item.region,35)),
   text('**Players:** '+(item.player_current!==null&&Number.isInteger(item.player_current)&&Number.isInteger(item.player_capacity)?
    item.player_current+'/'+item.player_capacity+' (host reported, not live)':'Unknown')+
    '\n**Host:** '+safe(item.owner_name,32)+'\n**Note:** '+safe(item.note||'Looking for teammates',180)+'\n**Expires:** <t:'+Math.floor(item.expires_at/1000)+':R>'),
   text('-# This invite was submitted by another player; Glutony cannot verify that it belongs to BL:R.')
  ]},
  row([linkButton('Open Roblox invite',item.invite_url)]),
  row([button('◀ Back','c:browse:'+page),button('Update players','c:players:'+item.id),button('Report','c:report:'+item.id),button('Remove my listing','c:remove:'+item.id)])
 ]);
}
function createModal(){
 const field=(id,label,style,required,max)=>({type:18,label,component:{type:4,custom_id:id,style,required,max_length:max,min_length:required?4:0}});
 return {type:9,data:{custom_id:'c:modal',title:'Post a BL:R custom match',components:[
  field('title','Match title',1,true,64),
  field('link','Roblox private server share URL',1,true,220),
  field('region','Region (NA / EU / Asia / etc.)',1,false,35),
  field('note','Rules / players needed (optional)',2,false,180),
  field('players','Players (optional, e.g. 4/10)',1,false,7)
 ]}};
}
function updatePlayersModal(id){
 return {type:9,data:{custom_id:'c:players-modal:'+id,title:'Update player count',components:[
  {type:18,label:'Current players (0–100)',component:{type:4,custom_id:'currentPlayers',style:1,required:true,min_length:1,max_length:3}},
  {type:18,label:'Maximum players (1–100)',component:{type:4,custom_id:'capacity',style:1,required:true,min_length:1,max_length:3}},
 ]}};
}
function callback(type,data){return json(data===undefined?{type}:{type,data});}
async function editMessage(i,data){
 const r=await fetch(DISCORD_API+'/webhooks/'+i.application_id+'/'+i.token+'/messages/@original',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
 if(!r.ok)console.warn('Discord Customs message update failed',r.status);
}
async function discordAsync(i,env,job){
 try{
  if(job.kind==='browse'){
   await editMessage(i,browseView(await fetchActive(env),job.page,!!env.CUSTOMS_DB));return;
  }
  if(job.kind==='detail'){
   const items=await fetchActive(env),found=items.find(x=>x.id===job.id);
   await editMessage(i,found?detailView(found,job.page):browseView(items,0,!!env.CUSTOMS_DB));return;
  }
  const a=actor(i);
  let result;
  if(job.kind==='create')result=await postMatch(env,a,job.form);
  else if(job.kind==='remove')result=await deleteMatch(env,a,job.id);
  else if(job.kind==='report')result=await reportMatch(env,a,job.id);
  else if(job.kind==='players')result=await updatePlayers(env,a,job.id,job.form);
  const success=job.kind==='create'?'✅ Your match is posted. Open Customs to see it.':job.kind==='remove'?'✅ Listing removed.':job.kind==='players'?'✅ Player count updated (host-reported).':'✅ Report received.';
  await editMessage(i,{content:result.error?'⚠️ '+result.error:success,allowed_mentions:{parse:[]}});
 }catch(error){
  console.error('Discord Customs failed',error);
  await editMessage(i,{content:'⚠️ Customs unavailable. Database setup may still be required.',allowed_mentions:{parse:[]}});
 }
}
function modalValues(i){
 const result={};
 for(const outer of i.data?.components||[]){const fields=outer.component?[outer.component]:(outer.components||[]);for(const field of fields)if(field.custom_id)result[field.custom_id]=field.value||'';}
 return result;
}
export function customsInteraction(i,env,ctx){
 if(i.type===2){
  ctx.waitUntil(discordAsync(i,env,{kind:'browse',page:0}));
  return callback(5);
 }
 if(i.type===5&&i.data?.custom_id==='c:modal'){
  ctx.waitUntil(discordAsync(i,env,{kind:'create',form:modalValues(i)}));
  return callback(5,{flags:64});
 }
 const playersModal=/^c:players-modal:([a-f0-9-]{36})$/i.exec(i.data?.custom_id||'');
 if(i.type===5&&playersModal&&RE_UUID.test(playersModal[1])){
  ctx.waitUntil(discordAsync(i,env,{kind:'players',id:playersModal[1],form:modalValues(i)}));
  return callback(5,{flags:64});
 }
 if(i.type!==3)return null;
 const id=i.data?.custom_id||'';
 if(!id.startsWith('c:'))return null;
 if(id==='c:add')return callback(9,createModal().data);
 const playersButton=/^c:players:([a-f0-9-]{36})$/i.exec(id);
 if(playersButton&&RE_UUID.test(playersButton[1]))return callback(9,updatePlayersModal(playersButton[1]).data);
 let m=/^c:browse:(-?\d{1,3})$/.exec(id);
 if(m){ctx.waitUntil(discordAsync(i,env,{kind:'browse',page:Math.max(0,Number(m[1]))}));return callback(6);}
 m=/^c:select:(\d{1,3})$/.exec(id);
 if(m&&RE_UUID.test(i.data?.values?.[0]||'')){
  ctx.waitUntil(discordAsync(i,env,{kind:'detail',page:Number(m[1]),id:i.data.values[0]}));return callback(6);
 }
 m=/^c:(report|remove):([0-9a-f-]{36})$/i.exec(id);
 if(m&&RE_UUID.test(m[2])){
  ctx.waitUntil(discordAsync(i,env,{kind:m[1],id:m[2]}));return callback(5,{flags:64});
 }
 return callback(4,{content:'Invalid Customs action. Please run the command again.',flags:64});
}
export async function customsFetch(request,env){
 const path=new URL(request.url).pathname;
 if(!path.startsWith('/api/customs')&&!path.startsWith('/auth/discord/'))return null;
 try{return await website(request,env);}catch(e){console.error('Customs API error',e);return siteJson({error:'Customs service unavailable.'},503);}
}
export const _customsTest={cleanInvite,validateForm,parsePlayers,publicEntry,browseView,detailView,createModal,updatePlayersModal,isAdmin,postMatch,updatePlayers};
