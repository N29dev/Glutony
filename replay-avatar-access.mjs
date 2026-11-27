import {decompress} from 'fzstd';
import {collectAvatarReferences} from './replay-avatar-dependencies.mjs';
// Only avatar item types that can contribute to a static character.
const roots=new Set([2,8,11,12,17,18,27,28,29,30,31,41,42,43,44,45,46,47,64,65,66,67,68,69,70,71,72,76,77,79]);
const valid=v=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/.test(v);
const pending=new Map(),budget=new Map();
let globalWindow=0,globalCount=0;
const limit=12*1024*1024;
const synthetic=(namespace,id)=>new Request('https://glutony.scp343hey.workers.dev/__replay_avatar_cache__/'+namespace+'/'+encodeURIComponent(id));
async function readCache(ns,id){const r=await caches.default.match(synthetic(ns,id));return r?await r.json():null}
async function saveCache(ns,id,data,seconds){await caches.default.put(synthetic(ns,id),new Response(JSON.stringify(data),{headers:{'Cache-Control':'public, max-age='+seconds,'Content-Type':'application/json'}}))}
function single(key,fn){if(pending.has(key))return pending.get(key);const p=Promise.resolve().then(fn).finally(()=>pending.delete(key));pending.set(key,p);return p}
function reserve(ip){
 const now=Date.now(),window=Math.floor(now/60000);
 if(globalWindow!==window){globalWindow=window;globalCount=0;budget.clear()}
 if(globalCount>=240)return false;
 const used=budget.get(ip)||0;if(used>=100)return false;
 budget.set(ip,used+1);globalCount++;return true;
}
async function json(url,options={}){
 const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(9000)});
 if(!r.ok){await r.body?.cancel();throw Object.assign(Error('Upstream '+r.status),{status:r.status})}
 return r.json();
}
async function outfit(id){
 return single('outfit:'+id,async()=>{
  const cached=await readCache('outfit-v1',id);if(cached)return cached;
  const d=await json('https://avatar.roblox.com/v4/avatar/users/'+id+'?selectionTypes=0&selectionTypes=1&selectionTypes=2&selectionTypes=3&selectionTypes=4&selectionTypes=5&selectionTypes=6');
  const list=d?.avatarModel?.assets;if(!Array.isArray(list)||list.length>80)throw Error('Invalid public outfit');
  const found={};for(const a of list){const id=String(a.id);if(valid(id)&&roots.has(Number(a.assetType?.id)))found[id]=Number(a.assetType.id)}
  await saveCache('outfit-v1',id,found,900);return found;
 });
}
async function metadata(id){
 return single('meta:'+id,async()=>{
  const hit=await readCache('meta-v1',id);if(hit)return hit;
  const d=await json('https://economy.roblox.com/v2/assets/'+id+'/details');
  if(String(d.AssetId)!==id||!Number.isInteger(d.AssetTypeId))throw Error('Invalid asset metadata');
  const creator=d.Creator,owner=String(creator?.CreatorTargetId??creator?.Id??''),kind=creator?.CreatorType;
  if(!valid(owner)||!['User','Group'].includes(kind))throw Error('Unknown asset creator');
  const result={type:d.AssetTypeId,owner:kind+':'+owner,publicDomain:d.IsPublicDomain===true};
  await saveCache('meta-v1',id,result,3600);return result;
 });
}
function safeLocation(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&/^[a-z0-9-]+\.rbxcdn\.com$/.test(u.hostname)&&u.href.length<=2048?u.href:null}catch{return null}
}
async function boundedBytes(url){
 const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw Error('CDN '+r.status);
 if(Number(r.headers.get('Content-Length'))>limit)throw Error('Asset size limit');
 const reader=r.body?.getReader();if(!reader)throw Error('Empty asset');
 const chunks=[];let n=0;try{while(true){const a=await reader.read();if(a.done)break;n+=a.value.length;if(n>limit){await reader.cancel();throw Error('Asset size limit')}chunks.push(a.value)}}finally{reader.releaseLock()}
 const data=new Uint8Array(n);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.length}return data;
}
async function openCloud(url,format,env){
 const id=url.searchParams.get('id'),target=new URL('https://apis.roblox.com/asset-delivery-api/v1/assetId/'+id);
 const representation=url.searchParams.get('contentRepresentationPriorityList');if(representation)target.searchParams.set('contentRepresentationPriorityList',representation.replaceAll(' ','+'));
 const headers={'x-api-key':env.ROBLOX_ASSET_API_KEY,Accept:'application/json'};
 if(format)headers['Roblox-AssetFormat']=format;
 const d=await json(target.href,{headers});
 const values=Array.isArray(d.locations)?d.locations:typeof d.location==='string'?[{location:d.location}]:[];
 const locations=values.map(x=>safeLocation(x.location)).filter(Boolean).map(location=>({location}));
 if(!locations.length)throw Error('Missing asset download location');
 return locations;
}
async function verifiedCreator(rootOwner,depOwner){
 if(rootOwner===depOwner||rootOwner==='User:1')return true;
 if(!rootOwner.startsWith('Group:')||!depOwner.startsWith('User:'))return false;
 const group=rootOwner.slice(6),user=depOwner.slice(5);
 if(!valid(group)||!valid(user))return false;
 return single('group-owner:'+group,async()=>{
  let owner=await readCache('group-owner-v1',group);
  if(!owner){const d=await json('https://groups.roblox.com/v1/groups/'+group);if(String(d.id)!==group)return false;owner={id:String(d.owner?.userId||'')};await saveCache('group-owner-v1',group,owner,900)}
  return owner;
 }).then(async owner=>{
  if(owner?.id===user)return true;
  // Public role membership can identify a group's catalog collaborators.
  // Ordinary members are not sufficient: require a privileged creative role.
  const cacheId=group+'/'+user;
  return single('group-collaborator:'+cacheId,async()=>{
   const hit=await readCache('group-collaborator-v1',cacheId);
   if(hit)return hit.allowed===true;
   const d=await json('https://groups.roblox.com/v2/users/'+user+'/groups/roles');
   const r=Array.isArray(d.data)?d.data.find(v=>String(v.group?.id)===group)?.role:null;
   const allowed=!!r&&Number.isInteger(r.rank)&&r.rank>1&&(r.rank>=200||/\b(?:developer|designer|creator|ugc|artist|builder|uploader|admin|owner|manager)\b/i.test(String(r.name||'')));
   await saveCache('group-collaborator-v1',cacheId,{allowed},900);
   return allowed;
  });
 }).catch(()=>false);
}
async function grantFor(userId,id){
 const list=await outfit(userId);
 if(Object.hasOwn(list,id)){
  const m=await metadata(id);
  if(m.type!==list[id]||!roots.has(m.type))return null;
  return {root:id,owner:m.owner,role:'root',depth:0,type:m.type};
 }
 const direct=await readCache('grant-v1',userId+'/'+id);
 const candidates=[];if(direct&&Object.hasOwn(list,direct.root)&&direct.depth<=2)candidates.push(direct);
 // Reuse verified references when different players equip the same catalog item.
 if(!candidates.length){
  const manifests=await Promise.all(Object.keys(list).map(root=>readCache('manifest-v1',root)));
  for(const manifest of manifests){if(!manifest||!Object.hasOwn(list,manifest.root))continue;const ref=manifest.refs?.find(r=>r.id===id);if(ref)candidates.push({root:manifest.root,owner:manifest.owner,role:ref.role,depth:1})}
 }
 if(!candidates.length)throw Object.assign(Error('No parsed visual reference for this outfit'),{status:403});
 const m=await metadata(id);
 // Roblox-owned catalog roots can reference meshes uploaded by a different creator.
 // This exception still requires a parsed reference and a matching visual asset type.
 for(const g of candidates){if(!m.publicDomain&&!await verifiedCreator(g.owner,m.owner))continue;if(g.role==='mesh'&&m.type!==4)continue;if(g.role==='texture'&&![1,13].includes(m.type))continue;return {...g,type:m.type};}
 const g=candidates[0];throw Object.assign(Error('Dependency '+g.role+' type '+m.type+' root '+g.root+' creator '+g.owner+' vs '+m.owner),{status:403});
}
async function recordReferences(userId,g,locations){
 if(g.depth>=2||g.role==='mesh'||g.type===1)return;
 // Inspect the same representation that will be supplied to the renderer.
 const bytes=await boundedBytes(locations[0].location);
 const refs=collectAvatarReferences(bytes,decompress);
 if(g.depth===0){const existing=await readCache('manifest-v1',g.root);const merged=new Map((existing?.owner===g.owner?existing.refs:[]).map(r=>[r.id,r]));for(const r of refs)merged.set(r.id,r);if(merged.size>256)throw Error('Avatar manifest limit');await saveCache('manifest-v1',g.root,{root:g.root,owner:g.owner,refs:[...merged.values()]},900)}
 await Promise.all(refs.filter(r=>r.id!==g.root).map(async r=>{
  const existing=await readCache('grant-v1',userId+'/'+r.id);
  if(existing&&existing.root===g.root&&existing.depth<=g.depth+1)return;
  await saveCache('grant-v1',userId+'/'+r.id,{root:g.root,owner:g.owner,role:r.role,depth:g.depth+1},900);
 }));
}
export async function resolveReplayAvatarAsset(request,url,format,env){
 const userId=new URL(request.url).searchParams.get('userId'),id=url.searchParams.get('id');
 if(!env.ROBLOX_ASSET_API_KEY||!valid(userId)||!valid(id)||url.searchParams.has('version'))return {status:403,error:'No authorized avatar context'};
 // Cache only a short-lived location; permissions are checked before using it.
 const cacheId=userId+'/'+id+'/'+format+'/'+(url.searchParams.get('contentRepresentationPriorityList')||'');
 return single('resolve:'+cacheId,async()=>{
  try{
   const g=await grantFor(userId,id);if(!g)return {status:403,error:'Asset is not a verified visual dependency of this public outfit'};
   const cached=await readCache('location-v1',cacheId);if(cached)return {status:200,locations:cached};
   if(!reserve(request.headers.get('CF-Connecting-IP')||'unknown'))return {status:429,error:'Avatar request budget exceeded; retry shortly'};
   const locations=await openCloud(url,format,env);
   await recordReferences(userId,g,locations);
   await saveCache('location-v1',cacheId,locations,60);
   return {status:200,locations};
  }catch(e){return {status:[401,403,404,429].includes(e.status)?(e.status===401?403:e.status):502,error:'Avatar dependency lookup: '+String(e.message).slice(0,120)}}
 });
}
