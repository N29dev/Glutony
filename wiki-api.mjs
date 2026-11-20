// Manually tested wiki data. Append-only, optimistic revisions, separate from tech rules.
const ORIGIN='https://blr.n29.kz';
const STYLES=new Set('aiku bachira bloodmoon-rin bunny charles chigiri demon-shidou don-lorenzo easter-kaiser easter-yukimiya elf-emperor firework-bachira gagamaru gingerbread-charles hiori igaguri isagi kaiser karasu king kiyora krampus-barou kunigami kurona lavinho loki mcnagi-fryshiro nagi ness niko otoya phantom-isagi raichi reaper-sae reo rin sae santa-lavinho sendou shidou skeleton-nagi snuffy subzero-loki yukimiya zantetsu'.split(' '));
const ID=/^[a-zA-Z0-9-]{1,80}$/;
const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':ORIGIN,'access-control-allow-methods':'GET,PUT,OPTIONS','access-control-allow-headers':'authorization,content-type','vary':'Origin','x-content-type-options':'nosniff'};
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers});
const error=(message,status)=>json({error:message},status);
function authorized(request,env){
 const key=env.TECH_ADMIN_KEY,got=request.headers.get('authorization');
 if(typeof key!=='string'||key.length<32||!got||got.length!==key.length+7)return false;
 const expected='Bearer '+key;let diff=0;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^got.charCodeAt(i);return diff===0;
}
const text=(x,max,required=false)=>typeof x==='string'&&x.length<=max&&!/[\u0000-\u0008\u000b-\u001f]/.test(x)&&(!required||x.trim())?x.trim():null;
const numbers=['cooldown','playerIframes','ballIframes','duration','range','chargeTime'];
const strings={name:120,kit:80,input:80,condition:600,effect:1500,notes:1500,evidence:500};
export function validateAbility(body,now=new Date()){
 if(!body||typeof body!=='object'||Array.isArray(body)||!Number.isSafeInteger(body.revision)||body.revision<0||body.revision>=1000000)return null;
 if(typeof body.archived!=='boolean')return null;
 const out={archived:body.archived};
 for(const [key,max] of Object.entries(strings)){const value=text(body[key]??'',max,key==='name'||key==='kit');if(value===null)return null;out[key]=value;}
 for(const key of numbers){const value=body[key]??null;if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100000))return null;out[key]=value;}
 const date=body.testedOn;if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>now.toISOString().slice(0,10)||date<'2024-01-01')return null;
 out.testedOn=date;
 if(out.evidence){try{const u=new URL(out.evidence);if(u.protocol!=='https:'||u.username||u.password)return null;}catch{return null;}}
 return out;
}
function decode(row){return {...JSON.parse(row.data),id:row.ability_id,revision:row.revision,updatedAt:row.updated_at};}
const latestSql='SELECT ability_id,revision,data,updated_at FROM wiki_ability_revisions r WHERE style=? AND revision=(SELECT MAX(revision) FROM wiki_ability_revisions WHERE style=r.style AND ability_id=r.ability_id) ORDER BY ability_id LIMIT 501';
export async function wikiFetch(req,env){
 const p=new URL(req.url).pathname;if(!p.startsWith('/api/wiki/'))return null;
 const admin=p.startsWith('/api/wiki/admin/');
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 if(admin){const origin=req.headers.get('origin');if(origin&&origin!==ORIGIN)return error('Invalid origin',403);if(!env.TECH_ADMIN_KEY||env.TECH_ADMIN_KEY.length<32)return error('Editor not configured',503);if(!authorized(req,env))return error('Not authorized',403);}
 if(!env.CUSTOMS_DB)return error('Database unavailable',503);
 const db=env.CUSTOMS_DB;
 try{
  if(p==='/api/wiki/admin/session'&&req.method==='GET'){await db.prepare('SELECT 1 FROM wiki_ability_revisions LIMIT 1').all();return json({authorized:true});}
  const publicMatch=p.match(/^\/api\/wiki\/styles\/([a-z0-9-]+)$/);
  const adminMatch=p.match(/^\/api\/wiki\/admin\/styles\/([a-z0-9-]+)(?:\/([a-zA-Z0-9-]+)(\/history)?)?$/);
  const m=publicMatch||adminMatch;if(!m||!STYLES.has(m[1]))return error('Unknown style or route',404);
  const style=m[1],id=adminMatch?.[2],history=adminMatch?.[3];
  if(id&&!ID.test(id))return error('Invalid ability ID',400);
  if(req.method==='GET'&&!id){
   const result=await db.prepare(latestSql).bind(style).all();
   const entries=(result.results||[]).map(decode);
   return json({entries:admin?entries:entries.filter(r=>!r.archived)});
  }
  if(admin&&id&&history&&req.method==='GET'){
   const rows=await db.prepare('SELECT ability_id,revision,data,updated_at FROM wiki_ability_revisions WHERE style=? AND ability_id=? ORDER BY revision DESC LIMIT 100').bind(style,id).all();
   return json({entries:(rows.results||[]).map(decode)});
  }
  if(admin&&id&&!history&&req.method==='PUT'){
   if(Number(req.headers.get('content-length')||0)>16000)return error('Record too large',413);
   const raw=await req.text();if(new TextEncoder().encode(raw).length>16000)return error('Record too large',413);
   let body;try{body=JSON.parse(raw);}catch{return error('Invalid JSON',400);}
   const entry=validateAbility(body);if(!entry)return error('Check name, kit, tested date, numeric values, and evidence URL',400);
   // Atomic compare-and-insert: never silently overwrite another editor's revision.
   const result=await db.prepare('INSERT INTO wiki_ability_revisions(style,ability_id,revision,data) SELECT ?,?,?,? WHERE (SELECT COALESCE(MAX(revision),0) FROM wiki_ability_revisions WHERE style=? AND ability_id=?)=? AND (? > 0 OR (SELECT COUNT(DISTINCT ability_id) FROM wiki_ability_revisions WHERE style=?)<500)').bind(style,id,body.revision+1,JSON.stringify(entry),style,id,body.revision,body.revision,style).run();
   if(result.meta?.changes!==1)return error('Record changed or style limit reached. Reload before publishing.',409);
   return json({ok:true,entry:{...entry,id,revision:body.revision+1}});
  }
  return error('Method not allowed',405);
 }catch(e){console.error('Wiki DB operation failed',String(e?.message||e).slice(0,160));return error('Wiki database unavailable; check migration 0011',503);}
}
