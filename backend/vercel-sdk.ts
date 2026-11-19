import {createClient,type SupabaseClient} from '@supabase/supabase-js';
import {randomUUID} from 'node:crypto';
import type {VercelRequest,VercelResponse} from '@vercel/node';

type User={userId:string;email?:string;name?:string;signupRole?:'Student'|'Faculty';studentNumber?:string};
type Context={user?:User;body:unknown;params:Record<string,string>;bearer?:string};
type Reply={__cp:true;status:number;payload:unknown};
export type RouterMiddleware=(ctx:Context)=>Promise<Reply|void>|Reply|void;
type Op={kind:'add'|'update'|'delete';table:string;items:any[];patch?:boolean};
let server:SupabaseClient|null=null;
function service(){
  const url=(process.env.SUPABASE_URL||process.env.VITE_SUPABASE_URL||'').trim();
  const key=(process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
  if(!url||!key)throw Error('Supabase backend environment is not configured');
  return server||(server=createClient(url,key,{
    auth:{autoRefreshToken:false,persistSession:false},
  }));
}
async function perform(operations:Op[]):Promise<any[]>{
  if(!operations.length)return [];
  const {data,error}=await service().rpc('cp_apply_batch',{operations});
  if(error)throw Error('Database transaction failed: '+error.message);
  if(!Array.isArray(data))throw Error('Database returned an invalid transaction result');
  return data;
}
function operation(op:Op){
  const run=()=>perform([op]).then(result=>result[0]||[]);
  return {...op,
    then:(yes?:((value:any[])=>unknown)|null,no?:((err:unknown)=>unknown)|null)=>
      run().then(yes,no),
    catch:(no:(err:unknown)=>unknown)=>run().catch(no),
  };
}
export const db={
  async list<T>(table:string,{limit=160}:{limit?:number}={}){
    const {data,error}=await service().from('cp_records').select('id,data')
      .eq('table_name',table).order('updated_at',{ascending:false})
      .limit(Math.max(1,Math.min(1000,limit)));
    if(error)throw Error(error.message);
    return {items:(data||[]).map(row=>({...row.data,id:row.id})) as Array<T&{id:string}>};
  },
  async get<T>(table:string,ids:string[],_options?:{consistent?:boolean}){
    if(!ids.length)return [] as Array<T|null>;
    const {data,error}=await service().from('cp_records').select('id,data')
      .eq('table_name',table).in('id',ids);
    if(error)throw Error(error.message);
    const byId=new Map((data||[]).map(row=>[row.id,{...row.data,id:row.id}]));
    return ids.map(id=>(byId.get(id)||null) as T|null);
  },
  async add(table:string,records:Record<string,unknown>[]){
    const result=await perform([{kind:'add',table,items:records.map(r=>({
      id:(r.id as string)||randomUUID(),record:r,
    }))}]);
    return result[0]||[];
  },
  async delete(table:string,ids:string[]){
    const result=await perform([{kind:'delete',table,items:ids.map(id=>({id}))}]);
    return result[0]||[];
  },
  tx:{
    add(table:string,records:Record<string,unknown>[]){
      return operation({kind:'add',table,items:records.map(r=>({
        id:(r.id as string)||randomUUID(),record:r,
      }))});
    },
    update(table:string,items:Array<{id:string;record:Record<string,unknown>;if?:Record<string,unknown>}>,options?:{patch?:boolean}){
      return operation({kind:'update',table,items,patch:options?.patch!==false});
    },
    delete(table:string,ids:string[]){
      return operation({kind:'delete',table,items:ids.map(id=>({id}))});
    },
  },
  transact(items:any[]){
    return perform(items.map(o=>({kind:o.kind,table:o.table,items:o.items,patch:o.patch})));
  },
};
const bucket='classpulse-files';
export const storage={
  async write(items:Array<{path:string;content:string;contentType:string}>){
    const results:boolean[]=[];
    for(const item of items){
      const buffer=Buffer.from(item.content,'base64');
      if(buffer.length>3_300_000)throw Error('Uploaded file is too large');
      const {error}=await service().storage.from(bucket).upload(item.path,buffer,{
        contentType:item.contentType,upsert:false,
      });
      if(error)throw Error(error.message);
      results.push(true);
    }
    return results;
  },
  async url(paths:string[]){
    return Promise.all(paths.map(async path=>{
      const {data,error}=await service().storage.from(bucket).createSignedUrl(path,300);
      if(error)throw Error(error.message);
      return {url:data.signedUrl};
    }));
  },
  async delete(paths:string[]){
    const {error}=await service().storage.from(bucket).remove(paths);
    if(error)throw Error(error.message);
    return true;
  },
};
export const notifications={
  async send(_payload:unknown){return {delivered:0,reason:'push-not-configured'};},
};
export const ws={
  async send(_ids:string[],_payload:unknown){return {delivered:0};},
};
export const json=(payload:unknown,status=200):Reply=>({__cp:true,status,payload});
export const error=(message:string,status=400):Reply=>({__cp:true,status,payload:{error:message}});
export function requireAuth():RouterMiddleware{
  return async ctx=>{
    if(!ctx.bearer)return error('Sign in to continue',401);
    const {data:{user},error:problem}=await service().auth.getUser(ctx.bearer);
    if(problem||!user||!user.email)return error('Invalid or expired session',401);
    const selectedRole=user.user_metadata?.classpulse_role;
    ctx.user={userId:user.id,email:user.email,
      name:String(user.user_metadata?.full_name||user.user_metadata?.name||''),
      signupRole:selectedRole==='Faculty'||selectedRole==='Student'?selectedRole:undefined,
      studentNumber:typeof user.user_metadata?.classpulse_campus_id==='string'
        ?user.user_metadata.classpulse_campus_id.slice(0,40):''};
  };
}
export function router(routes:Record<string,RouterMiddleware[]>){
  const entries=Object.entries(routes).map(([key,middleware])=>{
    const space=key.indexOf(' ');
    const method=key.slice(0,space);
    const names:string[]=[];
    const segments=key.slice(space+1).split('/');
    const source='^'+segments.map((part,i)=>{
      if(i===0)return '';
      if(part.startsWith(':')){names.push(part.slice(1));return '/([^/]+)';}
      return '/'+part.replace(/[\^$.*+?()[\]{}|\\]/g,'\\$&');
    }).join('')+'/?$';
    return {method,names,regex:new RegExp(source),middleware};
  });
  return async(req:VercelRequest,res:VercelResponse)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    // Vercel's plain Vite file router does not implement Next.js-style
    // "[...path]" multi-segment catch-alls. vercel.json rewrites every
    // /api/:path* URL to /api/index?cp_route=:path*, preserving the route here.
    const rewritten = req.query?.cp_route;
    const routeTail=Array.isArray(rewritten)?rewritten.join('/'):
      typeof rewritten==='string'?rewritten:'';
    const pathname=routeTail
      ? '/api/'+(routeTail.startsWith('/') ? routeTail.slice(1) : routeTail)
      : new URL(req.url||'/', 'https://classpulse.invalid').pathname;
    const method=(req.method||'GET').toUpperCase();
    const selected=entries.find(entry=>entry.method===method&&entry.regex.test(pathname));
    if(!selected){res.status(404).json({error:'API route not found'});return;}
    const matched=selected.regex.exec(pathname);
    const params:Record<string,string>={};
    selected.names.forEach((name,index)=>{
      try{params[name]=decodeURIComponent(matched?.[index+1]||'');}
      catch{params[name]='';}
    });
    const bearer=(req.headers.authorization||'').startsWith('Bearer ')
      ?(req.headers.authorization||'').slice(7):'';
    const ctx:Context={params,body:req.body||{},bearer};
    try{
      if((!process.env.SUPABASE_URL&&!process.env.VITE_SUPABASE_URL)||
        !process.env.SUPABASE_SERVICE_ROLE_KEY)
        throw Error('Supabase backend environment is not configured');
      let outcome:Reply|void=undefined;
      for(const item of selected.middleware){
        outcome=await item(ctx);
        if(outcome?.__cp)break;
      }
      if(!outcome)outcome=json({ok:true});
      res.status(outcome.status).json(outcome.payload);
    }catch(problem){
      const isConfig=problem instanceof Error&&problem.message.includes('environment is not configured');
      console.error('ClassPulse API error',{
        method,path:pathname,message:problem instanceof Error?problem.message:'Unknown',
      });
      res.status(isConfig?503:500).json({error:isConfig
        ?'Supabase has not been connected to this Vercel project':'Server request failed'});
    }
  };
}
