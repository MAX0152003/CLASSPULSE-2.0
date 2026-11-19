/* Per-user encrypted local queue. Offline captures remain unverified until server acceptance. */
export type QueuedScan = {
  id:string; ownerId:string; capturedAt:string; token:string; attempts:number;
  retryAt:number; state:'PENDING'|'NEEDS_ATTENTION'; lastError:string;
};
type StoredScan = Omit<QueuedScan,'token'> & { iv:Uint8Array; ciphertext:ArrayBuffer };
type SavedKey = { name:string; key:CryptoKey };
const NAME='classpulse-offline-v2';
const VERSION=1;
function connection():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    if(!window.indexedDB || !window.crypto?.subtle) return reject(Error('Secure offline storage is not supported in this browser'));
    const req=indexedDB.open(NAME,VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('captures')){
        const s=db.createObjectStore('captures',{keyPath:'id'});
        s.createIndex('ownerId','ownerId',{unique:false});
      }
      if(!db.objectStoreNames.contains('keys'))db.createObjectStore('keys',{keyPath:'name'});
    };
    req.onerror=()=>reject(req.error || Error('Offline database unavailable'));
    req.onsuccess=()=>resolve(req.result);
  });
}
async function transact<T>(table:'captures'|'keys',mode:IDBTransactionMode,
  make:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const database=await connection();
  return new Promise<T>((resolve,reject)=>{
    let result:T;
    const tx=database.transaction(table,mode);
    tx.oncomplete=()=>{database.close();resolve(result);};
    tx.onabort=()=>{database.close();reject(tx.error||Error('Offline transaction aborted'));};
    tx.onerror=()=>{database.close();reject(tx.error||Error('Offline transaction failed'));};
    try{
      const request=make(tx.objectStore(table));
      request.onsuccess=()=>{result=request.result;};
      request.onerror=()=>{ /* transaction will surface failure */ };
    }catch(e){tx.abort();}
  });
}
async function deviceKey():Promise<CryptoKey> {
  const existing=await transact<SavedKey|undefined>('keys','readonly',s=>s.get('device'));
  if(existing?.key)return existing.key;
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  try{await transact('keys','readwrite',s=>s.put({name:'device',key}));}
  catch{return (await transact<SavedKey>('keys','readonly',s=>s.get('device'))).key;}
  return key;
}
const enc=new TextEncoder(),dec=new TextDecoder();
export async function storeQueuedScan(scan:QueuedScan):Promise<void>{
  const key=await deviceKey();
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const aad=enc.encode(scan.ownerId+':'+scan.id);
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,enc.encode(scan.token));
  const {token,...rest}=scan;
  await transact('captures','readwrite',s=>s.put({...rest,iv,ciphertext} as StoredScan));
}
export async function listQueuedScans(ownerId:string):Promise<QueuedScan[]> {
  const stored=await transact<StoredScan[]>('captures','readonly',s=>s.index('ownerId').getAll(ownerId));
  if(!stored.length)return [];
  const key=await deviceKey();
  const output:QueuedScan[]=[];
  for(const row of stored){
    const token=dec.decode(await crypto.subtle.decrypt({
      name:'AES-GCM',iv:row.iv,additionalData:enc.encode(row.ownerId+':'+row.id)
    },key,row.ciphertext));
    const {iv,ciphertext,...details}=row;
    output.push({...details,token});
  }
  return output.sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt));
}
export async function removeQueuedScan(id:string):Promise<void> {
  await transact('captures','readwrite',s=>s.delete(id));
}
export async function migrateOldScans(ownerId:string):Promise<void>{
  const oldKey='cp-live-offline-'+ownerId;
  const raw=localStorage.getItem(oldKey);
  if(!raw)return;
  const legacy=JSON.parse(raw) as Array<{id:string;capturedAt:string;token:string}>;
  if(!Array.isArray(legacy))return;
  for(const old of legacy){
    if(typeof old.id==='string'&&typeof old.capturedAt==='string'&&typeof old.token==='string')
      await storeQueuedScan({id:old.id,ownerId,capturedAt:old.capturedAt,token:old.token,
        attempts:0,retryAt:0,state:'PENDING',lastError:''});
  }
  localStorage.removeItem(oldKey);
}
export function nextRetry(attempts:number) {
  return Date.now()+Math.min(15*60_000,5000*2**Math.min(6,attempts))+Math.floor(Math.random()*3000);
}
