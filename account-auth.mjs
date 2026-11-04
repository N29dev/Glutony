// Optional Roblox OAuth login for blr.n29.kz. No Roblox tokens are persisted.
// Route /auth/roblox/* and /api/account/* on blr.n29.kz to this Worker.
// Never store Client Secret in GitHub. Configure ROBLOX_CLIENT_SECRET and N29_SESSION_SECRET as Worker secrets.
const ORIGIN = 'https://blr.n29.kz';
const CALLBACK = ORIGIN + '/auth/roblox/callback';
const OAUTH = 'https://apis.roblox.com/oauth/v1';
const te = new TextEncoder();
const td = new TextDecoder();
function b64(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function unb64(s) {
  const raw = atob(s.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-s.length%4)%4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
const random = size => b64(crypto.getRandomValues(new Uint8Array(size)));
async function key(secret) { return crypto.subtle.importKey('raw',te.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']); }
async function sign(data,secret) {
  const payload=b64(te.encode(JSON.stringify(data)));
  const mac=b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),te.encode(payload))));
  return payload+'.'+mac;
}
async function verify(token,secret) {
  if(!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const [payload,mac]=token.split('.');
  const ok=await crypto.subtle.verify('HMAC',await key(secret),unb64(mac),te.encode(payload)).catch(()=>false);
  if(!ok)return null;
  const data=JSON.parse(td.decode(unb64(payload)));
  return data && typeof data.exp==='number' && data.exp>Date.now() ? data : null;
}
function cookies(request) {
  const out={};
  for(const part of (request.headers.get('cookie')||'').split(';')){
    const at=part.indexOf('='); if(at>0)out[part.slice(0,at).trim()]=part.slice(at+1).trim();
  }
  return out;
}
const cookie=(name,value,age,path='/')=>name+'='+value+'; Path='+path+'; Max-Age='+age+'; HttpOnly; Secure; SameSite=Lax';
function redirect(location, setCookies=[]) {
  const headers=new Headers({'location':location,'cache-control':'no-store','referrer-policy':'no-referrer'});
  for(const c of setCookies)headers.append('set-cookie',c);
  return new Response(null,{status:302,headers});
}
function json(data,status=200) {
  return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
}
function ready(env) {
  return /^\d{10,25}$/.test(env.ROBLOX_CLIENT_ID||'') &&
    typeof env.ROBLOX_CLIENT_SECRET==='string' && env.ROBLOX_CLIENT_SECRET.length>10 &&
    typeof env.N29_SESSION_SECRET==='string' && env.N29_SESSION_SECRET.length>=32;
}
function safeProfile(data) {
  const id=String(data?.sub||'');
  if(!/^\d{1,22}$/.test(id))throw Error('Invalid Roblox account ID');
  const text=(v,n)=>typeof v==='string'?v.slice(0,n):'';
  return {id,username:text(data.preferred_username,60),displayName:text(data.name,80),
    avatar:typeof data.picture==='string'&&/^https:\/\//.test(data.picture)?data.picture:null,
    profileUrl:'https://www.roblox.com/users/'+id+'/profile'};
}
// Session authentication for other same-origin account endpoints.
export async function accountProfile(request, env) {
  if (!env.N29_SESSION_SECRET) return null;
  const session = await verify(cookies(request).n29_session, env.N29_SESSION_SECRET).catch(() => null);
  return session?.profile || null;
}

export async function accountFetch(request,env) {
  const url=new URL(request.url);
  const path=url.pathname;
  if(!path.startsWith('/auth/roblox/') && path!=='/auth/logout' && path!=='/api/account/me')return null;
  if(url.origin!==ORIGIN) return json({error:'Use blr.n29.kz for account endpoints.'},400);
  if(path==='/api/account/me') {
    if(!env.N29_SESSION_SECRET)return json({authenticated:false});
    const data=await verify(cookies(request).n29_session,env.N29_SESSION_SECRET).catch(()=>null);
    return json(data?.profile?{authenticated:true,profile:data.profile}:{authenticated:false});
  }
  if(path==='/auth/logout') {
    // GET logout is safe: it only clears this site's session, without touching Roblox.
    return redirect('/servers/',[cookie('n29_session','',0)]);
  }
  if(!ready(env))return json({error:'Roblox sign-in is not configured.'},503);
  if(path==='/auth/roblox/start') {
    try {
    const state=random(24), verifier=random(32), nonce=random(24);
    const challenge=b64(new Uint8Array(await crypto.subtle.digest('SHA-256',te.encode(verifier))));
    const pending=await sign({state,verifier,nonce,exp:Date.now()+600000},env.N29_SESSION_SECRET);
    const auth=new URL(OAUTH+'/authorize');
    for(const [k,v] of Object.entries({client_id:env.ROBLOX_CLIENT_ID,response_type:'code',
      redirect_uri:CALLBACK,scope:'openid profile',state,nonce,code_challenge:challenge,code_challenge_method:'S256'}))
      auth.searchParams.set(k,v);
    return redirect(auth.toString(),[cookie('n29_oauth',pending,600,'/auth/roblox/')]);
    } catch(error) {
      console.error('Roblox OAuth initiation failed:', error?.stack || String(error));
      return json({error:'Roblox sign-in failed to initialize. Check Glutony Worker logs.',code:'oauth_start_exception'},503);
    }
  }
  if(path==='/auth/roblox/callback') {
    const clearing=cookie('n29_oauth','',0,'/auth/roblox/');
    const pending=await verify(cookies(request).n29_oauth,env.N29_SESSION_SECRET).catch(()=>null);
    if(!pending || !url.searchParams.get('state') || pending.state!==url.searchParams.get('state') ||
       !url.searchParams.get('code') || url.searchParams.get('error'))return redirect('/servers/?login=failed',[clearing]);
    try{
      const body=new URLSearchParams({client_id:env.ROBLOX_CLIENT_ID,
        client_secret:env.ROBLOX_CLIENT_SECRET,grant_type:'authorization_code',
        code:url.searchParams.get('code'),code_verifier:pending.verifier,redirect_uri:CALLBACK});
      const tokenResp=await fetch(OAUTH+'/token',{method:'POST',
        headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString(),
        signal:AbortSignal.timeout(10000)});
      if(!tokenResp.ok)throw Error('Roblox token exchange failed: '+tokenResp.status);
      const tokens=await tokenResp.json();
      if(typeof tokens.access_token!=='string')throw Error('Missing access token');
      const profileResp=await fetch(OAUTH+'/userinfo',{headers:{authorization:'Bearer '+tokens.access_token},
        signal:AbortSignal.timeout(10000)});
      if(!profileResp.ok)throw Error('Roblox userinfo failed: '+profileResp.status);
      const profile=safeProfile(await profileResp.json());
      // Short-lived signed session, containing only the public Roblox profile.
      const session=await sign({profile,exp:Date.now()+12*3600*1000},env.N29_SESSION_SECRET);
      return redirect('/servers/?login=success',[clearing,cookie('n29_session',session,43200)]);
    }catch(err){
      console.error('Roblox OAuth callback failed:',String(err?.message||err));
      return redirect('/servers/?login=failed',[clearing]);
    }
  }
  return json({error:'Not found'},404);
}
