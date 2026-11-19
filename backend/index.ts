import { router, json, error, requireAuth, db, storage, notifications, ws } from '@appdeploy/sdk';
import type { RouterMiddleware } from '@appdeploy/sdk';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

type Role = 'Student' | 'Faculty' | 'System Administrator';
type Profile = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  roleRequest?: string;
  studentNumber?: string;
  department?: string;
  bio?: string;
  contactPhone?: string;
  yearLevel?: string;
  officeRoom?: string;
  photoPath?: string;
  photoVerified?: boolean;
  onboardingComplete?: boolean;
  deletedAt?: string;
  createdAt: string;
};
type Section = {
  id: string;
  courseCode: string;
  title: string;
  section: string;
  term: string;
  day: string;
  startTime: string;
  endTime: string;
  room: string;
  facultyId: string;
  facultyName: string;
  joinCode: string;
  status: string;
  archivedAt?: string;
};
type Meeting = {
  id: string;
  sectionId: string;
  facultyId: string;
  meetingDate: string;
  openedAt: string;
  startAt: string;
  endAt: string;
  secret: string;
  status: 'OPEN' | 'CLOSED';
  lateMinutes: number;
};
type Attendance = {
  id: string;
  sessionId: string;
  sectionId: string;
  studentId: string;
  academicStatus: string;
  verificationStatus: string;
  capturedAt: string;
  receivedAt: string;
  clientScanId: string;
  reviewReason?: string;
  updatedAt: string;
};
type Excuse = {
  id: string;
  studentId: string;
  sectionId: string;
  absenceDate: string;
  reason: string;
  filePath?: string;
  status: string;
  reviewerId?: string;
  decisionReason?: string;
  createdAt: string;
};
type Slot = { id: string; facultyId: string; facultyName: string; sectionId?: string; subjectCode?: string; subjectTitle?: string; startAt: string; endAt: string; capacity: number; confirmedCount: number; status: string };
type Booking = { id: string; slotId: string; studentId: string; topic: string; status: string; createdAt: string; decisionReason?: string };
type AttendanceCorrection = { id:string; sectionId:string; attendanceId:string; sessionId:string; studentId:string;
  facultyId:string; previousStatus:string; nextStatus:string; reason:string; timestamp:string };

const ADMIN_EMAILS = [...new Set([
  ...(process.env.CLASSPULSE_ADMIN_EMAILS || '').split(','),
].map((s) => s.trim().toLowerCase()).filter(Boolean))];
type AdminInvite={id:string;email:string;status:'PENDING'|'ACCEPTED'|'REVOKED';createdBy:string;createdAt:string;expiresAt:string;acceptedAt?:string;previousRole?:Role};
function adminInviteId(email:string){return 'ai-'+createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0,42);}
async function isAdminEmail(email?:string) {
  if(!email)return false;
  const normalized=email.trim().toLowerCase();
  if(ADMIN_EMAILS.includes(normalized))return true;
  const invite=await get<AdminInvite>('cp_admin_invites',adminInviteId(normalized));
  return !!invite&&invite.email===normalized&&(
    invite.status==='ACCEPTED'||
    (invite.status==='PENDING'&&Date.parse(invite.expiresAt)>Date.now()));
}
const adminGuard: RouterMiddleware = async (ctx) => {
  const allowed=await isAdminEmail(ctx.user?.email);
  const profile=ctx.user?.userId?await get<Profile>('cp_profiles',ctx.user.userId):null;
  if(!allowed||profile?.deletedAt){
    return error('An authorized, active administrator account is required',403);
  }
};
const nowIso = () => new Date().toISOString();
const safeKey = (s: string) => s.replace(/[^A-Za-z0-9-]/g, '').slice(0, 90);
const memberId = (u: string, s: string) => 'en-' + createHash('sha256').update(u + ':' + s).digest('hex').slice(0, 40);
const attendanceId = (u: string, s: string) => 'at-' + createHash('sha256').update(u + ':' + s).digest('hex').slice(0, 40);
const noticesTable = (id: string) => 'cp_notices_' + safeKey(id);
const facultyLiveTable=(facultyId:string)=>'cp_live_sub_'+safeKey(facultyId);
const liveSubId=(ownerId:string,connectionId:string)=>
  'sub-'+createHash('sha256').update(ownerId+':'+connectionId).digest('hex').slice(0,45);
async function publishFacultyLive(facultyId:string, data:{
  kind:'presence'|'class'|'session';status?:string;updatedAt?:string;
}) {
  try {
    const watchers=await list<{ownerId:string;connectionId:string}>(facultyLiveTable(facultyId),240);
    const ids=Array.from(new Set(watchers.map(s=>s.connectionId).filter(Boolean)));
    if(ids.length)await ws.send(ids,{
      type:'entity.update',entity_type:'faculty_presence',entity_id:facultyId,data,
    });
  }catch(e){
    console.warn('Faculty live update not delivered',e);
  }
}
const text = (v: unknown, length = 180) => typeof v === 'string' ? v.trim().slice(0, length) : '';
const input = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const localDate = () => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return value('year') + '-' + value('month') + '-' + value('day');
};
const phInstant = (date: string, time: string) => new Date(date + 'T' + time + ':00+08:00').toISOString();

const campusDays = ['MW', 'TTH', 'F', 'S', 'A'];
const legacyDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const validClassDay = (day: string) => campusDays.includes(day) || legacyDays.includes(day);
const timeValid = (time: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const timeOverlaps = (startA: number, endA: number, startB: number, endB: number) =>
  startA < endB && endA > startB;
function classDayMatches(day: string, localDay: string): boolean {
  const dayNum = new Date(localDay + 'T12:00:00+08:00').getUTCDay();
  const daySets: Record<string, number[]> = {
    MW: [1, 3], TTH: [2, 4], F: [5], S: [6],
    A: [0],
    Monday: [1], Tuesday: [2], Wednesday: [3], Thursday: [4],
    Friday: [5], Saturday: [6], Sunday: [0],
  };
  return (daySets[day] || []).includes(dayNum);
}
function datesOverlap(dayA: string, dayB: string): boolean {
  // In the MSU pattern, A is Sunday and must participate in clash checks.
  const sampleWeek = ['2026-11-16', '2026-11-17', '2026-11-18',
    '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
  return sampleWeek.some(d => classDayMatches(dayA, d) && classDayMatches(dayB, d));
}
async function ownTeachingConflict(facultyId: string, day: string,
  startTime: string, endTime: string, skipId?: string) {
  const classes = await list<Section>('cp_sections', 240);
  return classes.find(s => s.facultyId === facultyId && s.id !== skipId
    && !s.archivedAt && datesOverlap(day, s.day)
    && timeOverlaps(minutes(startTime), minutes(endTime), minutes(s.startTime), minutes(s.endTime)));
}


async function roomConflict(room: string, day: string, startTime: string,
  endTime: string, term: string, skipId?: string) {
  const normalizedRoom = room.trim().toUpperCase().replace(/\s+/g, ' ');
  if (!normalizedRoom || /^(TBA|ONLINE|VIRTUAL)$/i.test(normalizedRoom)) return null;
  const schedule = await list<Section>('cp_sections', 240);
  return schedule.find(s =>
    s.id !== skipId && !s.archivedAt &&
    s.room.trim().toUpperCase().replace(/\s+/g, ' ') === normalizedRoom &&
    s.term.trim().toLowerCase() === term.trim().toLowerCase() &&
    datesOverlap(day, s.day) &&
    timeOverlaps(minutes(startTime), minutes(endTime), minutes(s.startTime), minutes(s.endTime)));
}


type ImportRow={preview:Record<string,string>;record:Record<string,unknown>};
async function validateImport(kind:string,inputRows:unknown[]):Promise<{
 valid:ImportRow[];issues:{row:number;reason:string}[]
}>{
  const schema:Record<string,string[]>={
    rooms:['code','building','capacity','status'],
    sections:['courseCode','title','section','term','day','startTime','endTime','room','facultyEmail'],
    enrollments:['studentEmail','courseCode','section','term'],
  };
  const fields=schema[kind];
  const [rooms,sections,profiles,enrollments]=await Promise.all([
    list<{id:string;code:string;building:string;capacity:number;status:string}>('cp_rooms',240),
    list<Section>('cp_sections',240),list<Profile>('cp_profiles',240),
    list<{studentId:string;sectionId:string}>('cp_enrollments',240),
  ]);
  const valid:ImportRow[]=[];
  const issues:{row:number;reason:string}[]=[];
  const seen=new Set<string>();
  for(let i=0;i<inputRows.length;i++){
    const obj=inputRows[i];
    if(!obj||typeof obj!=='object'||Array.isArray(obj)){
      issues.push({row:i+2,reason:'Not a CSV object'});continue;
    }
    const raw=obj as Record<string,unknown>;
    if(Object.keys(raw).some(key=>!fields.includes(key))){
      issues.push({row:i+2,reason:'Unexpected CSV column'});continue;
    }
    const row:Record<string,string>={};
    for(const key of fields)row[key]=text(raw[key],140);
    let record:Record<string,unknown>|null=null,duplicateKey='';
    let issue='';
    if(kind==='rooms'){
      const code=row.code.toUpperCase(),capacity=Number(row.capacity),status=row.status.toUpperCase();
      duplicateKey=code;
      if(!/^[A-Z0-9 -]{2,50}$/.test(code)||row.building.length<2||
         !Number.isInteger(capacity)||capacity<1||capacity>200||
         !['AVAILABLE','MAINTENANCE','INACTIVE'].includes(status)){
        issue='Room code, building, capacity or status invalid';
      }else if(rooms.some(r=>r.code.toUpperCase()===code))issue='Room already registered';
      else record={id:'room-'+createHash('sha256').update(code).digest('hex').slice(0,35),
        code,building:row.building,capacity,status};
    }else if(kind==='sections'){
      const faculty=profiles.find(p=>p.role==='Faculty'&&p.email.toLowerCase()===row.facultyEmail.toLowerCase());
      const courseCode=row.courseCode.toUpperCase();
      const term=row.term||'Current term';
      duplicateKey=[courseCode,row.section.toLowerCase(),term.toLowerCase()].join('|');
      if(!faculty||row.title.length<3||!row.section||!courseCode||
        !validClassDay(row.day)||!timeValid(row.startTime)||!timeValid(row.endTime)||
        row.startTime>=row.endTime||!row.room){
        issue='Invalid subject, verified faculty email, or timetable';
      }else if(sections.some(s=>!s.archivedAt&&s.courseCode===courseCode&&
        s.section.toLowerCase()===row.section.toLowerCase()&&s.term.toLowerCase()===term.toLowerCase())){
        issue='Duplicate active section for term';
      }else {
        const other=sections.filter(s=>!s.archivedAt)
          .concat(valid.filter(v=>v.record.facultyId).map(v=>v.record as unknown as Section));
        const occupied=other.find(s=>datesOverlap(row.day,s.day)&&
          timeOverlaps(minutes(row.startTime),minutes(row.endTime),minutes(s.startTime),minutes(s.endTime))&&
          (s.facultyId===faculty.userId||(s.room.toUpperCase()===row.room.toUpperCase()&&s.term.toLowerCase()===term.toLowerCase())));
        if(occupied)issue='Overlaps existing '+occupied.courseCode+' class or room';
        else record={id:randomUUID(),courseCode,title:row.title,section:row.section,term,
          day:row.day,startTime:row.startTime,endTime:row.endTime,
          room:row.room,facultyId:faculty.userId,facultyName:faculty.name,
          joinCode:randomBytes(5).toString('hex').toUpperCase(),status:'ATTENDING'};
      }
    }else{
      const student=profiles.find(p=>p.role==='Student'&&p.email.toLowerCase()===row.studentEmail.toLowerCase());
      const section=sections.find(s=>!s.archivedAt&&s.courseCode===row.courseCode.toUpperCase()&&
        s.section.toLowerCase()===row.section.toLowerCase()&&s.term.toLowerCase()===row.term.toLowerCase());
      if(!student||!section)issue='Verified Student or subject not found';
      else{
        duplicateKey=memberId(student.userId,section.id);
        if(enrollments.some(e=>e.studentId===student.userId&&e.sectionId===section.id))issue='Already enrolled';
        else record={id:duplicateKey,studentId:student.userId,sectionId:section.id,createdAt:nowIso()};
      }
    }
    if(!issue&&seen.has(duplicateKey))issue='Duplicate within uploaded CSV';
    if(issue||!record)issues.push({row:i+2,reason:issue||'Invalid row'});
    else{seen.add(duplicateKey);valid.push({record,preview:row});}
  }
  return {valid,issues};
}

const own = (p: Profile, s: Section) => p.role === 'Faculty' && s.facultyId === p.userId;
const presentStatus = (m: Meeting, captured: number) => captured > new Date(m.startAt).getTime() + m.lateMinutes * 60000 ? 'LATE' : 'PRESENT';
const publicSection = (s: Section) => ({
  id: s.id, courseCode: s.courseCode, title: s.title, section: s.section, term: s.term,
  day: s.day, startTime: s.startTime, endTime: s.endTime, room: s.room,
  facultyId: s.facultyId, facultyName: s.facultyName, status: s.status, archivedAt: s.archivedAt || null,
});
const publicMeeting = (s: Meeting) => ({
  id: s.id, sectionId: s.sectionId, facultyId: s.facultyId, meetingDate: s.meetingDate,
  openedAt: s.openedAt, startAt: s.startAt, endAt: s.endAt, status: s.status, lateMinutes: s.lateMinutes,
});
async function list<T>(table: string, limit = 160): Promise<Array<T & { id: string }>> {
  const result = await db.list<T>(table, { limit });
  return result.items as Array<T & { id: string }>;
}
async function get<T>(table: string, id: string): Promise<T | null> {
  return (await db.get<T>(table, [id], { consistent: true }))[0] || null;
}
async function add(table: string, record: Record<string, unknown>) {
  const [id] = await db.tx.add(table, [record]);
  return !!id;
}
async function patch(table: string, id: string, record: Record<string, unknown>, condition?: Record<string, unknown>) {
  const [ok] = await db.tx.update(table, [{ id, record, ...(condition ? { if: condition } : {}) }], { patch: true });
  return ok;
}
async function me(user: { userId: string; email?: string; name?: string }): Promise<Profile> {
  const found = await get<Profile>('cp_profiles', user.userId);
  if (found) {
    if(found.deletedAt)throw new Error('Your ClassPulse profile has been deleted');
    const admin = await isAdminEmail(user.email);
    if(admin&&!ADMIN_EMAILS.includes((user.email||'').toLowerCase())){
      const invite=await get<AdminInvite>('cp_admin_invites',adminInviteId(user.email||''));
      if(invite?.status==='PENDING'){
        await patch('cp_admin_invites',invite.id,{status:'ACCEPTED',acceptedAt:nowIso()});
      }
      if(found.role!=='System Administrator')await patch('cp_profiles',user.userId,{role:'System Administrator',roleRequest:''});
    }
    // Migrate existing Faculty registration requests to immediate Faculty status.
    // Faculty access to student records/QR remains scoped to admin-assigned sections.
    if (!admin && found.role === 'Student' && found.roleRequest === 'Faculty' && found.onboardingComplete) {
      await patch('cp_profiles', user.userId, { role: 'Faculty', roleRequest: '' });
      await audit(user.userId, 'ACTIVATE_FACULTY_REGISTRATION', 'Profile', user.userId, 'system');
      return { ...found, id: user.userId, role: 'Faculty', roleRequest: '' };
    }
    return { ...found, id: user.userId, role: admin ? 'System Administrator' : found.role === 'Faculty' ? 'Faculty' : 'Student' };
  }
  const inviteAdmin=await isAdminEmail(user.email);
  if(inviteAdmin&&!ADMIN_EMAILS.includes((user.email||'').toLowerCase())){
    const invite=await get<AdminInvite>('cp_admin_invites',adminInviteId(user.email||''));
    if(invite?.status==='PENDING')await patch('cp_admin_invites',invite.id,{status:'ACCEPTED',acceptedAt:nowIso()});
  }
  const initial: Profile = {
    id: user.userId, userId: user.userId, name: user.name || 'ClassPulse User',
    email: user.email || '',
    role: inviteAdmin ? 'System Administrator' : 'Student',
    onboardingComplete: false, createdAt: nowIso(),
  };
  await add('cp_profiles', initial);
  return initial;
}
function forbid(message = 'You do not have permission for this action') { return error(message, 403); }
async function audit(actorId: string, actionType: string, targetType: string, targetId: string, scope = 'academic') {
  await db.add('cp_audit', [{
    actorId, actionType, targetType, targetId, scope, timestamp: nowIso(),
  }]);
}
async function notify(userId: string, title: string, body: string, kind: string) {
  await db.add(noticesTable(userId), [{ title, body, kind, createdAt: nowIso(), read: false }]);
  try {
    await notifications.send({ userIds: [userId], notification: { title, body, url: '/' }, data: { kind } });
  } catch {
    // Persisted in-app notice remains available if a device has no push subscription.
  }
}
async function sectionMembers(sectionId: string) {
  const rows = await list<{ studentId: string; sectionId: string }>('cp_enrollments');
  return rows.filter((e) => e.sectionId === sectionId);
}
async function mySectionIds(userId: string) {
  const rows = await list<{ studentId: string; sectionId: string }>('cp_enrollments');
  return rows.filter((e) => e.studentId === userId).map((e) => e.sectionId);
}
async function availableSections(p: Profile) {
  const sections = await list<Section>('cp_sections');
  if (p.role === 'Faculty') return sections.filter((s) => own(p, s));
  if (p.role === 'Student') {
    const ids = await mySectionIds(p.userId);
    return sections.filter((s) => ids.includes(s.id));
  }
  return sections;
}
async function sessionAccess(p: Profile, sessionId: string) {
  const session = await get<Meeting>('cp_sessions', sessionId);
  if (!session) return null;
  const section = await get<Section>('cp_sections', session.sectionId);
  if (!section) return null;
  return { session, section, faculty: own(p, section) };
}
async function openSession(section: Section, date: string) {
  const startAt = phInstant(date, section.startTime);
  const endAt = phInstant(date, section.endTime);
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) throw new Error('Invalid class meeting time');
  const meeting: Meeting = {
    id: randomUUID(), sectionId: section.id, facultyId: section.facultyId, meetingDate: date,
    openedAt: nowIso(), startAt, endAt, secret: randomBytes(32).toString('hex'),
    status: 'OPEN', lateMinutes: 15,
  };
  return meeting;
}
function makeToken(meeting: Meeting) {
  const slot = Math.floor(Date.now() / 15000);
  const payload = Buffer.from(JSON.stringify({ sid: meeting.id, sec: meeting.sectionId, slot })).toString('base64url');
  const signature = createHmac('sha256', meeting.secret).update(payload).digest('base64url');
  return payload + '.' + signature;
}
function validateToken(token: string, m: Meeting) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = createHmac('sha256', m.secret).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { sid?: string; sec?: string; slot?: number };
    if (value.sid !== m.id || value.sec !== m.sectionId || !Number.isSafeInteger(value.slot)) return null;
    return value;
  } catch {
    return null;
  }
}
async function approvedExcuse(studentId: string, sectionId: string, date: string) {
  const rows = await list<Excuse>('cp_excuses');
  return rows.some((e) => e.studentId === studentId && e.sectionId === sectionId && e.absenceDate === date && e.status === 'APPROVED');
}
async function finalizeSession(m: Meeting, actorId: string) {
  const deadline = new Date(m.endAt).getTime() + 12 * 60 * 60 * 1000;
  if (Date.now() < deadline) return { ready: false, created: 0 };
  const members = await sectionMembers(m.sectionId);
  let created = 0;
  for (const member of members) {
    const id = attendanceId(member.studentId, m.id);
    const old = await get<Attendance>('cp_attendance', id);
    if (old) continue;
    const excused = await approvedExcuse(member.studentId, m.sectionId, m.meetingDate);
    const record: Attendance = {
      id, sessionId: m.id, sectionId: m.sectionId, studentId: member.studentId,
      academicStatus: excused ? 'EXCUSED' : 'ABSENT', verificationStatus: 'FINALIZED',
      capturedAt: '', receivedAt: nowIso(), clientScanId: '', updatedAt: nowIso(),
    };
    if (await add('cp_attendance', record)) created++;
  }
  if (created) await audit(actorId, 'FINALIZE_ABSENCES', 'ClassSession', m.id);
  return { ready: true, created };
}

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ ok: true, service: 'ClassPulse API' })],
  'GET /api/bootstrap': [requireAuth(), async (ctx) => {
    const existing=await get<Profile>('cp_profiles',ctx.user!.userId);
    if(existing?.deletedAt)return json({profile:existing,accountDeleted:true,adminConfigured:ADMIN_EMAILS.length>0});
    const p = await me(ctx.user!);
    return json({
      profile: p,
      adminConfigured: ADMIN_EMAILS.length > 0,
      capabilities: { signedQR: true, serverDatabase: true, immediateFacultyOnboarding: true, adminAssignedClassOwnership: true, androidNativeAPK: false },
    });
  }],
  'POST /api/onboarding': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const body = input(ctx.body);
    const name = text(body.name, 90);
    const studentNumber = text(body.studentNumber, 40);
    const requestedRole = text(body.requestedRole, 36);
    if (name.length < 2) return error('Enter your full name to complete registration', 400);
    if (!['Student','Faculty'].includes(requestedRole) &&
      !(requestedRole==='System Administrator'&&p.role==='System Administrator')){
      return error('Choose Student or Faculty. Administrator accounts require an invitation.',400);
    }
    if (p.onboardingComplete) return error('The account is already registered. Use Profile to edit your information.', 409);
    const role: Role = p.role === 'System Administrator' ? 'System Administrator'
      : requestedRole === 'Faculty' ? 'Faculty' : 'Student';
    const roleRequest = '';
    await patch('cp_profiles', p.userId, {
      name, studentNumber, role, roleRequest, onboardingComplete: true,
    });
    await audit(p.userId, 'COMPLETE_REGISTRATION_' + role.replace(/\s+/g, '_').toUpperCase(), 'Profile', p.userId, 'system');
    return json({ ok: true, profile: { ...p, name, studentNumber, role, roleRequest, onboardingComplete: true } });
  }],
  'POST /api/account/delete': [requireAuth(),async(ctx)=>{
    const p=await me(ctx.user!);
    if(text(input(ctx.body).confirmation,12)!=='DELETE')return error('Type DELETE to confirm',400);
    if(p.role==='System Administrator')return forbid('Administrator accounts must transfer access before deletion');
    if(p.role==='Faculty'){
      const sections=await availableSections(p);
      if(sections.some(s=>!s.archivedAt))
        return error('Reassign or archive your active teaching sections before deleting the account',409);
    }
    const now=nowIso();
    const ok=await patch('cp_profiles',p.userId,{
      name:'Deleted ClassPulse account',email:'',studentNumber:'',department:'',bio:'',
      contactPhone:'',yearLevel:'',officeRoom:'',photoPath:undefined,
      photoVerified:false,roleRequest:'',role:'Student',onboardingComplete:false,
      deletedAt:now,
    },{deletedAt:undefined});
    if(!ok)return error('Account changed; refresh and retry',409);
    if(p.photoPath){
      try {await storage.delete([p.photoPath]);}
      catch { /* Profile record no longer grants access to the old photo. */ }
    }
    await audit(p.userId,'DELETE_OWN_CLASSPULSE_PROFILE','Profile',p.userId,'system');
    return json({ok:true,deletedAt:now,
      retained:'Institutional attendance, enrollment, and audit records are retained. Identity-provider accounts are separate.'});
  }],
  'PUT /api/profile': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const body = input(ctx.body);
    const name = text(body.name, 90);
    if (name.length < 2) return error('Please enter your full name', 400);
    const studentNumber = text(body.studentNumber, 36);
    const department = text(body.department, 90);
    const bio = text(body.bio, 180);
    const contactPhone = text(body.contactPhone, 24);
    const yearLevel = text(body.yearLevel, 30);
    const officeRoom = text(body.officeRoom, 70);
    if (contactPhone && !/^[+0-9()\- ]{7,24}$/.test(contactPhone)) return error('Enter a valid contact phone number', 400);
    if (yearLevel && !['1st Year','2nd Year','3rd Year','4th Year','5th Year','Graduate'].includes(yearLevel)) return error('Select a valid year level', 400);
    await patch('cp_profiles', p.userId, { name, studentNumber, department, bio, contactPhone, yearLevel, officeRoom });
    await audit(p.userId, 'UPDATE_OWN_PROFILE', 'Profile', p.userId);
    return json({ ok: true, profile: { ...p, name, studentNumber, department, bio, contactPhone, yearLevel, officeRoom } });
  }],
  'POST /api/profile/photo': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const body = input(ctx.body);
    const content = text(body.content, 3100000);
    const contentType = text(body.contentType, 40);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) return error('Upload a JPG, PNG, or WebP photo', 400);
    if (!content || content.length > 2900000) return error('Photo must be smaller than 2 MB', 400);
    const path = 'profiles/' + safeKey(p.userId) + '/' + randomUUID() + (contentType === 'image/png' ? '.png' : contentType === 'image/webp' ? '.webp' : '.jpg');
    const [ok] = await storage.write([{ path, content, contentType }]);
    if (!ok) return error('Photo upload was unsuccessful', 500);
    await patch('cp_profiles', p.userId, { photoPath: path, photoVerified: false });
    return json({ ok: true, review: 'Profile photo awaits authorized verification' });
  }],
  'GET /api/profile/photo': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (!p.photoPath) return json({ url: null });
    const [{ url }] = await storage.url([p.photoPath]);
    return json({ url });
  }],
  'POST /api/roles/request-faculty': [requireAuth(), async () =>
    error('Role changes require the administrator or a new Faculty registration.',403)],
  'GET /api/admin/invites': [requireAuth(),adminGuard,async () => {
    const invites=await list<AdminInvite>('cp_admin_invites',100);
    return json({invites:invites.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
  }],
  'POST /api/admin/invite': [requireAuth(),adminGuard,async (ctx) => {
    const email=text(input(ctx.body).email,180).toLowerCase();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return error('Enter a valid email for the invitation',400);
    if(await isAdminEmail(email))return error('This email already has an active administrator invitation or access',409);
    const id=adminInviteId(email);
    const existing=await get<AdminInvite>('cp_admin_invites',id);
    const profiles=await list<Profile>('cp_profiles',240);
    const user=profiles.find(p=>p.email.toLowerCase()===email&&!p.deletedAt);
    const now=nowIso();
    const record:AdminInvite={
      id,email,status:'PENDING',createdBy:ctx.user!.userId,createdAt:now,
      expiresAt:new Date(Date.now()+7*86400000).toISOString(),
      previousRole:user?.role==='System Administrator'?'Student':user?.role||'Student',
    };
    if(existing){
      const ok=await patch('cp_admin_invites',id,record);
      if(!ok)return error('Could not renew this invitation',409);
    }else{
      const ok=await add('cp_admin_invites',record);
      if(!ok)return error('Could not create this invitation',409);
    }
    await audit(ctx.user!.userId,'INVITE_ADMIN','Profile',id,'system');
    if(user)await notify(user.userId,'Administrator invitation',
      'Sign in with '+email+' to accept your ClassPulse administrator invitation.','role');
    return json({ok:true,invite:{email,expiresAt:record.expiresAt}});
  }],
  'POST /api/admin/invite/revoke': [requireAuth(),adminGuard,async(ctx)=>{
    const email=text(input(ctx.body).email,180).toLowerCase();
    if(ADMIN_EMAILS.includes(email))return forbid('The initial administrator cannot be revoked through invitations');
    const id=adminInviteId(email);
    const invite=await get<AdminInvite>('cp_admin_invites',id);
    if(!invite||invite.email!==email)return error('Invitation not found',404);
    if(!await patch('cp_admin_invites',id,{status:'REVOKED'}))return error('Invitation changed; refresh and retry',409);
    const profiles=await list<Profile>('cp_profiles',240);
    const user=profiles.find(p=>p.email.toLowerCase()===email&&!p.deletedAt);
    if(user?.role==='System Administrator'){
      const restore=invite.previousRole==='Faculty'?'Faculty':'Student';
      await patch('cp_profiles',user.userId,{role:restore,roleRequest:''});
    }
    await audit(ctx.user!.userId,'REVOKE_ADMIN_INVITE','Profile',id,'system');
    return json({ok:true});
  }],
  'GET /api/admin/users': [requireAuth(), adminGuard, async (ctx) => {
    const profiles = (await list<Profile>('cp_profiles')).filter(p=>!p.deletedAt);
    await audit(ctx.user!.userId, 'VIEW_ROLE_DIRECTORY', 'ProfileDirectory', 'all', 'system');
    return json({ users: profiles.map((p) => ({
      userId: p.userId, name: p.name, email: p.email, role: p.role,
      roleRequest: p.roleRequest || '', photoVerified: !!p.photoVerified,
    })) });
  }],
  'POST /api/admin/role': [requireAuth(), adminGuard, async (ctx) => {
    const body = input(ctx.body);
    const userId = text(body.userId, 90);
    const role = text(body.role, 36);
    if (!['Student', 'Faculty'].includes(role) || !userId) return error('Choose a valid user and role', 400);
    const target = await get<Profile>('cp_profiles', userId);
    if (!target || ADMIN_EMAILS.includes(target.email.toLowerCase())) return error('The account cannot be reassigned', 403);
    await patch('cp_profiles', userId, { role, roleRequest: '' });
    await audit(ctx.user!.userId, 'APPROVE_ROLE', 'Profile', userId, 'system');
    await notify(userId, 'Account role updated', 'Your role is now ' + role + '.', 'role');
    return json({ ok: true });
  }],

  'GET /api/availability/me': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role !== 'Faculty') return forbid();
    const state = await get<{ status: string; updatedAt: string }>('cp_availability', p.userId);
    return json({ status: state?.status || 'NOT SET', updatedAt: state?.updatedAt || null });
  }],
  'POST /api/faculty/sections': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role !== 'Faculty') return forbid('Only registered Faculty can create subjects');
    const body = input(ctx.body);
    const courseCode = text(body.courseCode, 24).toUpperCase();
    const title = text(body.title, 120);
    const section = text(body.section, 36);
    const term = text(body.term, 40) || 'Current term';
    const day = text(body.day, 18);
    const startTime = text(body.startTime, 5);
    const endTime = text(body.endTime, 5);
    const room = text(body.room, 60);
    if (!/^[A-Z0-9 -]{2,24}$/.test(courseCode) || title.length < 3 || !section
      || !validClassDay(day)
      || !timeValid(startTime) || !timeValid(endTime)
      || startTime >= endTime || !room) {
      return error('Enter a valid course code, title, section, day, time and classroom', 400);
    }
    const overlap = await ownTeachingConflict(p.userId, day, startTime, endTime);
    if (overlap) return error('Schedule conflicts with your ' + overlap.courseCode + ' class', 409);
    const roomInUse = await roomConflict(room,day,startTime,endTime,term);
    if (roomInUse) return error('Room is booked by '+roomInUse.courseCode+' on '+roomInUse.day+' '+roomInUse.startTime+'–'+roomInUse.endTime,409);
    const duplicate = (await list<Section>('cp_sections', 200)).some((s) =>
      !s.archivedAt && s.facultyId === p.userId && s.courseCode === courseCode
      && s.section.toLowerCase() === section.toLowerCase() && s.term === term);
    if (duplicate) return error('You already manage that subject and section for this term', 409);
    const record: Section = {
      id: randomUUID(), courseCode, title, section, term, day, startTime, endTime, room,
      facultyId: p.userId, facultyName: p.name, joinCode: randomBytes(5).toString('hex').toUpperCase(),
      status: 'ATTENDING',
    };
    if (!(await add('cp_sections', record))) return error('Could not create subject', 500);
    await audit(p.userId, 'CREATE_OWN_SUBJECT', 'CourseSection', record.id);
    return json({ ok: true, subject: { ...publicSection(record), joinCode: record.joinCode } });
  }],
  'POST /api/faculty/sections/:id/update': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const s = await get<Section>('cp_sections', ctx.params.id);
    if (!s || !own(p,s) || s.archivedAt) return forbid('Only the assigned faculty can edit an active subject');
    const body = input(ctx.body);
    const courseCode = text(body.courseCode,24).toUpperCase();
    const title = text(body.title,120);
    const section = text(body.section,36);
    const term = text(body.term,40);
    const day = text(body.day,18);
    const startTime = text(body.startTime,5);
    const endTime = text(body.endTime,5);
    const room = text(body.room,60);
    if (!/^[A-Z0-9 -]{2,24}$/.test(courseCode) || title.length<3 || !section || !term || !room
      || !validClassDay(day)
      || !timeValid(startTime) || !timeValid(endTime) || startTime>=endTime) {
      return error('Complete all required subject and timetable fields',400);
    }
    const active = (await list<Meeting>('cp_sessions', 180)).some(m =>
      m.sectionId === s.id && m.status === 'OPEN' && Date.parse(m.endAt) > Date.now());
    if (active) return error('Close your active QR session before editing this subject',409);
    const overlap = await ownTeachingConflict(p.userId, day, startTime, endTime, s.id);
    if (overlap) return error('Schedule conflicts with your ' + overlap.courseCode + ' class',409);
    const roomInUse = await roomConflict(room,day,startTime,endTime,term,s.id);
    if (roomInUse) return error('Room is booked by '+roomInUse.courseCode+' on '+roomInUse.day+' '+roomInUse.startTime+'–'+roomInUse.endTime,409);
    const changed = await patch('cp_sections',s.id,
      {courseCode,title,section,term,day,startTime,endTime,room, facultyName:p.name});
    if (!changed) return error('Subject was changed or removed; refresh and retry',409);
    await audit(p.userId,'UPDATE_OWN_SUBJECT','CourseSection',s.id);
    const members = await sectionMembers(s.id);
    for (const member of members) {
      await notify(member.studentId,courseCode+' schedule updated',
        day+' '+startTime+'–'+endTime+' · '+room,'class');
    }
    return json({ok:true,section:publicSection({...s,courseCode,title,section,term,day,startTime,endTime,room})});
  }],
  'POST /api/faculty/sections/:id/remove': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const s = await get<Section>('cp_sections',ctx.params.id);
    if(!s || !own(p,s)) return forbid('Only the assigned faculty can remove a subject');
    if(s.archivedAt) return error('Subject is already archived. Restore it to continue managing it.',409);
    const [enrolled,sessions,excuses] = await Promise.all([
      sectionMembers(s.id),list<Meeting>('cp_sessions',200),list<Excuse>('cp_excuses',200)
    ]);
    const historical = enrolled.length>0 || sessions.some(m=>m.sectionId===s.id)
      || excuses.some(e=>e.sectionId===s.id);
    if (!historical) {
      const [deleted] = await db.delete('cp_sections',[s.id]);
      if(!deleted) return error('Subject removal did not complete',409);
      await audit(p.userId,'DELETE_UNUSED_SUBJECT','CourseSection',s.id);
      return json({ok:true,action:'deleted',message:'Unused subject deleted'});
    }
    const archivedAt = nowIso();
    await patch('cp_sections',s.id,{archivedAt,joinCode:'DISABLED-'+randomBytes(6).toString('hex').toUpperCase()});
    await audit(p.userId,'ARCHIVE_SUBJECT_PRESERVE_HISTORY','CourseSection',s.id);
    for (const member of enrolled) await notify(member.studentId,s.courseCode+' archived',
      'This subject is archived. Historical attendance records remain preserved.','class');
    return json({ok:true,action:'archived',message:'Subject archived; student and attendance history preserved'});
  }],
  'POST /api/faculty/sections/:id/restore': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const s = await get<Section>('cp_sections',ctx.params.id);
    if(!s || !own(p,s)) return forbid('Only the assigned faculty can restore a subject');
    if(!s.archivedAt) return error('Subject is already active',409);
    const joinCode = randomBytes(5).toString('hex').toUpperCase();
    await patch('cp_sections',s.id,{archivedAt:undefined,joinCode,status:'ATTENDING'});
    await audit(p.userId,'RESTORE_OWN_SUBJECT','CourseSection',s.id);
    return json({ok:true,joinCode,message:'Subject restored with a new join code'});
  }],
  'POST /api/faculty/sections/:id/rotate-code': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const s = await get<Section>('cp_sections',ctx.params.id);
    if(!s || !own(p,s) || s.archivedAt) return forbid('Only the assigned faculty can rotate an active subject code');
    const joinCode = randomBytes(5).toString('hex').toUpperCase();
    await patch('cp_sections',s.id,{joinCode});
    await audit(p.userId,'ROTATE_OWN_CLASS_JOIN_CODE','CourseSection',s.id);
    return json({ok:true,joinCode});
  }],
  'GET /api/faculty/sections/:id/roster': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const s = await get<Section>('cp_sections',ctx.params.id);
    if(!s || !own(p,s)) return forbid('Student rosters are restricted to assigned faculty');
    const [enrolled,allAttendance,allMeetings,allCorrections] = await Promise.all([
      sectionMembers(s.id),list<Attendance>('cp_attendance',250),list<Meeting>('cp_sessions',200),
      list<AttendanceCorrection>('cp_attendance_corrections',250),
    ]);
    const records = allAttendance.filter(r=>r.sectionId===s.id);
    const meetings = allMeetings.filter(m=>m.sectionId===s.id).map(publicMeeting);
    const students = await Promise.all(enrolled.map(async(member)=>{
      const profile = await get<Profile>('cp_profiles',member.studentId);
      const studentRecords = records.filter(r=>r.studentId===member.studentId);
      const counts={PRESENT:0,LATE:0,ABSENT:0,EXCUSED:0};
      for(const rec of studentRecords) if(rec.academicStatus in counts) counts[rec.academicStatus as keyof typeof counts]++;
      let photo: string|null = null;
      if(profile?.photoPath) {
        try { photo=(await storage.url([profile.photoPath]))[0]?.url || null; } catch { /* Photo optional. */ }
      }
      return {studentId:member.studentId,name:profile?.name||'Student',
        studentNumber:profile?.studentNumber||'',photo,counts,
        pendingReview:studentRecords.filter(r=>r.verificationStatus==='PENDING_REVIEW').length,
        lastRecord:studentRecords.slice(-1)[0]?.receivedAt || null};
    }));
    await audit(p.userId,'VIEW_OWN_CLASS_ROSTER','CourseSection',s.id);
    return json({section:{...publicSection(s),joinCode:s.joinCode},students,meetings,records,
      corrections:allCorrections.filter(c=>c.sectionId===s.id).sort((x,y)=>y.timestamp.localeCompare(x.timestamp)).slice(0,100)});
  }],

  'POST /api/admin/section': [requireAuth(), adminGuard, async (ctx) => {
    const body = input(ctx.body);
    const facultyId = text(body.facultyId, 90);
    const faculty = await get<Profile>('cp_profiles', facultyId);
    if (!faculty || faculty.role !== 'Faculty') return error('Select a registered Faculty account', 400);
    const courseCode = text(body.courseCode, 24).toUpperCase();
    const title = text(body.title, 120);
    const section = text(body.section, 40);
    const day = text(body.day, 16);
    const startTime = text(body.startTime, 5);
    const endTime = text(body.endTime, 5);
    const room = text(body.room, 60);
    if (!courseCode || !title || !section || !validClassDay(day)
      || !timeValid(startTime) || !timeValid(endTime) || startTime >= endTime) return error('Fill out a valid class schedule', 400);
    const term = text(body.term, 32) || 'Current term';
    const facultyClash = await ownTeachingConflict(facultyId,day,startTime,endTime);
    if (facultyClash) return error('Assigned faculty has an overlapping '+facultyClash.courseCode+' class',409);
    const roomClash = await roomConflict(room,day,startTime,endTime,term);
    if (roomClash) return error('Room is booked by '+roomClash.courseCode+' on '+roomClash.day,409);
    const s: Section = {
      id: randomUUID(), courseCode, title, section, term, day,
      startTime, endTime, room, facultyId, facultyName: faculty.name, status: 'ATTENDING',
      joinCode: randomBytes(4).toString('hex').toUpperCase(),
    };
    await add('cp_sections', s);
    await audit(ctx.user!.userId, 'CREATE_SECTION', 'CourseSection', s.id, 'system');
    return json({ ok: true, section: s });
  }],
  'GET /api/sections/:id/details': [requireAuth(), async (ctx) => {
    const p=await me(ctx.user!);
    const section=await get<Section>('cp_sections',ctx.params.id);
    if(!section)return error('Subject not found',404);
    const isFaculty=own(p,section);
    const isStudent=p.role==='Student'
      &&(await mySectionIds(p.userId)).includes(section.id);
    if(!isFaculty&&!isStudent)return forbid('Subject details are limited to enrolled students and assigned faculty');
    const members=await sectionMembers(section.id);
    const visible=members.slice(0,35);
    const classmates=await Promise.all(visible.map(async member=>{
      const profile=await get<Profile>('cp_profiles',member.studentId);
      const name=(profile?.name||'Student').trim();
      if(isFaculty)return {displayName:name};
      const tokens=name.split(/\s+/).filter(Boolean);
      return {displayName:tokens.length>1
        ? tokens[0]+' '+tokens[tokens.length-1][0]+'.'
        : tokens[0]||'Student'};
    }));
    let attendance:null|{
      present:number;late:number;absent:number;excused:number;pending:number;
      latestStatus:string|null;latestVerification:string|null;
      latestAt:string|null;rate:number|null;
    }=null;
    if(isStudent){
      const records=(await list<Attendance>('cp_attendance',250))
        .filter(record=>record.sectionId===section.id&&record.studentId===p.userId)
        .sort((a,b)=>Date.parse(b.capturedAt||b.receivedAt)-Date.parse(a.capturedAt||a.receivedAt));
      const verified=records.filter(record=>
        ['ACCEPTED','FACULTY_APPROVED','FACULTY_CORRECTED'].includes(record.verificationStatus));
      const totalStatus=(status:string)=>verified.filter(record=>record.academicStatus===status).length;
      const present=totalStatus('PRESENT');
      const late=totalStatus('LATE');
      const absent=totalStatus('ABSENT');
      const excused=totalStatus('EXCUSED');
      const total=present+late+absent+excused;
      const latest=records[0];
      attendance={
        present,late,absent,excused,
        pending:records.filter(record=>record.verificationStatus==='PENDING_REVIEW').length,
        latestStatus:latest?.academicStatus||null,
        latestVerification:latest?.verificationStatus||null,
        latestAt:latest?.capturedAt||latest?.receivedAt||null,
        rate:total?Math.round((present+late+excused)/total*100):null,
      };
    }
    return json({
      enrolledCount:members.length,
      classmates,
      moreClassmates:Math.max(0,members.length-visible.length),
      attendance,
    });
  }],
  'GET /api/sections': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const sections = await availableSections(p);
    const joined = p.role === 'Student' ? await mySectionIds(p.userId) : [];
    return json({
      sections: sections.map((s) => p.role !== 'Student' ? { ...publicSection(s), joinCode: s.joinCode } : publicSection(s)),
      joined,
    });
  }],
  'POST /api/sections/join': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role !== 'Student') return forbid();
    const code = text(input(ctx.body).joinCode, 20).toUpperCase();
    if (!code) return error('Enter a class join code', 400);
    const sections = await list<Section>('cp_sections');
    const s = sections.find((x) => x.joinCode === code && !x.archivedAt);
    if (!s) return error('The class code is invalid or the subject is archived', 404);
    const id = memberId(p.userId, s.id);
    const existing = await get('cp_enrollments', id);
    if (existing) return error('You are already enrolled in that class', 409);
    const ok = await add('cp_enrollments', { id, studentId: p.userId, sectionId: s.id, createdAt: nowIso() });
    if (!ok) return error('This enrollment already exists', 409);
    await audit(p.userId, 'JOIN_CLASS', 'CourseSection', s.id);
    return json({ ok: true, section: publicSection(s) });
  }],
  'GET /api/dashboard': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const sections = await availableSections(p);
    const allMeetings = p.role === 'System Administrator' ? [] : await list<Meeting>('cp_sessions');
    const meetings = allMeetings.filter((m) => sections.some((s) => s.id === m.sectionId));
    const attendance = p.role === 'Student'
      ? (await list<Attendance>('cp_attendance')).filter((a) => a.studentId === p.userId)
      : p.role === 'Faculty'
        ? (await list<Attendance>('cp_attendance')).filter((a) => sections.some((s) => s.id === a.sectionId))
        : [];
    const excuses = p.role === 'Student'
      ? (await list<Excuse>('cp_excuses')).filter((e) => e.studentId === p.userId)
      : p.role === 'Faculty'
        ? (await list<Excuse>('cp_excuses')).filter((e) => sections.some((s) => s.id === e.sectionId))
        : [];
    const bookings = p.role === 'Student'
      ? (await list<Booking>('cp_bookings')).filter((b) => b.studentId === p.userId)
      : p.role === 'Faculty'
        ? (await list<Booking>('cp_bookings')).filter((b) => false)
        : [];
    const filteredBookings = bookings;
    const notices = p.role === 'System Administrator' ? [] : (await list<{ title: string; body: string; createdAt: string }>(noticesTable(p.userId), 30));
    return json({
      profile: p,
      sections: sections.map(publicSection),
      meetings: meetings.map(publicMeeting),
      attendance,
      excuses,
      bookings: filteredBookings,
      notices,
      currentDate: localDate(),
    });
  }],
  'GET /api/live': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role === 'System Administrator') {
      return json({ faculty: [], updates: [], activeSessions: [], updatedAt: nowIso() });
    }
    const sections = await availableSections(p);
    const sectionIds = new Set(sections.map((s) => s.id));
    const facultyIds = Array.from(new Set(sections.map((s) => s.facultyId)));
    const [meetings, allUpdates] = await Promise.all([
      list<Meeting>('cp_sessions', 120),
      list<{ sectionId: string; facultyId: string; type: string; message: string; room: string; publishedAt: string }>('cp_updates', 120),
    ]);
    const activeMeetings = meetings
      .filter((m) => m.status === 'OPEN' && sectionIds.has(m.sectionId))
      .map((m) => ({
        ...publicMeeting(m),
        courseCode: sections.find((s) => s.id === m.sectionId)?.courseCode || '',
      }));
    const faculty = await Promise.all(facultyIds.map(async (facultyId) => {
      const [person, presence] = await Promise.all([
        get<Profile>('cp_profiles', facultyId),
        get<{ status: string; updatedAt: string }>('cp_availability', facultyId),
      ]);
      const classSession = activeMeetings.find((m) => m.facultyId === facultyId
        && Date.now() <= Date.parse(m.endAt) + 30 * 60000);
      return {
        facultyId, name: person?.name || sections.find((s) => s.facultyId === facultyId)?.facultyName || 'Faculty member',
        status: classSession ? 'IN CLASS' : presence?.status || 'NOT SET',
        updatedAt: classSession?.openedAt || presence?.updatedAt || null,
        classCodes: sections.filter((s) => s.facultyId === facultyId).map((s) => s.courseCode),
        source: classSession ? 'QR session' : presence ? 'Faculty update' : 'Not published',
      };
    }));
    return json({
      faculty,
      updates: allUpdates.filter((u) => sectionIds.has(u.sectionId))
        .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
        .slice(0, 16)
        .map((u) => ({
          id: u.id, sectionId: u.sectionId, type: u.type, message: u.message,
          room: u.room, publishedAt: u.publishedAt,
          courseCode: sections.find((s) => s.id === u.sectionId)?.courseCode || '',
        })),
      activeSessions: activeMeetings, updatedAt: nowIso(),
    });
  }],
  'POST /api/sections/status': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const body = input(ctx.body);
    const sectionId = text(body.sectionId, 90);
    const s = await get<Section>('cp_sections', sectionId);
    if (!s || !own(p, s) || s.archivedAt) return forbid('Subject must be active and owned by you');
    const status = text(body.status, 30);
    if (!['ATTENDING','DELAYED','CANCELLED','RESCHEDULED','ROOM CHANGED'].includes(status)) return error('Invalid status', 400);
    const room = text(body.room, 60) || s.room;
    await patch('cp_sections', s.id, { status, room });
    const update = { sectionId: s.id, facultyId: p.userId, type: status, message: text(body.message, 300), room, publishedAt: nowIso() };
    await db.add('cp_updates', [update]);
    await audit(p.userId, 'CLASS_STATUS_UPDATED', 'CourseSection', s.id);
    for (const student of await sectionMembers(s.id)) {
      await notify(student.studentId, s.courseCode + ' · ' + status, update.message || 'Class status or room has changed.', 'class');
    }
    await publishFacultyLive(p.userId,{kind:'class',updatedAt:nowIso()});
    return json({ ok: true });
  }],
  'POST /api/live/subscribe': [requireAuth(), async (ctx) => {
    const p=await me(ctx.user!);
    const body=input(ctx.body);
    const entityType=text(body.entity_type,40);
    const entityId=text(body.entity_id,90);
    const connectionId=text(body.connection_id,200);
    if(entityType!=='faculty_presence'||!entityId
      ||!/^[A-Za-z0-9_.:/+=-]{6,200}$/.test(connectionId)){
      return error('Invalid live subscription',400);
    }
    const allowed=p.role==='Faculty'
      ? p.userId===entityId
      : p.role==='Student' && (await availableSections(p))
        .some(s=>!s.archivedAt&&s.facultyId===entityId);
    if(!allowed)return forbid('This faculty status is not in your enrolled classes');
    await add(facultyLiveTable(entityId),{
      id:liveSubId(p.userId,connectionId),ownerId:p.userId,
      connectionId,createdAt:nowIso(),
    });
    return json({ok:true});
  }],
  'POST /api/live/unsubscribe': [requireAuth(), async (ctx) => {
    const p=await me(ctx.user!);
    const body=input(ctx.body);
    const entityId=text(body.entity_id,90);
    const connectionId=text(body.connection_id,200);
    if(text(body.entity_type,40)!=='faculty_presence'||!entityId
      ||!/^[A-Za-z0-9_.:/+=-]{6,200}$/.test(connectionId)){
      return error('Invalid live subscription',400);
    }
    await db.tx.delete(facultyLiveTable(entityId),[liveSubId(p.userId,connectionId)]);
    return json({ok:true});
  }],
  'POST /api/availability': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role !== 'Faculty') return forbid();
    const status = text(input(ctx.body).status, 20);
    if (!['AVAILABLE','IN CLASS','AWAY'].includes(status)) return error('Invalid availability', 400);
    const updatedAt=nowIso();
    const record = await get('cp_availability', p.userId);
    if (record) await patch('cp_availability', p.userId, { status, updatedAt });
    else await add('cp_availability', { id: p.userId, status, updatedAt });
    await publishFacultyLive(p.userId,{kind:'presence',status,updatedAt});
    return json({ ok: true, status, updatedAt });
  }],
  'GET /api/availability': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const sections = await availableSections(p);
    const allowed = new Set(sections.map((s) => s.facultyId));
    const rows = await list<{ id: string; status: string; updatedAt: string }>('cp_availability');
    return json({ availability: p.role === 'System Administrator' ? [] : rows.filter((r) => allowed.has(r.id)) });
  }],
  'POST /api/sessions/open': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const sectionId = text(input(ctx.body).sectionId, 90);
    const section = await get<Section>('cp_sections', sectionId);
    if (!section || !own(p, section) || section.archivedAt) return forbid('Only the assigned faculty of an active subject can open a QR attendance session');
    const date = localDate();
    if (!classDayMatches(section.day, date)) {
      return error('This class meets on ' + section.day + ' (A = Sunday). A QR session cannot open on an unscheduled day.', 409);
    }
    const start = Date.parse(phInstant(date, section.startTime));
    const end = Date.parse(phInstant(date, section.endTime));
    if (Date.now() < start - 30 * 60000 || Date.now() > end + 30 * 60000) {
      return error('This QR session opens within 30 minutes of the scheduled class time.', 409);
    }
    const old = (await list<Meeting>('cp_sessions')).find((m) => m.sectionId === sectionId && m.meetingDate === date);
    if (old) return error('A QR-enabled session already exists for this class today', 409);
    const meeting = await openSession(section, date);
    if (!(await add('cp_sessions', meeting))) return error('Unable to create session', 500);
    await audit(p.userId, 'OPEN_QR_SESSION', 'ClassSession', meeting.id);
    await publishFacultyLive(p.userId,{kind:'session',updatedAt:nowIso()});
    return json({ ok: true, meeting: publicMeeting(meeting) });
  }],
  'GET /api/sessions/:id/qr': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const detail = await sessionAccess(p, ctx.params.id);
    if (!detail || !detail.faculty) return forbid();
    if (detail.session.status !== 'OPEN') return error('The session is closed', 409);
    return json({ token: makeToken(detail.session), refreshSeconds: 15, meeting: publicMeeting(detail.session) });
  }],
  'POST /api/sessions/:id/close': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const detail = await sessionAccess(p, ctx.params.id);
    if (!detail || !detail.faculty) return forbid();
    await patch('cp_sessions', ctx.params.id, { status: 'CLOSED' });
    await audit(p.userId, 'CLOSE_QR_SESSION', 'ClassSession', ctx.params.id);
    await publishFacultyLive(p.userId,{kind:'session',updatedAt:nowIso()});
    return json({ ok: true });
  }],
  'POST /api/attendance/scan': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role !== 'Student') return forbid();
    const body = input(ctx.body);
    const token = text(body.token, 1200);
    const capturedAt = text(body.capturedAt, 60);
    const clientScanId = text(body.clientScanId, 90) || randomUUID();
    const receivedAt = nowIso();
    let payload: { sid?: string } | null = null;
    try {
      payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as { sid?: string };
    } catch {
      return error('QR code is not a valid ClassPulse token', 400);
    }
    const meeting = payload.sid && await get<Meeting>('cp_sessions', payload.sid);
    if (!meeting) return error('This QR session does not exist', 404);
    const membership = await get('cp_enrollments', memberId(p.userId, meeting.sectionId));
    const verifiedToken = validateToken(token, meeting);
    const cap = Date.parse(capturedAt);
    const ageMs = Date.now() - cap;
    const slotStart = verifiedToken ? verifiedToken.slot * 15000 : 0;
    const validTime = Number.isFinite(cap) && !!verifiedToken
      && cap >= slotStart - 2000 && cap <= slotStart + 18000
      && ageMs >= -30000 && ageMs <= 12 * 60 * 60 * 1000;
    const reason = !membership ? 'NOT_ENROLLED'
      : !verifiedToken ? 'INVALID_SIGNATURE'
        : !validTime ? 'TIMESTAMP_OR_SYNC_WINDOW_INVALID'
          : 'VALID_TOKEN';
    await db.add('cp_verification', [{
      sessionId: meeting.id, studentId: p.userId, clientScanId,
      capturedAt, receivedAt, result: reason === 'VALID_TOKEN' ? 'TOKEN_VALID' : 'REJECTED',
      integrityFlag: reason !== 'VALID_TOKEN', reason,
    }]);
    if (reason !== 'VALID_TOKEN') return error('Scan rejected: ' + reason.replace(/_/g, ' ').toLowerCase(), 422);
    const id = attendanceId(p.userId, meeting.id);
    const old = await get<Attendance>('cp_attendance', id);
    if (old) return json({ ok: true, duplicate: true, attendance: old });
    // Delayed submissions are held for faculty review because the phone clock is not trusted proof.
    const requiresReview = ageMs > 90000 || meeting.status === 'CLOSED';
    const record: Attendance = {
      id, sessionId: meeting.id, sectionId: meeting.sectionId, studentId: p.userId,
      academicStatus: requiresReview ? 'PENDING REVIEW' : presentStatus(meeting, cap),
      verificationStatus: requiresReview ? 'PENDING_REVIEW' : 'ACCEPTED',
      capturedAt, receivedAt, clientScanId, reviewReason: requiresReview ? 'Offline/delayed capture requires faculty confirmation' : '',
      updatedAt: nowIso(),
    };
    const saved = await add('cp_attendance', record);
    if (!saved) return error('A scan for this session is already recorded', 409);
    await audit(p.userId, 'SUBMIT_QR_SCAN', 'ClassSession', meeting.id);
    return json({ ok: true, attendance: record, review: requiresReview });
  }],
  'GET /api/attendance': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role === 'System Administrator') return forbid('Administrator can view aggregate summaries only');
    const ids = p.role === 'Student' ? await mySectionIds(p.userId)
      : (await availableSections(p)).map((s) => s.id);
    const rows = (await list<Attendance>('cp_attendance')).filter((a) =>
      p.role === 'Student' ? a.studentId === p.userId : ids.includes(a.sectionId));
    return json({ records: rows });
  }],
  'GET /api/sessions/:id/roster': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const detail = await sessionAccess(p, ctx.params.id);
    if (!detail || !detail.faculty) return forbid();
    const members = await sectionMembers(detail.section.id);
    const rows = await Promise.all(members.map(async (m) => {
      const profile = await get<Profile>('cp_profiles', m.studentId);
      const attendance = await get<Attendance>('cp_attendance', attendanceId(m.studentId, detail.session.id));
      const photo = profile?.photoPath ? (await storage.url([profile.photoPath]))[0].url : null;
      return { studentId: m.studentId, name: profile?.name || 'Enrolled student', studentNumber: profile?.studentNumber || '',
        photo, attendance: attendance || null };
    }));
    return json({ meeting: publicMeeting(detail.session), section: publicSection(detail.section), students: rows });
  }],
  'POST /api/attendance/review': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const body = input(ctx.body);
    const studentId = text(body.studentId, 90);
    const sessionId = text(body.sessionId, 90);
    const reason = text(body.reason, 400);
    const status = text(body.status, 20);
    if (reason.length < 6 || !['PRESENT','LATE','ABSENT','EXCUSED'].includes(status)) return error('Provide a decision and a reason of at least 6 characters', 400);
    const detail = await sessionAccess(p, sessionId);
    if (!detail || !detail.faculty) return forbid();
    const id = attendanceId(studentId, sessionId);
    const before = await get<Attendance>('cp_attendance', id);
    if (!before) return error('Attendance record does not exist', 404);
    const verified = status !== 'ABSENT' && before.verificationStatus === 'PENDING_REVIEW' ? 'FACULTY_APPROVED' : 'FACULTY_CORRECTED';
    const changedAt=nowIso();
    const correction:AttendanceCorrection={
      id:randomUUID(),sectionId:detail.section.id,attendanceId:id,sessionId,studentId,
      facultyId:p.userId,previousStatus:before.academicStatus,nextStatus:status,reason,timestamp:changedAt,
    };
    try{
      await db.transact([
        db.tx.update('cp_attendance',[{id,record:{
          academicStatus:status,verificationStatus:verified,reviewReason:reason,updatedAt:changedAt,
        },if:{updatedAt:before.updatedAt}}],{patch:true}),
        db.tx.add('cp_attendance_corrections',[correction]),
      ]);
    }catch{return error('Attendance changed while you were reviewing it. Refresh and retry.',409);}
    await audit(p.userId, 'REVIEW_ATTENDANCE_' + before.academicStatus + '_TO_' + status, 'AttendanceRecord', id);
    await notify(studentId, 'Attendance record reviewed', detail.section.courseCode + ': ' + status + '. Reason: ' + reason, 'attendance');
    return json({ ok: true });
  }],
  'POST /api/sessions/:id/finalize': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const detail = await sessionAccess(p, ctx.params.id);
    if (!detail || !detail.faculty) return forbid();
    return json(await finalizeSession(detail.session, p.userId));
  }],
  'POST /api/excuses': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role !== 'Student') return forbid();
    const body = input(ctx.body);
    const sectionId = text(body.sectionId, 90);
    const date = text(body.absenceDate, 20);
    const reason = text(body.reason, 1200);
    const targetDate=new Date(date+'T12:00:00+08:00');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(targetDate.getTime())||
      targetDate.toISOString().slice(0,10)!==date||reason.length<8)
      return error('Provide a valid scheduled date and reason of at least 8 characters',400);
    if (!await get('cp_enrollments', memberId(p.userId, sectionId)))
      return forbid('You are not enrolled in this class');
    const subject=await get<Section>('cp_sections',sectionId);
    if(!subject||subject.archivedAt)return error('Select an active enrolled subject',409);
    if(!classDayMatches(subject.day,date))
      return error('Excuse dates must match the selected class schedule ('+subject.day+')',422);
    const record: Excuse = { id: randomUUID(), studentId: p.userId, sectionId, absenceDate: date, reason,
      status: 'PENDING', createdAt: nowIso() };
    await add('cp_excuses', record);
    await audit(p.userId, 'SUBMIT_EXCUSE', 'ExcuseRequest', record.id);
    return json({ ok: true, excuse: record });
  }],
  'POST /api/excuses/:id/file': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const excuse = await get<Excuse>('cp_excuses', ctx.params.id);
    if (!excuse || excuse.studentId !== p.userId || excuse.status !== 'PENDING') return forbid();
    const body = input(ctx.body);
    const contentType = text(body.contentType, 80);
    const content = text(body.content, 3900000);
    if (!['application/pdf','image/jpeg','image/png'].includes(contentType) || !content || content.length > 3700000) return error('Attach a PDF, JPG, or PNG file under 2.5 MB', 400);
    const path = 'excuses/' + safeKey(p.userId) + '/' + excuse.id + (contentType === 'application/pdf' ? '.pdf' : contentType === 'image/png' ? '.png' : '.jpg');
    const [ok] = await storage.write([{ path, content, contentType }]);
    if (!ok) return error('Upload failed', 500);
    await patch('cp_excuses', excuse.id, { filePath: path });
    return json({ ok: true });
  }],
  'GET /api/excuses/:id/file': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const excuse = await get<Excuse>('cp_excuses', ctx.params.id);
    if (!excuse || !excuse.filePath) return error('Supporting document not found', 404);
    const s = await get<Section>('cp_sections', excuse.sectionId);
    if (excuse.studentId !== p.userId && (!s || !own(p, s))) return forbid();
    const [{ url }] = await storage.url([excuse.filePath]);
    return json({ url });
  }],
  'GET /api/excuses': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role === 'System Administrator') return forbid();
    const ids = p.role === 'Faculty' ? (await availableSections(p)).map((s) => s.id) : [];
    const rows = (await list<Excuse>('cp_excuses')).filter((e) =>
      p.role==='Student'?e.studentId===p.userId:ids.includes(e.sectionId));
    const unique=Array.from(new Set(rows.map(row=>row.studentId)));
    const profiles=await Promise.all(unique.map(id=>get<Profile>('cp_profiles',id)));
    const names=new Map(unique.map((id,index)=>[id,profiles[index]?.name||'Enrolled student']));
    return json({ excuses:rows.map(({filePath,...rest})=>({
      ...rest,hasFile:!!filePath,
      studentName:p.role==='Student'?p.name:names.get(rest.studentId)||'Enrolled student',
    })) });
  }],
  'POST /api/excuses/:id/decision': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const e = await get<Excuse>('cp_excuses', ctx.params.id);
    const s = e && await get<Section>('cp_sections', e.sectionId);
    if (!e || !s || !own(p, s)) return forbid();
    if (e.status !== 'PENDING') return error('This request has already been decided', 409);
    const body = input(ctx.body);
    const status = text(body.status, 20);
    const decisionReason = text(body.reason, 400);
    if (!['APPROVED','REJECTED'].includes(status) || decisionReason.length < 6) return error('Choose a decision and provide a reason', 400);
    const ok = await patch('cp_excuses', e.id, { status, reviewerId: p.userId, decisionReason }, { status: 'PENDING' });
    if (!ok) return error('Request was changed by another action', 409);
    if (status === 'APPROVED') {
      const sessions = (await list<Meeting>('cp_sessions')).filter((m) => m.sectionId === e.sectionId && m.meetingDate === e.absenceDate);
      for (const m of sessions) {
        const id = attendanceId(e.studentId, m.id);
        const existing = await get<Attendance>('cp_attendance', id);
        if (existing) await patch('cp_attendance', id, { academicStatus: 'EXCUSED', updatedAt: nowIso() });
      }
    }
    await audit(p.userId, 'EXCUSE_' + status, 'ExcuseRequest', e.id);
    await notify(e.studentId, 'Excuse ' + status.toLowerCase(), s.courseCode + ': ' + decisionReason, 'excuse');
    return json({ ok: true });
  }],

  'POST /api/slots/batch': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role !== 'Faculty') return forbid('Only Faculty can publish consultation slots');
    const body = input(ctx.body);
    const dates = body.dates;
    const startTime = text(body.startTime, 5);
    const endTime = text(body.endTime, 5);
    const capacity = Number(body.capacity);
    const sectionId = text(body.sectionId, 90);
    const section = await get<Section>('cp_sections',sectionId);
    if(!section || !own(p,section) || section.archivedAt) return error('Select one of your active teaching subjects', 400);
    if (!Array.isArray(dates) || dates.length < 1 || dates.length > 14
      || !dates.every(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      || !timeValid(startTime) || !timeValid(endTime)
      || minutes(endTime) - minutes(startTime) < 15
      || minutes(endTime) - minutes(startTime) > 240
      || !Number.isInteger(capacity) || capacity < 1 || capacity > 10) {
      return error('Select 1–14 dates, a time range of 15–240 minutes, and capacity 1–10', 400);
    }
    const days = [...new Set(dates as string[])].sort();
    if (days.length !== dates.length) return error('Choose each date only once', 400);
    const today = localDate();
    const horizon = new Date(Date.now() + 186 * 24 * 60 * 60 * 1000);
    const facultyClasses = (await availableSections(p)).filter(s => !s.archivedAt);
    const allSlots = await list<Slot>('cp_slots', 240);
    const planned: Slot[] = [];
    for (const date of days) {
      const startAt = phInstant(date, startTime);
      const endAt = phInstant(date, endTime);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila',
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(startAt));
      const part = (name: string) => parts.find(p => p.type === name)?.value || '';
      const validDate = part('year') + '-' + part('month') + '-' + part('day');
      if (date < today || Date.parse(startAt) <= Date.now()
        || Date.parse(startAt) > horizon.getTime()
        || validDate !== date) {
        return error('Date ' + date + ' is invalid, past, or outside the 6-month publishing range', 400);
      }
      const conflictClass = facultyClasses.find(s => classDayMatches(s.day, date)
        && timeOverlaps(minutes(startTime), minutes(endTime),
          minutes(s.startTime), minutes(s.endTime)));
      if (conflictClass) return error(date + ' conflicts with teaching ' + conflictClass.courseCode, 409);
      const conflictSlot = allSlots.find(s => s.facultyId === p.userId && s.status === 'OPEN'
        && timeOverlaps(Date.parse(startAt), Date.parse(endAt),
          Date.parse(s.startAt), Date.parse(s.endAt)));
      if (conflictSlot) return error(date + ' overlaps an existing consultation slot', 409);
      planned.push({
        id: 'slot-' + createHash('sha256').update(p.userId + ':' + date + ':' + startTime + ':' + endTime).digest('hex').slice(0, 40),
        facultyId: p.userId, facultyName: p.name,
        sectionId:section.id,subjectCode:section.courseCode,subjectTitle:section.title,
        startAt, endAt, capacity, confirmedCount: 0, status: 'OPEN',
      });
    }
    const ops = planned.map(s => db.tx.add('cp_slots', [s]));
    try {
      await db.transact(ops);
    } catch {
      return error('Slots could not be published together. Refresh the calendar and retry.', 409);
    }
    await audit(p.userId, 'PUBLISH_CONSULTATION_DATES', 'ConsultationSlot', planned[0].id);
    return json({ ok: true, created: planned.length, slots: planned });
  }],

  'POST /api/slots': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role !== 'Faculty') return forbid();
    const body = input(ctx.body);
    const startAt = text(body.startAt, 45);
    const endAt = text(body.endAt, 45);
    const sectionId = text(body.sectionId, 90);
    const section = await get<Section>('cp_sections',sectionId);
    if(!section || !own(p,section) || section.archivedAt) return error('Select an active teaching subject',400);
    const capacity = Math.max(1, Math.min(10, Number(body.capacity) || 1));
    if (!Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt))
      || Date.parse(endAt) <= Date.parse(startAt) || Date.parse(startAt) <= Date.now()) return error('Publish a valid future time range', 400);
    const record: Slot = { id: randomUUID(), facultyId: p.userId, facultyName: p.name,
      sectionId:section.id,subjectCode:section.courseCode,subjectTitle:section.title,
      startAt, endAt, capacity, confirmedCount: 0, status: 'OPEN' };
    await add('cp_slots', record);
    return json({ ok: true, slot: record });
  }],
  'GET /api/slots': [requireAuth(), async () => {
    const rows = await list<Slot>('cp_slots');
    return json({ slots: rows.filter((s) => s.status === 'OPEN' && Date.parse(s.endAt) > Date.now()) });
  }],

  'POST /api/slots/:id/cancel': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const slot = await get<Slot>('cp_slots', ctx.params.id);
    if (!slot || p.role !== 'Faculty' || slot.facultyId !== p.userId) return forbid();
    if (slot.status !== 'OPEN') return error('Slot is already closed', 409);
    const ok = await patch('cp_slots', slot.id, { status: 'CANCELLED' }, { status: 'OPEN' });
    if (!ok) return error('Slot was changed. Refresh and retry.', 409);
    const bookings = (await list<Booking>('cp_bookings', 200))
      .filter(b => b.slotId === slot.id && ['PENDING', 'CONFIRMED'].includes(b.status));
    for (const booking of bookings) {
      const changed = await patch('cp_bookings', booking.id,
        { status: 'CANCELLED', decisionReason: 'Faculty cancelled this consultation slot' },
        { status: booking.status });
      if (changed) await notify(booking.studentId, 'Consultation cancelled',
        slot.facultyName + ' cancelled the slot on ' + slot.startAt + '. Please choose another date.', 'consultation');
    }
    await audit(p.userId, 'CANCEL_CONSULTATION_SLOT', 'ConsultationSlot', slot.id);
    return json({ ok: true, affectedBookings: bookings.length });
  }],

  'POST /api/bookings': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role !== 'Student') return forbid();
    const body = input(ctx.body);
    const slotId = text(body.slotId, 90);
    const topic = text(body.topic, 400);
    const slot = await get<Slot>('cp_slots', slotId);
    if (!slot || slot.status !== 'OPEN' || Date.parse(slot.endAt) < Date.now()
      || slot.confirmedCount >= slot.capacity) return error('This consultation slot is unavailable or full', 409);
    if (topic.length < 5) return error('Enter a consultation topic', 400);
    const old = (await list<Booking>('cp_bookings')).some((b) => b.slotId === slotId && b.studentId === p.userId && ['PENDING','CONFIRMED'].includes(b.status));
    if (old) return error('You already have an active request for this slot', 409);
    const record: Booking = { id: randomUUID(), slotId, studentId: p.userId, topic, status: 'PENDING', createdAt: nowIso() };
    await add('cp_bookings', record);
    await notify(slot.facultyId, 'New consultation request', 'A student requested a consultation slot.', 'consultation');
    return json({ ok: true, booking: record });
  }],
  'GET /api/bookings': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role === 'System Administrator') return forbid();
    const rows = await list<Booking>('cp_bookings');
    const slots = await list<Slot>('cp_slots');
    const filtered = rows.filter((b) => p.role === 'Student' ? b.studentId === p.userId : slots.some((s) => s.id === b.slotId && s.facultyId === p.userId));
    return json({ bookings: filtered.map((b) => ({ ...b, slot: slots.find((s) => s.id === b.slotId) || null })) });
  }],

  'POST /api/bookings/:id/cancel': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    if (p.role !== 'Student') return forbid();
    const booking = await get<Booking>('cp_bookings', ctx.params.id);
    if (!booking || booking.studentId !== p.userId) return forbid('Only the requesting student may cancel a consultation');
    const slot = await get<Slot>('cp_slots', booking.slotId);
    if (!slot || Date.parse(slot.startAt) <= Date.now()) return error('Past consultations cannot be cancelled', 409);
    if (!['PENDING','CONFIRMED'].includes(booking.status)) return error('This request is already closed', 409);
    if (booking.status === 'CONFIRMED') {
      const reduced = db.tx.update('cp_slots', [{
        id:slot.id, record:{ confirmedCount:Math.max(0,slot.confirmedCount-1) },
        if:{ confirmedCount:slot.confirmedCount }
      }],{patch:true});
      const cancelled = db.tx.update('cp_bookings', [{
        id:booking.id, record:{status:'CANCELLED', decisionReason:'Cancelled by student'},
        if:{status:'CONFIRMED'}
      }],{patch:true});
      try { await db.transact([reduced,cancelled]); }
      catch { return error('Booking changed. Refresh and retry cancellation.',409); }
    } else {
      const changed = await patch('cp_bookings',booking.id,
        {status:'CANCELLED',decisionReason:'Cancelled by student'},{status:'PENDING'});
      if (!changed) return error('Booking changed. Refresh and retry.',409);
    }
    await notify(slot.facultyId,'Student cancelled a consultation',
      'A request for '+slot.startAt+' has been cancelled and the slot is available again.','consultation');
    await audit(p.userId,'CANCEL_OWN_CONSULTATION','Booking',booking.id);
    return json({ok:true});
  }],

  'POST /api/bookings/:id/decision': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const booking = await get<Booking>('cp_bookings', ctx.params.id);
    const slot = booking && await get<Slot>('cp_slots', booking.slotId);
    if (!booking || !slot || p.role !== 'Faculty' || slot.facultyId !== p.userId) return forbid();
    if (booking.status !== 'PENDING') return error('The booking is not pending', 409);
    if (slot.status !== 'OPEN') return error('The consultation slot has been cancelled', 409);
    const body = input(ctx.body);
    const status = text(body.status, 20);
    const decisionReason = text(body.reason, 400);
    if (!['CONFIRMED','REJECTED'].includes(status)) return error('Invalid booking decision', 400);
    if (status === 'CONFIRMED') {
      if (slot.confirmedCount >= slot.capacity) return error('The slot is full', 409);
      const confirmed = (await list<Booking>('cp_bookings')).some((b) =>
        b.slotId === booking.slotId && b.studentId === booking.studentId && b.status === 'CONFIRMED');
      if (confirmed) return error('The student already has a confirmed booking', 409);
      // Both writes are conditional, committed together.
      const reserve = db.tx.update('cp_slots', [{ id: slot.id,
        record: { confirmedCount: slot.confirmedCount + 1 },
        if: { confirmedCount: slot.confirmedCount } }], { patch: true });
      const decide = db.tx.update('cp_bookings', [{ id: booking.id,
        record: { status: 'CONFIRMED', decisionReason },
        if: { status: 'PENDING' } }], { patch: true });
      try { await db.transact([reserve, decide]); }
      catch { return error('Slot availability changed. Please refresh and retry.', 409); }
    } else {
      const ok = await patch('cp_bookings', booking.id, { status: 'REJECTED', decisionReason }, { status: 'PENDING' });
      if (!ok) return error('Request already changed', 409);
    }
    await audit(p.userId, 'BOOKING_' + status, 'Booking', booking.id);
    await notify(booking.studentId, 'Consultation ' + status.toLowerCase(), slot.facultyName + ': ' + (decisionReason || 'Booking status updated.'), 'consultation');
    return json({ ok: true });
  }],
  'GET /api/notices': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const rows = await list<{ title: string; body: string; kind: string; createdAt: string; read: boolean }>(noticesTable(p.userId), 80);
    return json({ notices: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }],
  'POST /api/notices/:id/read': [requireAuth(), async (ctx) => {
    const p = await me(ctx.user!);
    const ok = await patch(noticesTable(p.userId), ctx.params.id, { read: true });
    return json({ ok });
  }],


  'GET /api/admin/rooms': [requireAuth(), adminGuard, async () => {
    return json({rooms:await list<{id:string;code:string;building:string;capacity:number;status:string}>('cp_rooms',200)});
  }],
  'POST /api/admin/rooms/:id/status': [requireAuth(), adminGuard, async ctx => {
    const room=await get<{code:string;status:string}>('cp_rooms',ctx.params.id);
    if(!room)return error('Room not found',404);
    const status=text(input(ctx.body).status,24).toUpperCase();
    if(!['AVAILABLE','MAINTENANCE','INACTIVE'].includes(status))return error('Invalid room status',400);
    if(status!=='AVAILABLE'){
      const used=(await list<Section>('cp_sections',240)).some(s=>!s.archivedAt&&s.room.toUpperCase()===room.code.toUpperCase());
      if(used)return error('Room is used by active classes; reassign those classes before marking it unavailable',409);
    }
    await patch('cp_rooms',ctx.params.id,{status});
    await audit(ctx.user!.userId,'UPDATE_CAMPUS_ROOM','Room',ctx.params.id,'system');
    return json({ok:true});
  }],
  'POST /api/admin/import/preview': [requireAuth(), adminGuard, async ctx => {
    const body=input(ctx.body), kind=text(body.kind,20);
    if(!['rooms','sections','enrollments'].includes(kind))return error('Invalid import kind',400);
    const rows=body.rows;
    if(!Array.isArray(rows)||rows.length<1||rows.length>15)return error('Import 1–15 rows per batch',400);
    const result=await validateImport(kind,rows);
    const fingerprint=createHash('sha256').update(JSON.stringify({kind,rows})).digest('hex');
    return json({kind,total:rows.length,valid:result.valid.length,issues:result.issues,
      fingerprint,example:result.valid.slice(0,4).map(x=>x.preview)});
  }],
  'POST /api/admin/import/commit': [requireAuth(), adminGuard, async ctx => {
    const body=input(ctx.body),kind=text(body.kind,20);
    const rows=body.rows;
    const requestId=text(body.requestId,90);
    const fingerprint=text(body.fingerprint,64);
    if(!['rooms','sections','enrollments'].includes(kind)
      ||!Array.isArray(rows)||rows.length<1||rows.length>15
      ||!/^[-a-f0-9]{36}$/.test(requestId))return error('Invalid import request',400);
    const actual=createHash('sha256').update(JSON.stringify({kind,rows})).digest('hex');
    if(fingerprint!==actual)return error('Rows changed after preview; preview the latest file again',409);
    const id='bulk-'+createHash('sha256').update(ctx.user!.userId+':'+requestId).digest('hex').slice(0,40);
    const old=await get<{fingerprint:string;count:number}>('cp_bulk_receipts',id);
    if(old)return old.fingerprint===fingerprint?json({ok:true,replayed:true,imported:old.count})
      :error('Import request ID already used for another file',409);
    const result=await validateImport(kind,rows);
    if(result.issues.length)return error('Import validation changed; preview again',409);
    const table=kind==='rooms'?'cp_rooms':kind==='sections'?'cp_sections':'cp_enrollments';
    try{
      await db.transact([
        db.tx.add(table,result.valid.map(x=>x.record)),
        db.tx.add('cp_bulk_receipts',[{id,fingerprint,count:result.valid.length,kind,
          createdAt:nowIso(),adminId:ctx.user!.userId}]),
      ]);
    }catch{return error('Import could not complete. Check for duplicates and retry with a new preview.',409);}
    await audit(ctx.user!.userId,'BULK_IMPORT_'+kind.toUpperCase(),'InstitutionalImport',id,'system');
    return json({ok:true,imported:result.valid.length});
  }],

  'GET /api/admin/operations': [requireAuth(), adminGuard, async () => {
    const [accounts, sections, enrollments, availability, sessions] = await Promise.all([
      list<Profile>('cp_profiles'),
      list<Section>('cp_sections'),
      list<{ studentId: string; sectionId: string }>('cp_enrollments'),
      list<{ status: string }>('cp_availability'),
      list<Meeting>('cp_sessions'),
    ]);
    const roleCounts = {
      Student: accounts.filter(p=>!p.deletedAt&&p.role==='Student').length,
      Faculty: accounts.filter(p=>!p.deletedAt&&p.role==='Faculty').length,
      Administrator: accounts.filter(p=>!p.deletedAt&&p.role==='System Administrator').length,
    };
    const classStatus: Record<string, number> = {};
    for (const section of sections) {
      const status = section.status || 'ATTENDING';
      classStatus[status] = (classStatus[status] || 0) + 1;
    }
    const now = Date.now();
    const activeQrSessions = sessions.filter((m) => m.status === 'OPEN'
      && new Date(m.endAt).getTime() > now && new Date(m.startAt).getTime() < now);
    return json({
      roleCounts,
      pendingRoles: accounts.filter((p) => !!p.roleRequest).length,
      incompleteProfiles: accounts.filter((p) => !p.onboardingComplete).length,
      sectionsWithoutRoom: sections.filter((s) => !s.room || /TBA|UNASSIGNED/i.test(s.room)).length,
      sectionsWithoutFaculty: sections.filter((s) => !s.facultyId).length,
      enrolledStudents: enrollments.length,
      publishedAvailability: availability.length,
      activeQrSessions: activeQrSessions.length,
      classStatus,
      updatedAt: nowIso(),
    });
  }],
  'POST /api/admin/section/:id/update': [requireAuth(), adminGuard, async (ctx) => {
    const current = await get<Section>('cp_sections', ctx.params.id);
    if (!current) return error('Class section not found', 404);
    const body = input(ctx.body);
    const day = text(body.day, 18);
    const startTime = text(body.startTime, 5);
    const endTime = text(body.endTime, 5);
    const room = text(body.room, 60);
    const facultyId = text(body.facultyId, 90);
    if (!validClassDay(day)
      || !timeValid(startTime) || !timeValid(endTime)
      || startTime >= endTime || !room || !facultyId) {
      return error('Enter a valid classroom, day, start time, end time, and faculty account', 400);
    }
    const faculty = await get<Profile>('cp_profiles', facultyId);
    if (!faculty || faculty.role !== 'Faculty') {
      return error('Assigned faculty must have an approved Faculty role', 400);
    }
    // Preserve session integrity; faculty or schedule cannot be changed during an active QR meeting.
    const active = (await list<Meeting>('cp_sessions')).some((m) =>
      m.sectionId === current.id && m.status === 'OPEN' && Date.parse(m.endAt) > Date.now());
    if (active) return error('Close the active QR session before editing this class schedule', 409);
    const facultyClash = await ownTeachingConflict(facultyId,day,startTime,endTime,current.id);
    if (facultyClash) return error('Assigned faculty has an overlapping '+facultyClash.courseCode+' class',409);
    const roomClash = await roomConflict(room,day,startTime,endTime,current.term,current.id);
    if (roomClash) return error('Room is booked by '+roomClash.courseCode+' on '+roomClash.day,409);
    await patch('cp_sections', current.id, { day, startTime, endTime, room, facultyId, facultyName: faculty.name });
    await audit(ctx.user!.userId, 'UPDATE_CLASS_REFERENCE', 'CourseSection', current.id, 'system');
    for (const member of await sectionMembers(current.id)) {
      await notify(member.studentId, current.courseCode + ' schedule updated',
        day + ' ' + startTime + '–' + endTime + ' · ' + room, 'class');
    }
    return json({ ok: true });
  }],
  'POST /api/admin/section/:id/rotate-code': [requireAuth(), adminGuard, async (ctx) => {
    const section = await get<Section>('cp_sections', ctx.params.id);
    if (!section) return error('Class section not found', 404);
    const joinCode = randomBytes(5).toString('hex').toUpperCase();
    await patch('cp_sections', section.id, { joinCode });
    await audit(ctx.user!.userId, 'ROTATE_JOIN_CODE', 'CourseSection', section.id, 'system');
    return json({ ok: true, joinCode, message: 'Previous code is no longer valid for new enrollments.' });
  }],

  'GET /api/admin/summary': [requireAuth(), adminGuard, async (ctx) => {
    const sections = await list<Section>('cp_sections');
    const sessions = await list<Meeting>('cp_sessions');
    const attendance = await list<Attendance>('cp_attendance');
    const accounts = await list<Profile>('cp_profiles');
    const counts = { PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 };
    for (const a of attendance) {
      if (a.academicStatus in counts) counts[a.academicStatus as keyof typeof counts]++;
    }
    await audit(ctx.user!.userId, 'VIEW_AGGREGATE_REPORT', 'Summary', 'campus', 'system');
    return json({
      accounts: accounts.length, courseSections: sections.length, qrSessions: sessions.length,
      aggregate: counts, totalRecords: attendance.length,
      note: 'Aggregate only. No student-level attendance is exposed to Administrator.',
    });
  }],
  'GET /api/admin/audit': [requireAuth(), adminGuard, async () => {
    const events = await list<{ actionType: string; targetType: string; scope: string; timestamp: string }>('cp_audit', 100);
    return json({ events: events.filter((e) => e.scope === 'system').map((e) => ({
      id: e.id, actionType: e.actionType, targetType: e.targetType, timestamp: e.timestamp,
    })) });
  }],
});
