/**
 * Public overlay + private editor for an unofficial BL:R rules directory.
 * Uses existing CUSTOMS_DB D1 binding; requires a distinct TECH_ADMIN_KEY secret.
 */
const TECH_ORIGIN = 'https://blr.n29.kz';
const TECH_STATUSES = new Set(['allowed','disallowed']);
const TECH_ID = /^[a-z0-9][a-z0-9-]{1,70}$/;
const TECH_TEXT = /^[^<>{}\u0000-\u001f]*$/u;
const TECH_MAX_BODY = 4096;
function techJson(body,status=200){
  return new Response(JSON.stringify(body),{status,headers:{
    'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'access-control-allow-origin':TECH_ORIGIN,'access-control-allow-methods':'GET,PUT,DELETE,OPTIONS',
    'access-control-allow-headers':'authorization,content-type','vary':'Origin',
    'x-content-type-options':'nosniff'
  }});
}
function techOptions(){
  return new Response(null,{status:204,headers:{
    'access-control-allow-origin':TECH_ORIGIN,
    'access-control-allow-methods':'GET,PUT,DELETE,OPTIONS',
    'access-control-allow-headers':'authorization,content-type',
    'vary':'Origin','cache-control':'no-store'
  }});
}
function safeEqual(a,b){
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
function adminAuthorized(request,env){
  const secret=typeof env.TECH_ADMIN_KEY==='string'?env.TECH_ADMIN_KEY:'';
  return secret.length>=32 && safeEqual(request.headers.get('authorization'),'Bearer '+secret);
}
function youtube(value){
  if(value==null||value==='')return '';
  if(typeof value!=='string'||value.length>240)return null;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:')return null;
    const host=url.hostname.toLowerCase();
    if(!['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(host))return null;
    let id='';
    if(host==='youtu.be')id=url.pathname.slice(1).split('/')[0];
    else if(url.pathname==='/watch')id=url.searchParams.get('v')||'';
    else if(/^\/(shorts|embed)\/[^/]+/.test(url.pathname))id=url.pathname.split('/')[2];
    return /^[a-zA-Z0-9_-]{11}$/.test(id)?'https://www.youtube.com/watch?v='+id:null;
  }catch{return null;}
}
function textField(value,max){
  if(typeof value!=='string')return null;
  const s=value.trim().replace(/\s+/g,' ');
  return s.length>0&&s.length<=max&&TECH_TEXT.test(s)?s:null;
}
export function validateTechEntry(input,id){
  if(!input||typeof input!=='object'||Array.isArray(input)||!TECH_ID.test(id))return null;
  const name=textField(input.name,110);
  const note=input.note==null||input.note===''?'':textField(input.note,500);
  const video=youtube(input.video);
  if(!name||!TECH_STATUSES.has(input.status)||note===null||video===null)return null;
  if(!Array.isArray(input.styles)||input.styles.length===0)return null;
  const styles=input.styles.map(style=>textField(style,48));
  if(styles.some(style=>!style)||new Set(styles).size!==styles.length)return null;
  return {id,name,status:input.status,styles,note,video};
}
export async function techFetch(request,env){
  const url=new URL(request.url);
  const path=url.pathname;
  if(path!=='/api/tech'&&!path.startsWith('/api/tech/admin/'))return null;
  if(request.method==='OPTIONS')return techOptions();
  const isAdmin=path.startsWith('/api/tech/admin/');
  if(isAdmin){
    const origin=request.headers.get('origin');
    if(origin&&origin!==TECH_ORIGIN)return techJson({error:'Invalid origin'},403);
    if(!env.TECH_ADMIN_KEY||String(env.TECH_ADMIN_KEY).length<32)
      return techJson({error:'Admin editor not configured'},503);
    if(!adminAuthorized(request,env))return techJson({error:'Not authorized'},403);
  }
  if(!env.CUSTOMS_DB)return techJson({error:'Rules database unavailable'},503);
  try{
    if(path==='/api/tech'&&request.method==='GET'){
      const rows=await env.CUSTOMS_DB.prepare('SELECT id,data,hidden,updated_at FROM tech_overrides ORDER BY id LIMIT 1000').all();
      const entries=[];
      for(const row of rows.results||[]){
        const id=row.id;
        if(!TECH_ID.test(id))continue;
        if(row.hidden){entries.push({id,hidden:true,updatedAt:row.updated_at});continue;}
        try{
          const saved=JSON.parse(row.data);
          // Read legacy punishable records as disallowed without losing their details.
          if(saved?.status==='punishable')saved.status='disallowed';
          const parsed=validateTechEntry(saved,id);
          if(parsed)entries.push({...parsed,updatedAt:row.updated_at});
        }catch{}
      }
      return techJson({entries,updatedAt:new Date().toISOString()});
    }
    if(path==='/api/tech/admin/session'&&request.method==='GET'){
      await env.CUSTOMS_DB.prepare('SELECT id FROM tech_overrides LIMIT 1').all();
      return techJson({authorized:true});
    }
    if(!path.startsWith('/api/tech/admin/entry/'))return techJson({error:'Unknown admin action'},404);
    let id;
    try{id=decodeURIComponent(path.slice('/api/tech/admin/entry/'.length));}
    catch{return techJson({error:'Invalid entry ID'},400);}
    if(!TECH_ID.test(id))return techJson({error:'Invalid entry ID'},400);
    if(request.method==='PUT'){
      if(Number(request.headers.get('content-length')||0)>TECH_MAX_BODY)return techJson({error:'Entry too large'},413);
      let raw;
      try{raw=await request.text();}catch{return techJson({error:'Body unavailable'},400);}
      if(raw.length>TECH_MAX_BODY)return techJson({error:'Entry too large'},413);
      let body;
      try{body=JSON.parse(raw);}catch{return techJson({error:'Invalid JSON'},400);}
      const entry=validateTechEntry(body,id);
      if(!entry)return techJson({error:'Invalid entry: check name, status, styles, note, and YouTube URL'},400);
      await env.CUSTOMS_DB.prepare(
        "INSERT INTO tech_overrides (id,data,hidden,updated_at) VALUES (?,?,0,strftime('%Y-%m-%dT%H:%M:%fZ','now')) "+
        "ON CONFLICT(id) DO UPDATE SET data=excluded.data,hidden=0,updated_at=excluded.updated_at"
      ).bind(id,JSON.stringify(entry)).run();
      return techJson({ok:true,entry});
    }
    if(request.method==='DELETE'){
      await env.CUSTOMS_DB.prepare(
        "INSERT INTO tech_overrides (id,data,hidden,updated_at) VALUES (?,NULL,1,strftime('%Y-%m-%dT%H:%M:%fZ','now')) "+
        "ON CONFLICT(id) DO UPDATE SET data=NULL,hidden=1,updated_at=excluded.updated_at"
      ).bind(id).run();
      return techJson({ok:true,id,hidden:true});
    }
    return techJson({error:'Method not allowed'},405);
  }catch(err){
    console.error('Tech directory database error:',String(err?.message||err).slice(0,180));
    return techJson({error:'Tech database not ready; apply migration 0004_tech_rules.sql'},503);
  }
}
