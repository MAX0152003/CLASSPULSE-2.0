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
  ['src/lib/platform.ts',ts.ScriptKind.TS],
  ['backend/vercel-sdk.ts',ts.ScriptKind.TS],
  ['api/index.ts',ts.ScriptKind.TS],
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
const platform=read('src/lib/platform.ts');
const adapter=read('backend/vercel-sdk.ts');
const apiFunction=read('api/index.ts');
const vercelConfig=JSON.parse(read('vercel.json'));
const databaseSql=read('supabase/schema.sql');
const cases={
  'No AppDeploy runtime imports in frontend':!app.includes("from '@appdeploy/client'"),
  'Swipe left opens navigation without hijacking the schedule deck':
    app.includes("if(!drawer&&dx<0)setDrawer(true)")&&
    app.includes("cp-deck-stage,.cp-deck-days")&&
    app.includes("body.style.position='fixed'")&&
    app.includes("removeEventListener('touchmove',preventBackground)"),
  'Photo editor has zoom, drag crop, and explicit save':
    app.includes("photoDragRef.current")&&app.includes("setPointerCapture(ev.pointerId)")&&
    app.includes("photoCropCanvas.current")&&app.includes("cp-photo-reset")&&
    app.includes("async function uploadPhoto()"),
  'First signed QR auto-enrolls atomically with pending faculty verification':
    api.includes("reason = !verifiedToken ? 'INVALID_SIGNATURE'")&&
    api.includes("db.tx.add('cp_enrollments',[enrollment])")&&
    api.includes("db.tx.add('cp_attendance',[record])")&&
    api.includes("First QR enrollment: faculty photo verification required"),
  'Admin reports visualize real submitted issues, not invented device telemetry':
    api.includes("dailyReports,issueCategories")&&
    api.includes("Offline devices and unreported crashes cannot be monitored live")&&
    app.includes("function SystemHealthGraphs")&&app.includes("Only user-submitted incident reports are counted."),
  'Faculty overview no longer contains unnecessary QR metric action strip':
    !app.includes("Students see your published status.")&&
    !app.includes("Manage QR attendance <ArrowRight")&&
    !app.includes("className='cp-faculty-pulse'"),
  'No AppDeploy runtime imports in backend':!api.includes("from '@appdeploy/sdk'"),
  'Vercel API route uses ESM-safe backend import':apiFunction.includes("from '../backend/index.js'"),
  'All nested API routes rewrite to a single Vercel Function':
    vercelConfig.functions?.['api/index.ts']?.maxDuration===30&&
    vercelConfig.rewrites?.some((r)=>r.source==='/api/:path*'&&r.destination==='/api/index?cp_route=:path*')&&
    adapter.includes('req.query?.cp_route')&&
    !fs.existsSync(path.join(root,'api/[...path].ts')),
  'Backend uses ESM-safe SDK imports':api.includes("from './vercel-sdk.js'")&&api.includes("import type { RouterMiddleware } from './vercel-sdk.js'"),
  'API client distinguishes HTML error pages from JSON':platform.includes("content-type")&&platform.includes('is missing from this deployment.')&&platform.includes('ClassPulse backend is temporarily unavailable.'),
  'Supabase authenticated JWT checked server-side':adapter.includes('auth.getUser(ctx.bearer)'),
  'Supabase records are private':databaseSql.includes('enable row level security'),
  'Supabase transaction is caller-privileged':databaseSql.includes('security invoker')&&!databaseSql.includes('security definer'),
  'Server key is required even for healthcheck':adapter.includes('!process.env.SUPABASE_SERVICE_ROLE_KEY'),
  'Atomic transaction with per-record lock':databaseSql.includes('pg_advisory_xact_lock')&&databaseSql.includes('cp_apply_batch'),
  'Server-only service key is not used in Vite client':!platform.includes('SUPABASE_SERVICE_ROLE_KEY'),
  'Private signed storage URLs':adapter.includes('createSignedUrl(path,300)'),
  'Password signup uses Supabase Auth':platform.includes('auth.signUp')&&platform.includes("emailRedirectTo:authCallbackUrl('confirmed')"),
  'Password sign-in uses Supabase Auth':platform.includes('auth.signInWithPassword'),
  'Recovery links use Supabase Auth':platform.includes('resetPasswordForEmail')&&platform.includes("authCallbackUrl('reset')"),
  'Recovery link verifies token only on click':platform.includes("type:'recovery',token_hash:tokenHash")&&app.includes("confirmRecoveryLink()")&&app.includes('if(pendingRecoveryToken)return'),
  'Supabase PASSWORD_RECOVERY event is supported':platform.includes("event==='PASSWORD_RECOVERY'")&&app.includes('auth.onRecoverySession'),
  'Recovery link URL is removed before UI rendering':app.includes('clearCallbackUrl()'),
  'Password reset signs out after change':app.includes('await auth.updatePassword(recoveryPassword)')&&app.includes('await auth.signOut()'),
  'Confirmation emails can be resent':platform.includes("auth.resend")&&platform.includes("type:'signup'"),
  'Callback errors are surfaced':app.includes("hash.get('error_description')")&&app.includes("authMode==='reset'"),
  'No registration password in sessionStorage':!app.includes('sessionStorage.setItem(signupKey,JSON.stringify({...details,password'),
  'Signup requests password confirmation':app.includes('signupPassword!==confirmPassword'),
  'Google Apple OAuth remains available':platform.includes('signInWithOAuth')&&app.includes("beginOAuth('google')")&&app.includes("beginOAuth('apple')"),
  'Unavailable Web Push is disclosed':platform.includes('push-not-configured')||platform.includes('Web push has not been configured'),

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
