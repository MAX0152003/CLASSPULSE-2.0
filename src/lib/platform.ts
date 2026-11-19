/**
 * ClassPulse platform adapter — Supabase Auth + Vercel Functions.
 * No AppDeploy imports, private credentials or fabricated records.
 */
import {createClient, type SupabaseClient} from '@supabase/supabase-js';

const url=(import.meta.env.VITE_SUPABASE_URL||'').trim();
const anonKey=(import.meta.env.VITE_SUPABASE_ANON_KEY||'').trim();
export const backendConfigured=!!(url&&anonKey);
export const supabase:SupabaseClient|null=backendConfigured
  ?createClient(url,anonKey,{
      auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},
    }):null;

function client():SupabaseClient{
  if(!supabase)throw Error('ClassPulse database and sign-in are not configured. Connect Supabase to the Vercel project.');
  return supabase;
}
export const auth={
  async getUser():Promise<{userId:string;email?:string;name?:string}|null>{
    if(!supabase)return null;
    const {data:{session}}=await supabase.auth.getSession();
    if(!session)return null;
    const {data:{user},error}=await supabase.auth.getUser();
    if(error||!user)return null;
    return {userId:user.id,email:user.email,name:user.user_metadata?.full_name||user.user_metadata?.name};
  },
  async signInWithRedirect(options?:{
    provider?:'google'|'apple'|'email';email?:string;
  }):Promise<{emailSent?:boolean}>{
    const authClient=client();
    const provider=options?.provider||'email';
    if(provider==='email'){
      const email=(options?.email||'').trim().toLowerCase();
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))throw Error('Enter your email address first.');
      const {error}=await authClient.auth.signInWithOtp({
        email,options:{emailRedirectTo:window.location.origin},
      });
      if(error)throw error;
      return {emailSent:true};
    }
    const {error}=await authClient.auth.signInWithOAuth({
      provider,
      options:{redirectTo:window.location.origin},
    });
    if(error)throw error;
    return {};
  },
  async signOut():Promise<void>{
    const active=client();
    const {error}=await active.auth.signOut();
    if(error)throw error;
  }
};

async function apiRequest(method:'GET'|'POST'|'PUT',path:string,body?:unknown){
  const active=client();
  if(!path.startsWith('/api/'))throw Error('Invalid API route');
  const {data:{session},error:sessionError}=await active.auth.getSession();
  if(sessionError)throw sessionError;
  const response=await fetch(path,{
    method,
    headers:{
      ...(session?{Authorization:'Bearer '+session.access_token}:{}),
      ...(method!=='GET'?{'Content-Type':'application/json'}:{}),
    },
    ...(method!=='GET'?{body:JSON.stringify(body??{})}:{}),
    credentials:'same-origin',
    cache:'no-store',
  });
  const text=await response.text();
  let data:unknown;
  try{data=text?JSON.parse(text):{};}catch{throw Error('Server returned an invalid response.');}
  if(!response.ok){
    const payload=data as {error?:string;message?:string};
    throw Error(payload?.error||payload?.message||('Request failed ('+response.status+')'));
  }
  return {data};
}
export const api={
  get:(path:string)=>apiRequest('GET',path),
  post:(path:string,body?:unknown)=>apiRequest('POST',path,body),
  put:(path:string,body?:unknown)=>apiRequest('PUT',path,body),
};

/** In-app notifications remain persisted in the ClassPulse database.
 * Web Push requires a separate service worker and VAPID configuration.
 */
export const notifications={
  async subscribe(){
    if(!('Notification' in window))throw Error('Notifications are unavailable in this browser.');
    throw Error('Web push has not been configured. In-app academic notifications still work.');
  }
};

/** Graceful fallback for the former AppDeploy WebSocket feature.
 * Realtime faculty data is refreshed by the dashboard poll in App.tsx.
 * Do not claim a persistent WebSocket or push delivery.
 */
export const ws={
  connect(){
    const callbacks:Array<(message:any)=>void>=[];
    const onOpenCallbacks:Array<()=>void>=[];
    return {
      connectionId:null as string|null,
      ready:Promise.resolve(),
      onMessage(callback:(message:any)=>void){
        callbacks.push(callback);
        return ()=>{const index=callbacks.indexOf(callback);if(index>=0)callbacks.splice(index,1);};
      },
      onOpen(callback:()=>void){
        onOpenCallbacks.push(callback);
        return ()=>{const index=onOpenCallbacks.indexOf(callback);if(index>=0)onOpenCallbacks.splice(index,1);};
      },
      disconnect(){callbacks.length=0;onOpenCallbacks.length=0;},
    };
  }
};
