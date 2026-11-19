import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const app=read('src/App.tsx'),api=read('backend/index.ts'),css=read('src/index.css');
const tests=JSON.parse(read('tests/tests.json'));
const sourceFiles=[
  ['src/App.tsx',ts.ScriptKind.TSX],
  ['src/offlineQueue.ts',ts.ScriptKind.TS],
  ['src/main.tsx',ts.ScriptKind.TSX],
  ['backend/index.ts',ts.ScriptKind.TS],
  ['vite.config.ts',ts.ScriptKind.TS],
];
let failed=false;
for(const [file,kind] of sourceFiles){
  const source=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,kind);
  const diagnostics=source.parseDiagnostics;
  if(diagnostics.length){
    failed=true;
    for(const d of diagnostics){
      const pos=source.getLineAndCharacterOfPosition(d.start||0);
      console.error(file+':'+(pos.line+1)+':'+(pos.character+1)+' '+ts.flattenDiagnosticMessageText(d.messageText,' '));
    }
  } else console.log('PASS parse '+file);
}
const cases={
 'Admin cannot create course sections':!api.includes("'POST /api/admin/section':"),
 'Admin cannot modify course sections':!api.includes("'POST /api/admin/section/:id/update':"),
 'Admin cannot rotate academic join codes':!api.includes("'POST /api/admin/section/:id/rotate-code':"),
 'Admin cannot change academic rooms':!api.includes("'POST /api/admin/rooms/:id/status':"),
 'Admin cannot import academic data':!api.includes("'POST /api/admin/import/commit':"),
 'Admin does not receive academic dashboard':api.includes("if(p.role==='System Administrator')return forbid('Use the system-health dashboard')"),
 'Admin cannot demote Faculty through Set Student':api.includes("if(role!=='Faculty'||!userId)")&&!app.includes(">Set Student</button>"),
 'Admin invitations are server restricted':api.includes("'POST /api/admin/invite': [requireAuth(),adminGuard"),
 'Student/Faculty invitations are server restricted':api.includes("'POST /api/admin/user-invites': [requireAuth(),adminGuard"),
 'Health endpoint is restricted':api.includes("'GET /api/admin/system-health': [requireAuth(),adminGuard"),
 'No hardcoded root admin email':api.includes("process.env.CLASSPULSE_ADMIN_EMAILS")&&!api.includes("farhanmakil15@gmail.com"),
 'System reports can be submitted and resolved':api.includes("'POST /api/system/issue':")&&api.includes("'POST /api/admin/system-issues/:id/resolve':"),
 'Uploaded scans do not imply real-time device status':api.includes('Devices that have not synchronized cannot be monitored live'),
 '12-hour offline QR validation preserved':api.includes('ageMs <= 12 * 60 * 60 * 1000'),
 'Gesture opens right-edge menu':app.includes('const navTouchStart=')&&app.includes('const navTouchEnd='),
 'Mobile landscape dock is right-aligned':css.includes('right:max(7px,env(safe-area-inset-right))'),
 'Landscape menu scrolls in one column':css.includes('grid-template-columns:minmax(0,1fr)!important')&&css.includes('scrollbar-width:none'),
 'Photo crop saved as JPEG':app.includes("canvas.toDataURL('image/jpeg'")&&app.includes('cp-photo-editor'),
 'Photo shown in header':app.includes('cp-header-photo'),
 'ID tap guide replaces switch buttons':app.includes('cp-card-guide')&&!app.includes('>Card front</button>'),
 'Notifications open details':app.includes("modal==='notification-detail'"),
 'Digital excuse letters support dark mode':css.includes(":root[data-theme='dark'] .cp-letter-paper{background:#1b2b2c!important"),
 'Accessible reduced motion preserved':css.includes('@media(prefers-reduced-motion:reduce)'),
 'Footer stays in document layout':css.includes('flex:1 0 auto')&&css.includes('.cp-footer{position:relative'),
 'QA suite keeps exactly one sanity case':tests.filter(x=>x.sanity===true).length===1,
 'QA suite remains 5 independent cases':tests.length===5,
};
for(const [label,pass] of Object.entries(cases)){
 console.log((pass?'PASS ':'FAIL ')+label);
 if(!pass)failed=true;
}
if(failed){console.error('Source verification failed');process.exitCode=1;}
else console.log('ClassPulse source verification passed ('+Object.keys(cases).length+' invariants).');
