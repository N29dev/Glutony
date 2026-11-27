// Read-only, bounded inspection of asset-reference properties in RBXM/RBXMX.
// Format reference: https://dom.rojo.space/binary.html
// No scripts, arbitrary numbers, names, or free-form strings become grants.
const MAX_BYTES=12*1024*1024,MAX_EXPANDED=24*1024*1024;
const DECODER=new TextDecoder();
const visualClasses=new Set(['MeshPart','SpecialMesh','FileMesh','DataModelMesh','Decal','Texture','Shirt','Pants','ShirtGraphic','SurfaceAppearance','WrapLayer','WrapTarget','CharacterMesh','Part']);
const meshProps=new Set(['meshid','meshcontent','basemeshid','basemeshcontent','cagemeshid','cagemeshcontent','referencemeshid','referencemeshcontent']);
const textureProps=new Set(['texture','textureid','texturecontent','shirtTemplate'.toLowerCase(),'pantstemplate','graphic','colormap','colormapcontent','normalmap','normalmapcontent','metalnessmap','metalnessmapcontent','roughnessmap','roughnessmapcontent','overlaytextureid','basetextureid','alphamap','alphamapcontent']);
function roleFor(cls,prop){
 if(!visualClasses.has(cls))return null;
 const p=prop.toLowerCase();return meshProps.has(p)?'mesh':textureProps.has(p)?'texture':null;
}
function assetId(value){
 const m=String(value).trim().match(/^(?:rbxassetid:\/\/|https?:\/\/(?:www\.)?roblox\.com\/asset\/?\?id=|https:\/\/assetdelivery\.roblox\.com\/v[12]\/asset\/?\?id=)([1-9][0-9]{0,15})$/i);
 return m?.[1]||null;
}
function lz4(input,size){
 const out=new Uint8Array(size);let a=0,b=0;
 const extend=base=>{let v=base;if(base===15){let n;do{if(a>=input.length)throw Error('Truncated LZ4');n=input[a++];v+=n;if(v>size)throw Error('LZ4 limit')}while(n===255)}return v};
 while(a<input.length){
  const token=input[a++],lit=extend(token>>>4);
  if(a+lit>input.length||b+lit>size)throw Error('Invalid LZ4 literal');
  out.set(input.subarray(a,a+lit),b);a+=lit;b+=lit;
  if(a===input.length)break;
  if(a+2>input.length)throw Error('Truncated LZ4 offset');
  const off=input[a]|input[a+1]<<8;a+=2;if(!off||off>b)throw Error('Invalid LZ4 offset');
  const len=extend(token&15)+4;if(b+len>size)throw Error('Invalid LZ4 match');
  for(let j=0;j<len;j++){out[b]=out[b-off];b++}
 }
 if(b!==size)throw Error('LZ4 size mismatch');return out;
}
function reader(data){
 const v=new DataView(data.buffer,data.byteOffset,data.byteLength);let pos=0;
 function take(n){if(!Number.isSafeInteger(n)||n<0||pos+n>data.length)throw Error('Invalid asset chunk');const start=pos;pos+=n;return data.subarray(start,pos)}
 return {u32(){const a=pos;take(4);return v.getUint32(a,true)},u8(){return take(1)[0]},skip:take,str(){const n=this.u32();if(n>1024*1024)throw Error('Property too large');return DECODER.decode(take(n))}};
}
export function collectAvatarReferences(bytes,zstd){
 if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);
 if(bytes.length>MAX_BYTES)throw Error('Asset too large');
 const refs=new Map();
 const add=(v,role)=>{const id=assetId(v);if(!id)return;if(refs.size>=128&&!refs.has(id))throw Error('Too many asset references');const prior=refs.get(id);if(!prior)refs.set(id,role);else if(prior!==role)refs.set(id,'ambiguous')};
 const head=DECODER.decode(bytes.subarray(0,14));
 if(head.startsWith('<roblox!')){
  if(bytes.length<32||bytes[8]!==0x89||bytes[9]!==0xff)throw Error('Invalid RBXM header');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),classes=new Map();let pos=32,total=0,count=0,ended=false;
  while(pos+16<=bytes.length){
   if(++count>4096)throw Error('Too many RBXM chunks');
   const name=DECODER.decode(bytes.subarray(pos,pos+4)),packed=view.getUint32(pos+4,true),size=view.getUint32(pos+8,true);pos+=16;
   const length=packed||size;if(pos+length>bytes.length||size>MAX_EXPANDED||(total+=size)>MAX_EXPANDED)throw Error('RBXM size limit');
   const raw=bytes.subarray(pos,pos+length);pos+=length;
   if(name==='END\0'){ended=true;break}
   if(name!=='INST'&&name!=='PROP')continue;
   let data=raw;
   if(packed){
    if(raw[0]===0x28&&raw[1]===0xb5&&raw[2]===0x2f&&raw[3]===0xfd){if(typeof zstd!=='function')throw Error('Zstandard unavailable');data=zstd(raw,new Uint8Array(size))}
    else data=lz4(raw,size);
    if(data.length!==size)throw Error('RBXM decompression size mismatch');
   }
   const r=reader(data),cls=r.u32();
   if(name==='INST'){const className=r.str();r.u8();const n=r.u32();if(n>10000)throw Error('Instance limit');classes.set(cls,{className,n});continue}
   const prop=r.str(),type=r.u8(),c=classes.get(cls),role=roleFor(c?.className,prop);if(!role)continue;
   if(type===1){for(let i=0;i<c.n;i++)add(r.str(),role)}
   else if(type===0x22){r.skip(c.n*4);const n=r.u32();if(n>c.n)throw Error('Content URI limit');for(let i=0;i<n;i++)add(r.str(),role)}
  }
  if(!ended)throw Error('RBXM missing end');
 }else if(/^\s*(?:<\?xml[^>]*>\s*)?<roblox(?:\s|>)/i.test(DECODER.decode(bytes.subarray(0,256)))){
  // Only Content or legacy String properties within explicitly supported visual
  // classes. Reject XML entities/DTD and do not parse script or free-form values.
  const xml=DECODER.decode(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('Unsupported XML');
  const stack=[];const tokens=/<Item\b[^>]*\bclass\s*=\s*["']([A-Za-z0-9_]+)["'][^>]*>|<\/Item\s*>|<(Content|ContentId|string)\s+name=["']([A-Za-z0-9_]+)["']\s*>([\s\S]*?)<\/\2\s*>/gi;
  for(const m of xml.matchAll(tokens)){
   if(m[1]){if(stack.length>=128)throw Error('XML depth limit');stack.push(m[1]);continue}
   if(/^<\/Item/i.test(m[0])){stack.pop();continue}
   const role=roleFor(stack.at(-1),m[3]);if(!role)continue;
   const value=m[4].trim().replace(/^<url>\s*([\s\S]*?)\s*<\/url>$/i,'$1').replaceAll('&amp;','&');
   add(value,role);
  }
 }else throw Error('Not an RBXM/RBXMX model');
 return [...refs].filter(([,role])=>role!=='ambiguous').map(([id,role])=>({id,role}));
}
