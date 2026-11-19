/* ClassPulse: dedicated opt-in web push worker, no cache interception. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let message={};
  try{message=event.data?.json()||{};}catch{message={};}
  const title=typeof message.title==='string'?message.title:'ClassPulse class update';
  const body=typeof message.body==='string'?message.body:'A new academic update is available.';
  const kind=typeof message.kind==='string'?message.kind:'class';
  const url=typeof message.url==='string'&&message.url.startsWith('/')?message.url:'/?view=Notifications';
  const options={
    body,tag:'cp-'+kind+'-'+Date.now(),renotify:true,
    icon:'/resources/classpulse-symbol.svg',
    badge:'/resources/classpulse-symbol.svg',
    data:{url},vibrate:[180,90,180],
  };
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=new URL(event.notification.data?.url||'/',self.location.origin).href;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>client.url.startsWith(self.location.origin));
    if(existing){await existing.navigate(url);return existing.focus();}
    return self.clients.openWindow(url);
  })());
});
