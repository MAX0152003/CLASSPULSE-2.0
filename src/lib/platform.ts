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
  if(!supabase)throw Error('ClassPulse sign-in is not configured. Connect the Supabase project to Vercel.');
  return supabase;
}
const validEmail=(email:string)=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
/**
 * Send confirmation and password recovery links to this app, never to
 * Supabase's localhost fallback. The origin is the actual Vercel host used
 * for registration; add your stable app domain and preview domains to the
 * Supabase Authentication redirect allow-list.
 */
export function authCallbackUrl(mode:'confirmed'|'reset'){
  const configured=(import.meta.env.VITE_AUTH_REDIRECT_URL||'').trim();
  let base:URL;
  try{base=new URL(configured||window.location.origin,window.location.origin);}
  catch{base=new URL(window.location.origin);}
  if(base.protocol!=='https:'&&base.hostname!=='localhost')throw Error('Secure HTTPS is required for account links.');
  base.pathname='/';
  base.search='';
  base.hash='';
  base.searchParams.set('auth',mode);
  return base.toString();
}
export const auth={
  async getUser():Promise<{userId:string;email?:string;name?:string}|null>{
    if(!supabase)return null;
    const {data:{session},error:sessionError}=await supabase.auth.getSession();
    if(sessionError)throw sessionError;
    if(!session)return null;
    const {data:{user},error}=await supabase.auth.getUser();
    if(error||!user)return null;
    return {userId:user.id,email:user.email,name:user.user_metadata?.full_name||user.user_metadata?.name};
  },
  async signUpWithPassword(values:{email:string;password:string;name:string}){
    const email=values.email.trim().toLowerCase();
    if(!validEmail(email))throw Error('Enter a valid email address.');
    if(values.password.length<8)throw Error('Use a password with at least 8 characters.');
    const {data,error}=await client().auth.signUp({
      email,password:values.password,
      options:{
        emailRedirectTo:authCallbackUrl('confirmed'),
        data:{full_name:values.name.trim()},
      },
    });
    if(error)throw error;
    return {signedIn:!!data.session,emailSent:!data.session};
  },
  async signInWithPassword(values:{email:string;password:string}){
    const email=values.email.trim().toLowerCase();
    if(!validEmail(email)||!values.password)throw Error('Enter your email address and password.');
    const {data,error}=await client().auth.signInWithPassword({email,password:values.password});
    if(error)throw error;
    if(!data.session)throw Error('Could not establish an authenticated session.');
    return true;
  },
  async resendConfirmation(email:string){
    const normalized=email.trim().toLowerCase();
    if(!validEmail(normalized))throw Error('Enter a valid email address.');
    const {error}=await client().auth.resend({
      type:'signup',email:normalized,
      options:{emailRedirectTo:authCallbackUrl('confirmed')},
    });
    if(error)throw error;
  },
  async resetPassword(email:string){
    const normalized=email.trim().toLowerCase();
    if(!validEmail(normalized))throw Error('Enter a valid email address.');
    const {error}=await client().auth.resetPasswordForEmail(normalized,{
      redirectTo:authCallbackUrl('reset'),
    });
    if(error)throw error;
  },
  async updatePassword(password:string){
    if(password.length<8)throw Error('Use a password with at least 8 characters.');
    const {error}=await client().auth.updateUser({password});
    if(error)throw error;
  },
  async signInWithRedirect(options:{provider:'google'|'apple'}){
    const {error}=await client().auth.signInWithOAuth({
      provider:options.provider,
      options:{redirectTo:authCallbackUrl('confirmed')},
    });
    if(error)throw error;
  },
  async signOut():Promise<void>{
    const {error}=await client().auth.signOut();
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
