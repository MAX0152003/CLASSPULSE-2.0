import { Fragment, useEffect, useRef, useState } from 'react';
import { api, auth, notifications, ws } from '@appdeploy/client';
import { QRCodeSVG } from 'qrcode.react';
import jsQR from 'jsqr';
import {storeQueuedScan,listQueuedScans,removeQueuedScan,migrateOldScans,nextRetry} from './offlineQueue';
import type {QueuedScan} from './offlineQueue';
import {
  Activity, ArrowRight, ArrowUpRight, Bell, BookOpen, CalendarClock, CalendarDays, Star,
  Check, CheckCircle2, ChevronRight, Clock3, CloudOff, Download, FileCheck2,
  FileText, GraduationCap, LayoutDashboard, LockKeyhole, LogIn, LogOut, Menu,
  Moon, Plus, QrCode, RefreshCcw, ScanLine, Settings, ShieldCheck,
  Sparkles, Sun, UserCheck, Users, Wifi, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Search } from 'lucide-react';

type Role = 'Student' | 'Faculty' | 'System Administrator';
type NavPage = 'Overview' | 'Classes' | 'Attendance' | 'Student Records' | 'Excuses' | 'Consultations' | 'Notifications' | 'Administration' | 'Profile' | 'Settings';
type Profile = { userId: string; name: string; email: string; role: Role; studentNumber?: string; department?: string; bio?: string; contactPhone?: string; yearLevel?: string; officeRoom?: string; roleRequest?: string; photoVerified?: boolean; onboardingComplete?: boolean; deletedAt?:string };
type FacultyLive = { facultyId: string; name: string; status: string; updatedAt: string | null; classCodes: string[]; source: string };
type ClassUpdate = { id: string; sectionId: string; type: string; message: string; room: string; publishedAt: string; courseCode: string };
type LiveSnapshot = { faculty: FacultyLive[]; updates: ClassUpdate[]; activeSessions: (Meeting & { courseCode: string })[]; updatedAt: string };
type Section = { id: string; courseCode: string; title: string; section: string; day: string; startTime: string; endTime: string; room: string; facultyId: string; facultyName: string; joinCode?: string; term: string; status: string; archivedAt?: string | null };
type Meeting = { id: string; sectionId: string; facultyId: string; meetingDate: string; startAt: string; endAt: string; openedAt: string; status: string; lateMinutes: number };
type Attendance = { id: string; sessionId: string; sectionId: string; studentId: string; academicStatus: string; verificationStatus: string; capturedAt: string; receivedAt: string; reviewReason?: string };
type SubjectDetails = {
  enrolledCount:number;
  classmates:Array<{displayName:string}>;
  moreClassmates:number;
  attendance: null | {
    present:number;late:number;absent:number;excused:number;pending:number;
    latestStatus:string|null;latestVerification:string|null;latestAt:string|null;
    rate:number|null;
  };
};
type Excuse = { id: string; sectionId: string; studentId: string; studentName?:string; absenceDate: string; reason: string; status: string; decisionReason?: string; hasFile?: boolean };
type Slot = { id: string; facultyId: string; facultyName: string; sectionId?: string; subjectCode?: string; subjectTitle?: string; startAt: string; endAt: string; capacity: number; confirmedCount: number };
type Booking = { id: string; slotId: string; studentId: string; topic: string; status: string; slot?: Slot; decisionReason?: string };
type Notice = { id: string; title: string; body: string; kind: string; createdAt: string; read: boolean };
type AuthUser = { userId: string; email?: string; name?: string };
type Dashboard = { profile: Profile; sections: Section[]; meetings: Meeting[]; attendance: Attendance[]; excuses: Excuse[]; bookings: Booking[]; notices: Notice[]; currentDate: string };
type AdminInfo = { accounts: number; courseSections: number; qrSessions: number; aggregate: Record<string, number>; totalRecords: number };
type AdminOperations = {
  roleCounts: { Student: number; Faculty: number; Administrator: number };
  pendingRoles: number; incompleteProfiles: number; sectionsWithoutRoom: number;
  sectionsWithoutFaculty: number; enrolledStudents: number;
  publishedAvailability: number; activeQrSessions: number;
  classStatus: Record<string, number>; updatedAt: string;
};
type UserDirectory = { userId: string; name: string; email: string; role: string; roleRequest: string; photoVerified: boolean };
type Outbox = QueuedScan;
type PresenceStatus = 'AVAILABLE'|'IN CLASS'|'AWAY'|'NOT SET';
type FacultyRoster = {
  section:Section; students:Array<{studentId:string;name:string;studentNumber:string;photo:string|null;
  counts:{PRESENT:number;LATE:number;ABSENT:number;EXCUSED:number};pendingReview:number;lastRecord:string|null}>;
  meetings:Meeting[]; records:Attendance[]; corrections?:Array<{id:string;attendanceId:string;sessionId:string;studentId:string;previousStatus:string;nextStatus:string;reason:string;timestamp:string}>;
};
type FormState = Record<string, string>;
type EntryMode = 'signin' | 'signup';
type SignupDraft = { name: string; email: string; studentNumber: string; requestedRole: Role };
const signupKey = 'cp-signup-draft';
function readSignupDraft(): SignupDraft | null {
  try {
    const raw = sessionStorage.getItem(signupKey);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SignupDraft>;
    return typeof v.name === 'string' && typeof v.email === 'string' ? {
      name:v.name, email:v.email, studentNumber:v.studentNumber || '',
      requestedRole:['Student','Faculty'].includes(v.requestedRole||'') ? v.requestedRole as Role : 'Student'
    } : null;
  } catch { return null; }
}

const pages: Record<Role, { page: NavPage; icon: LucideIcon; label: string }[]> = {
  Student:[
    { page:'Overview',icon:LayoutDashboard,label:'Overview' },
    { page:'Classes',icon:CalendarDays,label:'Schedule' },
    { page:'Attendance',icon:ScanLine,label:'Attendance' },
    { page:'Excuses',icon:FileText,label:'Excuses' },
    { page:'Consultations',icon:CalendarClock,label:'Consultations' },
    { page:'Notifications',icon:Bell,label:'Updates' },
    { page:'Profile',icon:Users,label:'My Profile' },
    { page:'Settings',icon:Settings,label:'Settings' },
  ],
  Faculty:[
    { page:'Overview',icon:LayoutDashboard,label:'Overview' },
    { page:'Classes',icon:CalendarDays,label:'Subjects' },
    { page:'Attendance',icon:QrCode,label:'QR Attendance' },
    { page:'Student Records',icon:Users,label:'Student Records' },
    { page:'Excuses',icon:FileText,label:'Excuses' },
    { page:'Consultations',icon:CalendarClock,label:'Consultations' },
    { page:'Notifications',icon:Bell,label:'Updates' },
    { page:'Profile',icon:Users,label:'My Profile' },
    { page:'Settings',icon:Settings,label:'Settings' },
  ],
  'System Administrator':[
    { page:'Overview',icon:LayoutDashboard,label:'Overview' },
    { page:'Administration',icon:ShieldCheck,label:'Administration' },
    { page:'Classes',icon:CalendarDays,label:'Class Directory' },
    { page:'Profile',icon:Users,label:'My Profile' },
    { page:'Settings',icon:Settings,label:'Settings' },
  ],
};
const dateFmt = (iso: string) => {
  const date = new Date(iso);
  return isNaN(date.getTime()) ? '—' : date.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
};
const dateOnly = () => {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const value=(key:string)=>parts.find(p=>p.type===key)?.value||'';
  return value('year')+'-'+value('month')+'-'+value('day');
};

function phDateOf(iso:string) {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
  const value=(key:string)=>parts.find(p=>p.type===key)?.value||'';
  return value('year')+'-'+value('month')+'-'+value('day');
}

const campusDayOptions = [
  { value: 'MW', label: 'MW · Monday / Wednesday' },
  { value: 'TTH', label: 'TTH · Tuesday / Thursday' },
  { value: 'F', label: 'F · Friday' },
  { value: 'S', label: 'S · Saturday' },
  { value: 'A', label: 'A · Sunday' },
];
function matchesClassDay(day: string, date: string) {
  const weekday = new Date(date + 'T12:00:00+08:00').getUTCDay();
  const valid: Record<string, number[]> = {
    MW: [1,3], TTH: [2,4], F: [5], S: [6],
    A: [0],
    Monday: [1], Tuesday: [2], Wednesday: [3], Thursday: [4],
    Friday: [5], Saturday: [6], Sunday: [0],
  };
  return (valid[day] || []).includes(weekday);
}
function monthByStep(month: string, offset: number) {
  const [year, index] = month.split('-').map(Number);
  const dt = new Date(year, index - 1 + offset, 1, 12);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2,'0');
}
function calendarGrid(month: string) {
  const [year, m] = month.split('-').map(Number);
  const first = new Date(year, m - 1, 1, 12);
  const offset = (first.getDay() + 6) % 7;
  const count = new Date(year, m, 0).getDate();
  return {
    title: first.toLocaleDateString('en-PH',{month:'long',year:'numeric'}),
    days: [
      ...Array.from({length:offset}, () => null as string | null),
      ...Array.from({length:count}, (_,i) => month + '-' + String(i+1).padStart(2,'0')),
    ],
  };
}


const meetingDays: Record<string,string> = {
  MW:'MO,WE',TTH:'TU,TH',F:'FR',S:'SA',A:'SU',
  Monday:'MO',Tuesday:'TU',Wednesday:'WE',Thursday:'TH',
  Friday:'FR',Saturday:'SA',Sunday:'SU',
};
function icsEscape(value:string) {
  return value.replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
}
function exportWeeklyCalendar(sections:Section[],label:string) {
  const available=sections.filter(s=>!s.archivedAt && meetingDays[s.day]);
  if (!available.length) return false;
  const today=dateOnly();
  const anchor=new Date(today+'T12:00:00+08:00').getTime();
  const generated=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const calendar=[
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//ClassPulse//Academic Schedule//EN',
    'CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'X-WR-CALNAME:ClassPulse '+icsEscape(label),
    'BEGIN:VTIMEZONE','TZID:Asia/Manila',
    'BEGIN:STANDARD','DTSTART:19700101T000000','TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800','TZNAME:PST','END:STANDARD','END:VTIMEZONE',
  ];
  for (const s of available) {
    let next='';
    for (let n=0;n<8;n++) {
      const date=phDateOf(new Date(anchor+n*86400000).toISOString());
      if (matchesClassDay(s.day,date)) {next=date;break;}
    }
    if (!next) continue;
    const stamp=(time:string)=>next.replace(/-/g,'')+'T'+time.replace(':','')+'00';
    const uid='classpulse-'+s.id.replace(/[^A-Za-z0-9-]/g,'')+'@academic';
    calendar.push(
      'BEGIN:VEVENT',
      'UID:'+uid,'DTSTAMP:'+generated,
      'SUMMARY:'+icsEscape(s.courseCode+' · '+s.title),
      'LOCATION:'+icsEscape(s.room || 'Room not assigned'),
      'DESCRIPTION:'+icsEscape(s.section+' | '+s.facultyName+' | '+s.term+' | Workspace schedule; verify against approved COR'),
      'DTSTART;TZID=Asia/Manila:'+stamp(s.startTime),
      'DTEND;TZID=Asia/Manila:'+stamp(s.endTime),
      'RRULE:FREQ=WEEKLY;COUNT='+(s.day==='MW'||s.day==='TTH'?32:16)+';BYDAY='+meetingDays[s.day],
      'BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:ClassPulse class reminder',
      'TRIGGER:-PT15M','END:VALARM','END:VEVENT',
    );
  }
  calendar.push('END:VCALENDAR');
  const blob=new Blob([calendar.join('\r\n')+'\r\n'],{type:'text/calendar;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const anchorElement=document.createElement('a');
  anchorElement.href=url;
  anchorElement.download='ClassPulse-'+label.toLowerCase().replace(/[^a-z0-9-]/g,'-')+'-schedule.ics';
  anchorElement.click();
  URL.revokeObjectURL(url);
  return true;
}
function ClassDayFocus({ sections }: { sections: Section[] }) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const interval = window.setInterval(() => setClock(new Date()), 60000);
    return () => window.clearInterval(interval);
  }, []);
  const timeNow = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(clock);
  const minutesOf = (time: string) => {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  };
  const campusMinute = minutesOf(timeNow);
  const todaySections = sections.filter(section =>
    !section.archivedAt && matchesClassDay(section.day, dateOnly())
  ).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const current = todaySections.find(section =>
    minutesOf(section.startTime) <= campusMinute && minutesOf(section.endTime) > campusMinute
  );
  const upcoming = todaySections.find(section => minutesOf(section.startTime) > campusMinute);
  const focus = current || upcoming;
  const untilStart = upcoming ? minutesOf(upcoming.startTime) - campusMinute : 0;
  const headline = current ? 'Scheduled for this time'
    : upcoming ? (untilStart < 60 ? 'Next class in ' + untilStart + ' min'
      : 'Next class in ' + Math.floor(untilStart / 60) + 'h ' + (untilStart % 60) + 'm')
      : 'Your schedule is clear for the rest of today';
  return <section className='cp-day-focus' aria-label='Today academic focus'>
    <div className='cp-day-focus-badge'><CalendarClock size={21}/></div>
    <div className='cp-day-focus-body'>
      <span className='cp-day-focus-kicker'>TODAY FOCUS <span aria-hidden='true'>·</span> {timeNow} PHT</span>
      <strong>{headline}</strong>
      {focus ? <p>{focus.courseCode} · {focus.title} <span aria-hidden='true'>·</span> {focus.startTime}–{focus.endTime} <span aria-hidden='true'>·</span> {focus.room || 'Room not assigned'}</p>
        : <p>{todaySections.length ? 'Classes finished today.' : 'No classes today.'}</p>}
    </div>
  </section>;
}

function OfflineSyncCenter({
  scans, online, syncing, problem, onSync, onRetry,
}: {
  scans:Outbox[];
  online:boolean;
  syncing:boolean;
  problem:string;
  onSync:()=>void;
  onRetry:()=>void;
}) {
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{
    if(!scans.length)return;
    const interval=window.setInterval(()=>setNow(Date.now()),60000);
    return ()=>window.clearInterval(interval);
  },[scans.length]);
  const limit=12*60*60*1000;
  const pending=scans.filter(s=>s.state==='PENDING');
  const review=scans.filter(s=>s.state==='NEEDS_ATTENTION');
  const eligible=pending.some(s=>now-Date.parse(s.capturedAt)<=limit);
  const retryEligible=review.some(s=>now-Date.parse(s.capturedAt)<limit);
  return <section className='cp-panel cp-sync-center' aria-label='Offline QR synchronization'>
    <div className='cp-sync-head'>
      <span className='cp-sync-icon'><CloudOff size={20}/></span>
      <div><span className='cp-sync-label'>OFFLINE ATTENDANCE</span>
        <h3>Sync center</h3>
        <small>{pending.length} pending · {review.length} review · 12-hour limit</small></div>
      <span className={'cp-sync-online'+(online?' connected':'')}>{online?'Online':'Offline'}</span>
    </div>
    {problem&&<p className='cp-sync-error' role='alert'>{problem}</p>}
    {scans.length ? <div className='cp-sync-list'>
      {[...scans].sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt)).map(s=>{
        const left=limit-(now-Date.parse(s.capturedAt));
        const mins=Math.max(0,Math.ceil(left/60000));
        const label=mins?Math.floor(mins/60)+'h '+mins%60+'m remaining':'Window ended';
        const attention=s.state==='NEEDS_ATTENTION'||left<=0;
        const progress=Math.max(0,Math.min(100,Math.round(left/limit*100)));
        return <div className='cp-sync-item' key={s.id}>
          <div className='cp-sync-item-line'><strong>{attention?'Needs review':'Pending scan'}</strong>
            <span>{label}</span></div>
          <small>{dateFmt(s.capturedAt)}</small>
          {s.lastError&&s.state==='NEEDS_ATTENTION'&&<small className='cp-sync-error'>{s.lastError}</small>}
          <div className='cp-sync-progress' role='progressbar' aria-label='12-hour sync time remaining'
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <i style={{width:progress+'%'}}/></div>
        </div>;
      })}
    </div> : <p className='cp-sync-empty'><CheckCircle2 size={16}/> No queued scans.</p>}
    {scans.length>0&&<div className='cp-sync-buttons'>
      <button type='button' className='cp-button dark' onClick={onSync}
        disabled={!online||syncing||!eligible}><RefreshCcw size={15}/>{syncing?'Syncing…':'Sync now'}</button>
      {retryEligible&&<button type='button' className='cp-mini-btn' disabled={!online||syncing}
        onClick={onRetry}>Retry</button>}
    </div>}
  </section>;
}

function ExcuseDateChooser({
  section,month,onMonth,selected,onSelect,
}:{
  section:Section|undefined;
  month:string;
  onMonth:(month:string)=>void;
  selected:string;
  onSelect:(date:string)=>void;
}){
  const view=calendarGrid(month);
  const currentMonth=dateOnly().slice(0,7);
  const earliest=monthByStep(currentMonth,-12);
  const latest=monthByStep(currentMonth,12);
  return <section className='cp-excuse-date-chooser' aria-label='Scheduled absence date'>
    <div className='cp-excuse-calendar-heading'>
      <div><strong>Absence date</strong>
        <small>{section?'Scheduled days: '+section.day:'Choose a subject first'}</small></div>
      <div className='cp-excuse-calendar-nav'>
        <button type='button' aria-label='Previous month' disabled={month<=earliest}
          onClick={()=>onMonth(monthByStep(month,-1))}><ChevronRight size={17}/></button>
        <strong>{view.title}</strong>
        <button type='button' aria-label='Next month' disabled={month>=latest}
          onClick={()=>onMonth(monthByStep(month,1))}><ChevronRight size={17}/></button>
      </div>
    </div>
    <div className='cp-excuse-calendar-week'>
      {['M','T','W','T','F','S','S'].map((day,index)=><span key={index}>{day}</span>)}
    </div>
    <div className='cp-excuse-calendar-grid'>
      {view.days.map((date,index)=>date
        ? <button key={date} type='button'
            className={'cp-excuse-calendar-day'+(selected===date?' selected':'')+
              (date===dateOnly()?' today':'')}
            aria-pressed={selected===date}
            aria-label={date+(section&&matchesClassDay(section.day,date)?' available':' not scheduled')}
            disabled={!section||!matchesClassDay(section.day,date)}
            onClick={()=>onSelect(date)}>{Number(date.slice(-2))}</button>
        : <span className='cp-excuse-calendar-gap' key={'gap-'+index}/>)}
    </div>
    <p className='cp-excuse-calendar-selected'>
      <CalendarDays size={15}/>
      {selected?new Date(selected+'T12:00:00+08:00').toLocaleDateString('en-PH',{
        timeZone:'Asia/Manila',weekday:'short',month:'long',day:'numeric',year:'numeric',
      }):'Select an available class date'}
      {selected&&<button type='button' onClick={()=>onSelect('')}>Clear</button>}
    </p>
  </section>;
}

function ExcuseFileStack({
  excuses, sections, isFaculty, onAttachment, onDecision,
}: {
  excuses:Excuse[];
  sections:Section[];
  isFaculty:boolean;
  onAttachment:(excuseId:string)=>void;
  onDecision:(excuse:Excuse)=>void;
}) {
  const [openId,setOpenId]=useState<string|null>(null);
  const [visibleCount,setVisibleCount]=useState(4);
  const ordered=[...excuses].sort((a,b)=>b.absenceDate.localeCompare(a.absenceDate));
  return <div className='cp-letter-library'>
    <div className='cp-letter-library-top'>
      <strong>Excuse letters</strong><span>{excuses.length} total</span>
    </div>
    <div className='cp-letter-stack'>
      {ordered.slice(0,visibleCount).map((e,index)=>{
        const section=sections.find(s=>s.id===e.sectionId);
        const expanded=openId===e.id;
        const teacher=section?.facultyName||'Course Instructor';
        const monthLabel=new Date(e.absenceDate+'T12:00:00+08:00')
          .toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric',
            timeZone:'Asia/Manila'});
        return <article className={'cp-letter-paper'+(expanded?' is-open':'')} key={e.id}>
          <button className='cp-letter-paper-head' type='button' aria-expanded={expanded}
            onClick={()=>setOpenId(previous=>previous===e.id?null:e.id)}>
            <span className='cp-letter-paper-icon'><FileText size={18}/></span>
            <span className='cp-letter-paper-heading'>
              <strong>{section?.courseCode||'Class'} · {monthLabel}</strong>
              <small>{isFaculty?(e.studentName||'Enrolled student'):teacher}</small>
            </span>
            <Pill color={e.status==='APPROVED'?'green':e.status==='REJECTED'?'red':'amber'}>{e.status}</Pill>
            <ChevronRight size={16} className={expanded?'rotated':''}/>
          </button>
          {!expanded&&<p className='cp-letter-preview'>{e.reason}</p>}
          {expanded&&<div className='cp-letter-document'>
            <div className='cp-letter-letterhead'><strong>CLASS PULSE</strong>
              <small>Mindanao State University · Main Campus</small></div>
            <div className='cp-letter-date'>{monthLabel}</div>
            <p className='cp-letter-recipient'>To: {teacher}</p>
            <strong className='cp-letter-subject'>Re: Absence in {section?.courseCode||'class'}</strong>
            <p className='cp-letter-salutation'>Dear Professor,</p>
            <p className='cp-letter-body'>{e.reason}</p>
            <p className='cp-letter-signature'>Respectfully,<strong>{e.studentName||'Enrolled student'}</strong></p>
            <div className='cp-letter-footnote'>
              <small>Submitted through ClassPulse · {e.status}</small>
              {e.decisionReason&&<p>Faculty response: {e.decisionReason}</p>}
            </div>
            <div className='cp-letter-actions'>
              {e.hasFile&&<button className='cp-mini-btn' type='button'
                onClick={()=>onAttachment(e.id)}><FileText size={15}/> Attachment</button>}
              {isFaculty&&e.status==='PENDING'&&<button type='button' className='cp-mini-btn primary'
                onClick={()=>onDecision(e)}>Review <ArrowRight size={15}/></button>}
            </div>
          </div>}
        </article>;
      })}
    </div>
    {ordered.length>visibleCount&&<button type='button' className='cp-letter-more'
      onClick={()=>setVisibleCount(count=>count+4)}>Show more letters <ChevronRight size={15}/></button>}
    {ordered.length===0&&<Empty title='No excuse letters' detail='New requests appear here.'/>}
  </div>;
}

function SubjectDetailPanel({
  section, role, onClose, onRoster,
}: {
  section:Section;
  role:Role;
  onClose:()=>void;
  onRoster?:(sectionId:string)=>void;
}) {
  const [details,setDetails]=useState<SubjectDetails|null>(null);
  const [loading,setLoading]=useState(true);
  const [problem,setProblem]=useState('');
  useEffect(()=>{
    let active=true;
    setDetails(null);
    setLoading(true);
    setProblem('');
    api.get('/api/sections/'+encodeURIComponent(section.id)+'/details')
      .then(response=>{if(active)setDetails(response.data as SubjectDetails);})
      .catch(err=>{if(active)setProblem(apiMessage(err));})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[section.id]);
  const attendance=details?.attendance;
  const counts=attendance?[
    {label:'Present',value:attendance.present},
    {label:'Late',value:attendance.late},
    {label:'Absent',value:attendance.absent},
    {label:'Excused',value:attendance.excused},
  ]:[];
  return <section className='cp-subject-detail' aria-label={'Details for '+section.courseCode}>
    <div className='cp-subject-detail-head'>
      <span className='cp-subject-detail-icon'><BookOpen size={20}/></span>
      <div><small>CLASS DETAILS</small><h3>{section.courseCode} · {section.title}</h3>
        <p>{section.section} · {section.term}</p></div>
      <button type='button' className='cp-subject-detail-close' onClick={onClose}
        aria-label='Close subject details'><X size={17}/></button>
    </div>
    <div className='cp-subject-meta'>
      <div><span>Professor</span><strong>{section.facultyName||'Not assigned'}</strong></div>
      <div><span>Schedule</span><strong>{section.day} · {section.startTime}–{section.endTime}</strong></div>
      <div><span>Room</span><strong>{section.room||'Not assigned'}</strong></div>
      <div><span>Class status</span><Pill>{section.status}</Pill></div>
    </div>
    <div className='cp-subject-detail-columns'>
      <section className='cp-subject-detail-group'>
        <div className='cp-subject-subhead'><Users size={16}/>
          <strong>Enrolled students</strong>
          {details&&<span className='cp-subject-count'>{details.enrolledCount}</span>}</div>
        {loading&&<p className='cp-subject-placeholder'>Loading enrolled students…</p>}
        {!loading&&problem&&<p className='cp-subject-error' role='alert'>{problem}</p>}
        {details&&<div className='cp-subject-classmates'>
          {details.classmates.map((person,i)=><div key={person.displayName+'-'+i}
            className='cp-subject-classmate'><span className='cp-subject-avatar'>
              {person.displayName.slice(0,1).toUpperCase()}</span>
              <span>{person.displayName}</span></div>)}
          {details.classmates.length===0&&<p className='cp-subject-placeholder'>No enrolled students yet.</p>}
          {details.moreClassmates>0&&<small>+{details.moreClassmates} more students</small>}
        </div>}
        {role==='Student'&&<small className='cp-subject-privacy'>Classmates shown without IDs or attendance details.</small>}
        {role==='Faculty'&&onRoster&&<button type='button' className='cp-mini-btn cp-subject-roster-link'
          onClick={()=>onRoster(section.id)}><Users size={15}/> View full roster <ArrowRight size={14}/></button>}
      </section>
      {role==='Student'&&<section className='cp-subject-detail-group'>
        <div className='cp-subject-subhead'><CheckCircle2 size={16}/><strong>My attendance</strong></div>
        {loading&&<p className='cp-subject-placeholder'>Checking attendance…</p>}
        {attendance&&<div className='cp-subject-attendance'>
          <div className='cp-subject-current'><span>Latest record</span>
            <strong>{attendance.latestStatus||'No QR record yet'}</strong>
            {attendance.latestVerification&&<small>{attendance.latestVerification.replace(/_/g,' ')}</small>}
          </div>
          <div className='cp-subject-attendance-grid'>
            {counts.map(item=><div key={item.label}><strong>{item.value}</strong>
              <span>{item.label}</span></div>)}
          </div>
          <p className='cp-subject-total'>{attendance.rate===null?'No finalized rate':attendance.rate+'% recorded attendance'}
            {attendance.pending>0?' · '+attendance.pending+' pending review':''}</p>
          {attendance.latestAt&&<small>Last scanned: {dateFmt(attendance.latestAt)}</small>}
          <small>Only verified scans affect the summary. No QR session means no automatic absence.</small>
        </div>}
        {!loading&&!attendance&&!problem&&<p className='cp-subject-placeholder'>No attendance data.</p>}
      </section>}
      {role==='Faculty'&&<section className='cp-subject-detail-group cp-subject-faculty-hint'>
        <div className='cp-subject-subhead'><ShieldCheck size={16}/><strong>Attendance records</strong></div>
        <p>Review attendance for this subject in Student Records.</p>
        {onRoster&&<button type='button' className='cp-mini-btn'
          onClick={()=>onRoster(section.id)}>Open student records <ArrowRight size={14}/></button>}
      </section>}
    </div>
  </section>;
}

function WeekTimetable({
  sections, role, onRoster,
}: {
  sections:Section[];
  role:Role;
  onRoster?:(sectionId:string)=>void;
}) {
  const days=[
    {label:'Monday',short:'Mon',code:'M'},
    {label:'Tuesday',short:'Tue',code:'T'},
    {label:'Wednesday',short:'Wed',code:'W'},
    {label:'Thursday',short:'Thu',code:'TH'},
    {label:'Friday',short:'Fri',code:'F'},
    {label:'Saturday',short:'Sat',code:'S'},
    {label:'Sunday',short:'Sun',code:'A'},
  ];
  const today=(new Date(dateOnly()+'T12:00:00+08:00').getUTCDay()+6)%7;
  const [active,setActive]=useState(today);
  const [dragX,setDragX]=useState(0);
  const [dragging,setDragging]=useState(false);
  const [selectedClassId,setSelectedClassId]=useState<string|null>(null);
  const [flying,setFlying]=useState<'left'|'right'|null>(null);
  const gesture=useRef<{pointerId:number;x:number;y:number}|null>(null);
  const flight=useRef<number|null>(null);
  const motionLocked=useRef(false);
  useEffect(()=>()=>{if(flight.current!==null)window.clearTimeout(flight.current);},[]);
  const getDaySections=(index:number)=>sections.filter(s=>
    !s.archivedAt&&matchesClassDay(s.day,
      phDateOf(new Date(Date.parse(dateOnly()+'T12:00:00+08:00')-
        ((new Date(dateOnly()+'T12:00:00+08:00').getUTCDay()+6)%7)*86400000+
        ((index+7)%7)*86400000).toISOString())))
    .sort((a,b)=>a.startTime.localeCompare(b.startTime));
  const step=(delta:number)=>{
    if(motionLocked.current)return;
    setSelectedClassId(null);
    const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if(reduced){
      setActive(prev=>(prev+delta+7)%7);setDragX(0);setDragging(false);setFlying(null);
      return;
    }
    motionLocked.current=true;
    setDragging(false);setFlying(delta>0?'left':'right');
    flight.current=window.setTimeout(()=>{
      setActive(prev=>(prev+delta+7)%7);
      setDragX(0);setFlying(null);motionLocked.current=false;
      flight.current=null;
    },300);
  };
  const jump=(index:number)=>{
    if(motionLocked.current)return;
    setActive(index);setDragX(0);setDragging(false);setFlying(null);setSelectedClassId(null);
  };
  const onDragStart=(e:React.PointerEvent<HTMLDivElement>)=>{
    if(motionLocked.current)return;
    gesture.current={pointerId:e.pointerId,x:e.clientX,y:e.clientY};
    setDragging(false);
    // Capture only after a horizontal gesture; allow taps on class-detail buttons.
  };
  const onDragMove=(e:React.PointerEvent<HTMLDivElement>)=>{
    const start=gesture.current;
    if(!start||start.pointerId!==e.pointerId||motionLocked.current)return;
    const dx=e.clientX-start.x,dy=e.clientY-start.y;
    if(Math.abs(dy)>Math.abs(dx)&&Math.abs(dy)>10)return;
    if(Math.abs(dx)<8||Math.abs(dx)<Math.abs(dy)*1.2)return;
    if(!e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setDragX(Math.max(-240,Math.min(240,dx)));
  };
  const onDragEnd=(e:React.PointerEvent<HTMLDivElement>)=>{
    const start=gesture.current;
    if(!start||start.pointerId!==e.pointerId)return;
    gesture.current=null;
    const dx=e.clientX-start.x,dy=e.clientY-start.y;
    if(Math.abs(dx)>=65&&Math.abs(dx)>Math.abs(dy)*1.15)step(dx<0?1:-1);
    else{setDragX(0);setDragging(false);}
  };
  const onDragCancel=()=>{
    gesture.current=null;setDragX(0);setDragging(false);
  };
  const direction=(dragX>8||flying==='right')?-1:1;
  const second=(active+direction+7)%7;
  const third=(active+direction*2+14)%7;
  const topClasses=getDaySections(active);
  const previewClasses=getDaySections(second);
  const farClasses=getDaySections(third);
  const selectedDetails=topClasses.find(s=>s.id===selectedClassId);
  const tall=Math.max(topClasses.length,previewClasses.length,farClasses.length);
  // Card stack includes a dedicated clearance area for the 2 visible undercards.
  // Keep every layer inside the stage so weekday controls below are never obscured.
  const deckHeight=Math.min(760,Math.max(350,260+Math.min(5,tall)*92));
  const reducedHint='Swipe for next day · swipe back for previous';
  const renderCard=(dayIndex:number,depth:0|1|2|3)=>{
    const day=days[dayIndex];
    const entries=depth===0?topClasses:depth===1?previewClasses:depth===2?farClasses:getDaySections(dayIndex);
    return <article key={dayIndex+'-'+depth} aria-hidden={depth!==0}
      className={'cp-deck-card cp-deck-layer-'+depth+
        (depth===3?' cp-deck-return-card':'')+
        (depth===0&&dragging?' is-dragging':'')+
        (depth===0&&flying?' is-flying':'')+
        (depth===0&&flying==='right'?' is-receding':'')}
      data-day={day.short}
      style={depth===0?{
        transform:flying==='left'
          ?'translate3d(-128%,-12px,45px) rotateY(-14deg) rotateZ(-12deg)'
          :flying==='right'
            ?'translate3d(0,0,0)'
            :dragX>0
              ?'translate3d(0,0,0)'
              :'translate3d('+dragX+'px,'+(Math.min(17,Math.abs(dragX)*.07))+'px,'+
                Math.min(35,Math.abs(dragX)*.13)+'px) rotateY('+(dragX/20)+
                'deg) rotateZ('+(dragX/29)+'deg)',
        opacity:flying==='left'?0:1,
      }:undefined}>
      <div className='cp-deck-card-heading'>
        <span className='cp-deck-day-number'>{String(dayIndex+1).padStart(2,'0')}</span>
        <div className='cp-deck-card-day'>
          <small>MY CLASS WEEK</small>
          <strong>{day.label}</strong>
          <span>{entries.length} class{entries.length===1?'':'es'}</span>
        </div>
        <span className='cp-deck-code'>{day.code}</span>
      </div>
      <div className='cp-deck-classes'>
        {entries.length?entries.map(s=><button type='button' className='cp-deck-class cp-deck-class-action'
          key={s.id} disabled={depth!==0} aria-expanded={depth===0&&selectedClassId===s.id}
          onClick={()=>{if(!dragging&&!flying)setSelectedClassId(v=>v===s.id?null:s.id);}}>
          <span className='cp-deck-class-time'><Clock3 size={15}/>{s.startTime}–{s.endTime}</span>
          <div><strong>{s.courseCode} · {s.title}</strong>
            <small>{s.section} · {s.room||'Room not assigned'}</small>
            <small>{s.facultyName}</small></div>
          <Pill>{s.status}</Pill>
        </button>):<div className='cp-deck-empty'><CalendarDays size={29}/>
          <strong>No classes</strong>
        </div>}
      </div>
      <div className='cp-deck-card-bottom'>
        <span>CLASSPULSE</span>
        <span>{day.short==='Sun'?'A · SUNDAY':day.label.toUpperCase()}</span>
      </div>
      {depth!==0&&<span className='cp-deck-peek' aria-hidden='true'>{day.short}</span>}
    </article>;
  };
  if(selectedDetails){
    return <div className='cp-week-deck cp-week-deck-focused'>
      <SubjectDetailPanel key={selectedDetails.id} section={selectedDetails}
        role={role} onRoster={onRoster} onClose={()=>setSelectedClassId(null)}/>
    </div>;
  }
  return <div className='cp-week-deck'>
    <div className='cp-deck-titlebar'>
      <div><span className='cp-deck-eyebrow'>SCHEDULE</span>
        <h4>{days[active].label}<small>{String(active+1).padStart(2,'0')} / 07</small></h4>
        <p>{topClasses.length} class{topClasses.length===1?'':'es'} this day</p>
      </div>
    </div>
    <div className='cp-deck-days cp-deck-days-top' role='group' aria-label='Jump to a class day'>
      {days.map((day,index)=><button type='button' key={day.short} aria-pressed={active===index}
        disabled={!!flying} className={active===index?'active':''} onClick={()=>jump(index)}>
        <span>{day.short}</span>{getDaySections(index).length>0&&<i aria-hidden='true'/>}
      </button>)}
    </div>
    <div className='cp-deck-stage' tabIndex={0} role='group'
      aria-label={'Stacked class cards. Currently viewing '+days[active].label+
        '. Swipe left for the next day or right for the previous day. Use weekday tabs or keyboard arrows.'}
      style={{height:deckHeight}}
      onPointerDown={onDragStart} onPointerMove={onDragMove}
      onPointerUp={onDragEnd} onPointerCancel={onDragCancel}
      onKeyDown={e=>{
        if(e.key==='ArrowLeft'){e.preventDefault();step(-1);}
        else if(e.key==='ArrowRight'){e.preventDefault();step(1);}
        else if(e.key==='Home'){e.preventDefault();jump(0);}
        else if(e.key==='End'){e.preventDefault();jump(6);}
      }}>
      {renderCard(third,2)}
      {renderCard(second,1)}
      {renderCard(active,0)}
      {flying==='right'&&renderCard((active+6)%7,3)}
    </div>
    <div className='cp-deck-bottom'>
      <p><span className='cp-deck-hand'><ScanLine size={15}/></span>{reducedHint}</p>
    </div>
    <span className='cp-deck-announcement' aria-live='polite'>
      {days[active].label}: {topClasses.length} scheduled class{topClasses.length===1?'':'es'}
    </span>
  </div>;
}

const initialForm = { name: '', requestedRole: 'Student', studentNumber: '', courseCode: '', title: '', section: '', term: '2026–2027', day: 'MW', startTime: '08:00', endTime: '09:30', room: '', facultyId: '', joinCode: '', status: 'ATTENDING', message: '', absenceDate: dateOnly(), reason: '', topic: '', startAt: '', endAt: '', capacity: '1', slotStartTime: '10:00', slotEndTime: '10:30' };

function apiMessage(e: unknown) {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'The request failed. Check your connection and retry.';
}


function LogoMark({ large = false }: { large?: boolean }) {
  return <img className={'cp-unified-logo ' + (large ? 'large' : '')}
    src='/resources/classpulse-symbol.svg' alt='ClassPulse symbol' draggable={false}/>;
}
function Brand({ light = false }: { light?: boolean }) {
  return <div className={'cp-brand ' + (light ? 'on-dark' : '')}>
    <LogoMark/><div><strong>Class<span className='cp-pulse-word'>Pulse</span></strong><small>MSU MAIN CAMPUS</small></div>
  </div>;
}
function Pill({ children, color = 'default' }: { children: React.ReactNode; color?: string }) {
  return <span className={'cp-pill ' + color}>{children}</span>;
}
function Empty({ title, detail, icon: Icon = BookOpen }: { title: string; detail: string; icon?: LucideIcon }) {
  return <div className='cp-empty'><span><Icon size={30}/></span><strong>{title}</strong><p>{detail}</p></div>;
}
function SectionTitle({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle?: string; action?: React.ReactNode }) {
  return <div className='cp-section-heading'><div><span>{eyebrow}</span><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;
}
function Field({ label, name, form, update, type = 'text', placeholder, required = false, children }: {
  label: string; name: string; form: FormState; update: (name: string, value: string) => void;
  type?: string; placeholder?: string; required?: boolean; children?: React.ReactNode;
}) {
  return <label className='cp-field'><span>{label}</span>{children
    ? <select value={form[name] || ''} onChange={(e) => update(name, e.target.value)} required={required}>{children}</select>
    : <input value={form[name] || ''} type={type} onChange={(e) => update(name, e.target.value)} placeholder={placeholder} required={required}/>}
  </label>;
}

type ImportKind='rooms'|'sections'|'enrollments';
type ImportReport={total:number;valid:number;issues:{row:number;reason:string}[];fingerprint:string;example:Record<string,string>[]};
const csvColumns:Record<ImportKind,string[]>={
  rooms:['code','building','capacity','status'],
  sections:['courseCode','title','section','term','day','startTime','endTime','room','facultyEmail'],
  enrollments:['studentEmail','courseCode','section','term'],
};
function parseCsvImport(source:string,kind:ImportKind) {
  if(source.length>200000)throw Error('File is too large (maximum 200 KB)');
  const rows:string[][]=[];let cols:string[]=[],value='',inside=false;
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(inside){
      if(c==='"'&&source[i+1]==='"'){value+='"';i++;}
      else if(c==='"')inside=false;
      else value+=c;
    }else if(c==='"')inside=true;
    else if(c===','){cols.push(value.trim());value='';}
    else if(c==='\n'){cols.push(value.trim());rows.push(cols);cols=[];value='';}
    else if(c!=='\r')value+=c;
  }
  if(inside)throw Error('Unclosed quote in CSV');
  if(value||cols.length){cols.push(value.trim());rows.push(cols);}
  const head=(rows.shift()||[]).map(x=>x.replace(/^\uFEFF/,''));
  const expected=csvColumns[kind];
  if(head.length!==expected.length || expected.some((x,i)=>head[i]!==x))
    throw Error('Use template headings: '+expected.join(', '));
  if(rows.length<1||rows.length>15)throw Error('CSV must have 1–15 data rows');
  return rows.map((cells,i)=>{
    if(cells.length!==expected.length)throw Error('Invalid column count on row '+(i+2));
    const obj:Record<string,string>={};
    expected.forEach((key,j)=>{obj[key]=cells[j];});
    return obj;
  });
}
function downloadImportTemplate(kind:ImportKind) {
  const example=kind==='rooms'?['CICS LAB 1','CICS','40','AVAILABLE']:
    kind==='sections'?['IT 103','Database Management','BSIT 3A','First Semester','MW','08:00','09:30','CICS LAB 1','faculty@msumain.edu.ph']:
    ['student@msumain.edu.ph','IT 103','BSIT 3A','First Semester'];
  csvExport('classpulse-'+kind+'-template.csv',[Object.fromEntries(csvColumns[kind].map((key,i)=>[key,example[i]]))]);
}

function csvExport(filename: string, rows: Record<string, string | number>[]) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const esc = (v: string | number) => {
    const raw=String(v??'');
    // Prevent spreadsheet software from interpreting imported names as executable formulas.
    const safe=/^[\s]*[=+@\-]/.test(raw)?'\''+raw:raw;
    return '"'+safe.replace(/"/g,'""')+'"';
  };
  const csv = '\uFEFF' + [keys.map(esc).join(','), ...rows.map((row) => keys.map((k) => esc(row[k])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
async function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}



type AttendanceInsight={ sectionId:string;courseCode:string;records:number;present:number;late:number;absent:number;excused:number;unverified:number;rate:number|null;message:string;level:'neutral'|'watch'|'review'|'good' };
function deriveAttendanceInsights(sections:Section[],meetings:Meeting[],attendance:Attendance[],studentId?:string):AttendanceInsight[] {
  return sections.filter(s=>!s.archivedAt).map(section=>{
    const meetingIds=new Set(meetings.filter(m=>m.sectionId===section.id).map(m=>m.id));
    const related=attendance.filter(a=>a.sectionId===section.id &&
      (!studentId||a.studentId===studentId));
    const verified=related.filter(a=>['ACCEPTED','FACULTY_APPROVED','FACULTY_CORRECTED'].includes(a.verificationStatus));
    const present=verified.filter(a=>a.academicStatus==='PRESENT').length;
    const late=verified.filter(a=>a.academicStatus==='LATE').length;
    const absent=verified.filter(a=>a.academicStatus==='ABSENT').length;
    const excused=verified.filter(a=>a.academicStatus==='EXCUSED').length;
    const unverified=related.length-verified.length;
    const total=present+late+absent+excused;
    const rate=total?Math.round((present+late+excused)/total*100):null;
    const seen=meetingIds.size;
    const level:AttendanceInsight['level']= unverified?'review':
      !total?'neutral':absent>=2||late>=4?'watch':'good';
    const message=unverified ? unverified+' attendance scan(s) awaiting verification'
      : !seen?'No faculty QR sessions yet'
      : !total?'No finalized attendance record yet'
      : absent>=2?'Review your '+absent+' recorded absences with faculty'
      : late>=4?'Discuss '+late+' late records with faculty':'Records currently appear consistent';
    return {sectionId:section.id,courseCode:section.courseCode,records:related.length,
      present,late,absent,excused,unverified,rate,message,level};
  });
}
function StudentAttendanceInsights({sections,meetings,attendance}:{
  sections:Section[];meetings:Meeting[];attendance:Attendance[]}) {
  const insights=deriveAttendanceInsights(sections,meetings,attendance);
  return <section className='cp-panel cp-guidance-panel'>
    <SectionTitle eyebrow='ATTENDANCE GUIDANCE' title='Your academic check-in'
      subtitle='Advisory based on recorded QR sessions—not a grade or official MSU standing.'/>
    {insights.length===0?<Empty title='No enrolled subjects yet' detail='Your attendance guidance will appear after joining classes.' icon={BookOpen}/>:
    <div className='cp-guidance-list'>{insights.map(row=><div className={'cp-guidance-row '+row.level} key={row.sectionId}>
      <div className='cp-guidance-title'><strong>{row.courseCode}</strong><small>{row.message}</small></div>
      <div className='cp-guidance-counts'>
        <span><b>{row.present}</b> present</span>
        <span><b>{row.late}</b> late</span>
        <span><b>{row.absent}</b> absent</span>
      </div>
      <span className='cp-guidance-rate'>{row.rate===null?'Not rated':row.rate+'%'}<small>{row.unverified?'Review pending':'Verified only'}</small></span>
    </div>)}</div>}
    <p className='cp-guidance-disclaimer'><ShieldCheck size={16}/> Never an automatic FDA/drop decision. Faculty and approved university policy determine academic outcomes.</p>
  </section>;
}

function AttendanceAnalytics({ attendance, meetings }: { attendance: Attendance[]; meetings: Meeting[] }) {
  const meetingById = new Map(meetings.map((m) => [m.id, m]));
  const localNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const mondayUtc = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate())
    - ((localNow.getUTCDay() + 6) % 7) * 86400000 - 8 * 60 * 60 * 1000;
  const weeks = Array.from({ length: 4 }, (_, index) => {
    const start = mondayUtc - (3 - index) * 7 * 86400000;
    const stop = start + 7 * 86400000;
    const records = attendance.filter((a) => {
      const meeting = meetingById.get(a.sessionId);
      if (!meeting) return false;
      const time = Date.parse(meeting.startAt);
      return time >= start && time < stop && ['PRESENT', 'LATE', 'ABSENT'].includes(a.academicStatus);
    });
    const present = records.filter((a) => a.academicStatus === 'PRESENT').length;
    const late = records.filter((a) => a.academicStatus === 'LATE').length;
    const attendanceRate = records.length ? Math.round((present + late) / records.length * 100) : null;
    const punctuality = present + late ? Math.round(present / (present + late) * 100) : null;
    const label = new Date(start + 8 * 60 * 60 * 1000).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    });
    return { label, attendanceRate, punctuality, count: records.length };
  });
  const hasData = weeks.some((w) => w.count > 0);
  const x = (i: number) => 51 + i * 176;
  const y = (rate: number) => 183 - rate * 1.40;
  const pathFor = (key: 'attendanceRate' | 'punctuality') => {
    let path = '';
    weeks.forEach((w, index) => {
      const rate = w[key];
      if (rate === null) return;
      const prev = index > 0 ? weeks[index - 1][key] : null;
      path += (prev === null ? ' M ' : ' L ') + x(index) + ' ' + y(rate);
    });
    return path.trim();
  };
  return <div className='cp-trend-grid'>
    <section className='cp-panel cp-trend-panel'>
      <SectionTitle eyebrow='ATTENDANCE ANALYTICS' title='Attendance Trend & Punctuality'
        subtitle='Actual verified weekly outcomes. No estimated or demo percentages.'/>
      {hasData ? <>
        <div className='cp-chart-legend'><span><i className='att'/> Attendance</span><span><i className='pun'/> Punctuality</span></div>
        <svg className='cp-trend-chart' viewBox='0 0 650 235' role='img' aria-label='Four-week attendance rate and punctuality line chart'>
          {[0,25,50,75,100].map((tick) => <g key={tick}>
            <line x1='45' x2='596' y1={y(tick)} y2={y(tick)} stroke='var(--border)' strokeDasharray='4 6'/>
            <text x='7' y={y(tick)+4} fontSize='12' fill='var(--muted)'>{tick}%</text>
          </g>)}
          {weeks.map((w,i) => <text key={w.label} x={x(i)} y='215' textAnchor='middle' fontSize='12' fill='var(--muted)'>{w.label}</text>)}
          <path d={pathFor('attendanceRate')} fill='none' stroke='#6557ef' strokeWidth='3.5' strokeLinecap='round' strokeLinejoin='round'/>
          <path d={pathFor('punctuality')} fill='none' stroke='#00a99d' strokeWidth='3.5' strokeLinecap='round' strokeLinejoin='round'/>
          {weeks.map((w,i) => <g key={i}>
            {w.attendanceRate !== null && <circle cx={x(i)} cy={y(w.attendanceRate)} r='6' fill='#6557ef' stroke='var(--panel)' strokeWidth='3'/>}
            {w.punctuality !== null && <circle cx={x(i)} cy={y(w.punctuality)} r='6' fill='#00a99d' stroke='var(--panel)' strokeWidth='3'/>}
          </g>)}
        </svg>
      </> : <Empty title='Your attendance trend will grow here' detail='Four-week trends appear after faculty opens sessions and real attendance records have been finalized.'/>}
    </section>
    <section className='cp-panel cp-four-week-panel'>
      <SectionTitle eyebrow='THE LAST FOUR WEEKS' title='4-Week Attendance & Punctuality Trends'
        subtitle='Weekly snapshot from recorded PRESENT, LATE, and ABSENT outcomes.'/>
      <div className='cp-weekly-list'>{weeks.map((w) => <div className='cp-week-row' key={w.label}>
        <div><strong>{w.label}</strong><small>{w.count} record{w.count===1?'':'s'}</small></div>
        <div className='cp-week-bars'>
          <div className='cp-week-bar'><span style={{width:(w.attendanceRate ?? 0)+'%',background:'#6557ef'}}/></div>
          <div className='cp-week-bar'><span style={{width:(w.punctuality ?? 0)+'%',background:'#00a99d'}}/></div>
        </div>
        <div><strong>{w.attendanceRate === null ? '—' : w.attendanceRate+'%'}</strong><small>{w.punctuality === null ? '—' : w.punctuality+'%'} on time</small></div>
      </div>)}</div>
      <p className='cp-chart-note'>Attendance = present + late ÷ recorded outcomes. Punctuality = present ÷ present + late. Excused and pending reviews are excluded.</p>
    </section>
  </div>;
}


type MonitorPart={label:string;value:number;color:string};
function MonitoringDonut({title,eyebrow,parts,subtitle}:{title:string;eyebrow:string;parts:MonitorPart[];subtitle:string}) {
  const total=parts.reduce((sum,p)=>sum+Math.max(0,p.value),0);
  const radius=47,circumference=2*Math.PI*radius;
  let previous=0;
  return <section className='cp-panel cp-monitor-ring-panel'>
    <SectionTitle eyebrow={eyebrow} title={title} subtitle={subtitle}/>
    <div className='cp-monitor-ring-layout'>
      <svg className='cp-monitor-ring' viewBox='0 0 140 140' role='img'
        aria-label={title+': '+parts.map(p=>p.label+' '+p.value).join(', ')}>
        <circle cx='70' cy='70' r={radius} stroke='var(--border)' strokeWidth='17' fill='none'/>
        {total>0&&parts.map(p=>{
          const fraction=Math.max(0,p.value)/total;
          const length=fraction*circumference;
          const offset=previous;
          previous+=length;
          return <circle key={p.label} cx='70' cy='70' r={radius} fill='none'
            stroke={p.color} strokeWidth='17' strokeDasharray={length+' '+(circumference-length)}
            strokeDashoffset={-offset} transform='rotate(-90 70 70)'/>;
        })}
        <text x='70' y='68' textAnchor='middle' fill='var(--text)' fontSize='25' fontWeight='650'>{total}</text>
        <text x='70' y='84' textAnchor='middle' fill='var(--muted)' fontSize='10'>total records</text>
      </svg>
      <div className='cp-monitor-legend'>
        {parts.map(part=><div key={part.label}>
          <i style={{background:part.color}}/>
          <span>{part.label}</span>
          <strong>{part.value}</strong>
          <small>{total?Math.round(part.value/total*100)+'%':'—'}</small>
        </div>)}
      </div>
    </div>
    {!total&&<p className='cp-chart-note'>No finalized data yet. This chart fills as real records become available.</p>}
  </section>;
}
function MonitoringBars({title,eyebrow,rows,subtitle}:{title:string;eyebrow:string;
  rows:Array<{label:string;value:number;total:number}>;subtitle:string}) {
  return <section className='cp-panel cp-monitor-bars-panel'>
    <SectionTitle eyebrow={eyebrow} title={title} subtitle={subtitle}/>
    <div className='cp-monitor-bars'>
      {rows.map((row,i)=>{
        const width=row.total>0?Math.min(100,Math.round(row.value/row.total*100)):0;
        return <div className='cp-monitor-bar-row' key={row.label+i}>
          <div><strong>{row.label}</strong><span>{row.total>0?width+'%':'No records'}</span></div>
          <div className='cp-monitor-track' role='meter' aria-label={row.label}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={width}>
            <i style={{width:width+'%'}}/>
          </div>
          <small>{row.value} of {row.total}</small>
        </div>;
      })}
      {!rows.length&&<Empty title='Nothing to chart yet' detail='Live data will appear after subjects or accounts are added.'/>}
    </div>
  </section>;
}

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [authError, setAuthError] = useState('');
  const [entryMode, setEntryMode] = useState<EntryMode | null>(null);
  const [authRedirecting, setAuthRedirecting] = useState(false);
  const [roleChoiceConfirmed,setRoleChoiceConfirmed]=useState(false);
  const [deleteConfirm,setDeleteConfirm]=useState('');
  const [excuseMonth,setExcuseMonth]=useState(()=>dateOnly().slice(0,7));
  const [adminInvites,setAdminInvites]=useState<Array<{
    id:string;email:string;status:'PENDING'|'ACCEPTED'|'REVOKED';expiresAt:string;createdAt:string;
  }>>([]);
  const [signupDraft, setSignupDraft] = useState<SignupDraft>(() => readSignupDraft() || {
    name:'', email:'', studentNumber:'', requestedRole:'Student'
  });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [adminConfigured, setAdminConfigured] = useState(false);
  const [page, setPage] = useState<NavPage>('Overview');
  const [noticeFilter, setNoticeFilter] = useState<'all'|'unread'|'class'|'attendance'|'requests'>('all');
  const [idCardBack,setIdCardBack]=useState(false);
  const [drawer, setDrawer] = useState(false);
  // Global edge navigation: preserve native scrolling and nested schedule-card gestures.
  useEffect(() => {
    let startX = 0, startY = 0, eligible = false;
    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { eligible = false; return; }
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], .cp-deck-card, .cp-deck, .cp-modal, [data-swipe-lock]')) {
        eligible = false; return;
      }
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      eligible = drawer || startX > window.innerWidth - Math.min(72, window.innerWidth * .18);
    };
    const onEnd = (event: TouchEvent) => {
      if (!eligible || !event.changedTouches.length) return;
      eligible = false;
      const dx = event.changedTouches[0].clientX - startX;
      const dy = event.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < 75 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
      // Swipe left from the right edge to reveal the menu; swipe right to close.
      if (!drawer && dx < 0) setDrawer(true);
      if (drawer && dx > 0) setDrawer(false);
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  }, [drawer]);

  const [theme, setTheme] = useState<'light'|'dark'>(() => localStorage.getItem('cp-live-theme')==='dark'?'dark':'light');
  const [density, setDensity] = useState<'compact'|'comfortable'|'spacious'>(() => {
    const saved = localStorage.getItem('cp-view-density');
    return saved === 'compact' || saved === 'spacious' ? saved : 'comfortable';
  });
  const [data, setData] = useState<Dashboard | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [excuses, setExcuses] = useState<Excuse[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [users, setUsers] = useState<UserDirectory[]>([]);
  const [summary, setSummary] = useState<AdminInfo | null>(null);
  const [operations, setOperations] = useState<AdminOperations | null>(null);
  const [accountQuery, setAccountQuery] = useState('');
  const [importKind,setImportKind]=useState<ImportKind>('rooms');
  const [importRows,setImportRows]=useState<Record<string,string>[]>([]);
  const [importReport,setImportReport]=useState<ImportReport|null>(null);
  const [importRequestId,setImportRequestId]=useState('');
  const [adminRooms,setAdminRooms]=useState<Array<{id:string;code:string;building:string;capacity:number;status:string}>>([]);
  const [accountView, setAccountView] = useState<'pending'|'all'|'Faculty'|'Student'>('pending');
  const [adminEvents, setAdminEvents] = useState<{ id: string; actionType: string; timestamp: string }[]>([]);
  const [live, setLive] = useState<LiveSnapshot>({ faculty: [], updates: [], activeSessions: [], updatedAt: '' });
  const [myPresence, setMyPresence] = useState<{status:PresenceStatus;updatedAt:string|null}>({status:'NOT SET',updatedAt:null});
  const confirmedPresenceRef=useRef<{status:PresenceStatus;updatedAt:string|null}>({status:'NOT SET',updatedAt:null});
  const presenceQueueRef=useRef<PresenceStatus|null>(null);
  const presenceRunningRef=useRef(false);
  const liveSocketRef=useRef<ReturnType<typeof ws.connect>|null>(null);
  const liveSubscriptionRefreshRef=useRef<(()=>void)|null>(null);
  const liveFacultyIdsRef=useRef<string[]>([]);
  const [facultyRoster, setFacultyRoster] = useState<FacultyRoster | null>(null);
  const [facultyRosterLoading, setFacultyRosterLoading] = useState(false);
  const [rosterSearch, setRosterSearch] = useState('');
  const [recordStatusFilter,setRecordStatusFilter] = useState('ALL');
  const [recordFrom,setRecordFrom] = useState('');
  const [recordUntil,setRecordUntil] = useState('');
  const [expandedStudent, setExpandedStudent] = useState<string | null>(null);
  const [selectedSubjectId, setSelectedSubjectId] = useState('');
  const [expandedSubjectId,setExpandedSubjectId] = useState<string|null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [form, setForm] = useState<FormState>(initialForm);
  const [modal, setModal] = useState('');
  const [consultationMonth, setConsultationMonth] = useState(() => dateOnly().slice(0,7));
  const [consultationDates, setConsultationDates] = useState<string[]>([]);
  const [currentSession, setCurrentSession] = useState<Meeting | null>(null);
  const [qrToken, setQrToken] = useState('');
  const [roster, setRoster] = useState<{ studentId: string; name: string; studentNumber: string; photo: string | null; attendance: Attendance | null }[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [outbox, setOutbox] = useState<Outbox[]>([]);
  const [camera, setCamera] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [profilePhotoUrl, setProfilePhotoUrl] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<'idle' | 'opening' | 'scanning' | 'submitting' | 'error' | 'success'>('idle');
  const [scanError, setScanError] = useState('');
  const failedScanRef = useRef<{ token: string; at: number }>({ token: '', at: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanLockRef = useRef(false);
  const [tick, setTick] = useState(0);

  const update = (key: string, value: string) => setForm((old) => ({ ...old, [key]: value }));
  const showSlotCalendar = () => {
    setConsultationDates([]);
    setConsultationMonth(dateOnly().slice(0,7));
    setForm(previous=>({...previous,consultationSubjectId:sections.find(s=>!s.archivedAt)?.id||''}));
    setModal('slot');
  };
  const toggleConsultationDate = (date: string) => {
    if (date < dateOnly()) return;
    setConsultationDates(old => old.includes(date)
      ? old.filter(d => d !== date)
      : old.length >= 14 ? old : [...old,date].sort());
  };
  const role = profile?.role || 'Student';
  const isFaculty = role === 'Faculty';
  const isStudent = role === 'Student';
  const isAdmin = role === 'System Administrator';
  const queueKey = authUser?.userId || '';
  const syncLockRef=useRef(false);
  const [queueBusy,setQueueBusy]=useState(false);
  const [queueProblem,setQueueProblem]=useState('');
  const showMessage = (s: string) => { setMessage(s); window.setTimeout(() => setMessage(''), 4800); };
  const navigate = (p: NavPage) => { setPage(p); setDrawer(false); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const openScanner = () => {
    if (!isStudent) return;
    failedScanRef.current = { token: '', at: 0 };
    scanLockRef.current = false;
    setScanError('');
    setScanStatus('opening');
    setModal('scan');
    setCamera(true);
  };
  const closeScanner = () => {
    setModal('');
    setCamera(false);
    setScanStatus('idle');
    setScanError('');
    scanLockRef.current = false;
  };
  async function loadProfilePhoto() {
    try {
      const response = await api.get('/api/profile/photo');
      setProfilePhotoUrl((response.data as { url: string | null }).url || null);
    } catch {
      setProfilePhotoUrl(null);
    }
  }

  async function safeRun(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      showMessage(apiMessage(e));
    } finally {
      setBusy('');
    }
  }

  async function bootstrap() {
    const { data: result } = await api.get('/api/bootstrap');
    const p = (result as { profile: Profile }).profile;
    const draft = readSignupDraft();
    const matches = !!draft && !!p.email && draft.email.toLowerCase() === p.email.toLowerCase();
    setProfile(p);
    setForm((old) => ({
      ...old,
      name: p.onboardingComplete ? p.name || '' : matches ? draft.name : p.name === 'ClassPulse User' ? '' : p.name || '',
      studentNumber: p.onboardingComplete ? p.studentNumber || '' : matches ? draft.studentNumber : p.studentNumber || '',
      department: p.department || '',
      bio: p.bio || '',
      contactPhone: p.contactPhone || '',
      yearLevel: p.yearLevel || '',
      officeRoom: p.officeRoom || '',
      requestedRole: p.role === 'System Administrator' ? 'System Administrator' : p.onboardingComplete
        ? p.roleRequest || p.role || 'Student' : matches ? draft.requestedRole : p.roleRequest || 'Student',
    }));
    setAdminConfigured(Boolean((result as { adminConfigured: boolean }).adminConfigured));
    return p;
  }
  async function refreshLive() {
    const result = await api.get('/api/live');
    setLive(result.data as LiveSnapshot);
  }
  async function refreshMyPresence() {
    if (role !== 'Faculty') return;
    const response=await api.get('/api/availability/me');
    const saved=response.data as {status:PresenceStatus;updatedAt:string|null};
    confirmedPresenceRef.current=saved;
    if(!presenceRunningRef.current)setMyPresence(saved);
  }
  async function setFacultyPresence(status:PresenceStatus) {
    if(status===myPresence.status && !presenceRunningRef.current)return;
    presenceQueueRef.current=status;
    setMyPresence({status,updatedAt:new Date().toISOString()});
    if(presenceRunningRef.current)return;
    presenceRunningRef.current=true;
    try {
      while(presenceQueueRef.current) {
        const target=presenceQueueRef.current;
        presenceQueueRef.current=null;
        try {
          const response=await api.post('/api/availability',{status:target});
          const saved=response.data as {ok:boolean;status:PresenceStatus;updatedAt?:string};
          if(!saved.ok)throw new Error('Status was not saved');
          confirmedPresenceRef.current={status:saved.status,updatedAt:saved.updatedAt||new Date().toISOString()};
        }catch(e) {
          if(!presenceQueueRef.current)setMyPresence(confirmedPresenceRef.current);
          showMessage('Status not saved. '+apiMessage(e));
        }
      }
    }finally{
      presenceRunningRef.current=false;
      if(!presenceQueueRef.current)setMyPresence(confirmedPresenceRef.current);
      void refreshLive().catch(()=>{});
    }
  }
  async function loadFacultyRoster(sectionId:string,openRecordsPage=true) {
    setSelectedSubjectId(sectionId);
    setFacultyRosterLoading(true);
    setFacultyRoster(null);
    setRosterSearch('');
    setExpandedStudent(null);
    if(openRecordsPage){setModal('');navigate('Student Records');}
    try {
      const response=await api.get('/api/faculty/sections/'+sectionId+'/roster');
      setFacultyRoster(response.data as FacultyRoster);
    } catch(e) {
      showMessage('Unable to load your class records. '+apiMessage(e));
    } finally {
      setFacultyRosterLoading(false);
    }
  }
  function editMySubject(s:Section) {
    setSelectedSubjectId(s.id);
    setForm(old=>({...old,sectionId:s.id,courseCode:s.courseCode,title:s.title,
      section:s.section,term:s.term,day:s.day,startTime:s.startTime,endTime:s.endTime,room:s.room}));
    setModal('faculty-edit');
  }
  function newMySubject() {
    setForm(old=>({...old,courseCode:'',title:'',section:'',term:'Current term',
      day:'MW',startTime:'08:00',endTime:'09:30',room:''}));
    setModal('faculty-create');
  }

  async function refreshDashboard() {
    const { data: result } = await api.get('/api/dashboard');
    const d = result as Dashboard;
    setData(d);
    setSections(d.sections || []);
    setAttendance(d.attendance || []);
    setExcuses(d.excuses || []);
    setNotices(d.notices || []);
  }
  async function refreshAdministration() {
    const [a,b,c,d,e] = await Promise.all([
      api.get('/api/admin/users'), api.get('/api/admin/summary'),
      api.get('/api/admin/audit'), api.get('/api/admin/operations'),
      api.get('/api/sections'),
    ]);
    setUsers((a.data as { users: UserDirectory[] }).users || []);
    setSummary(b.data as AdminInfo);
    setAdminEvents((c.data as { events: typeof adminEvents }).events || []);
    setOperations(d.data as AdminOperations);
    setSections((e.data as { sections: Section[] }).sections || []);
    const [roomResponse,inviteResponse]=await Promise.all([
      api.get('/api/admin/rooms'),api.get('/api/admin/invites'),
    ]);
    setAdminRooms((roomResponse.data as {rooms:typeof adminRooms}).rooms||[]);
    setAdminInvites((inviteResponse.data as {invites:typeof adminInvites}).invites||[]);
  }
  async function refreshPage(p: NavPage) {
    if (p === 'Overview') {
      if (role === 'System Administrator') {
        await Promise.all([refreshDashboard(), refreshAdministration()]);
      } else {
        await Promise.all([refreshDashboard(), refreshLive(), ...(role === 'Faculty' ? [refreshMyPresence()] : [])]);
      }
    } else if (p === 'Classes') {
      const { data: result } = await api.get('/api/sections');
      setSections((result as { sections: Section[] }).sections || []);
    } else if (p === 'Student Records') {
      const response=await api.get('/api/sections');
      setSections((response.data as {sections:Section[]}).sections||[]);
    } else if (p === 'Attendance') {
      const { data: d } = await api.get('/api/dashboard');
      setData(d as Dashboard);
      setSections((d as Dashboard).sections);
      if (role !== 'System Administrator') {
        const { data: a } = await api.get('/api/attendance');
        setAttendance((a as { records: Attendance[] }).records || []);
      }
    } else if (p === 'Excuses') {
      const { data: d } = await api.get('/api/excuses');
      setExcuses((d as { excuses: Excuse[] }).excuses || []);
    } else if (p === 'Consultations') {
      const [a,b,c] = await Promise.all([
        api.get('/api/slots'),api.get('/api/bookings'),api.get('/api/sections'),
      ]);
      setSlots((a.data as {slots:Slot[]}).slots||[]);
      setBookings((b.data as {bookings:Booking[]}).bookings||[]);
      setSections((c.data as {sections:Section[]}).sections||[]);
    } else if (p === 'Profile') {
      await loadProfilePhoto();
    } else if (p === 'Notifications') {
      const { data: d } = await api.get('/api/notices');
      setNotices((d as { notices: Notice[] }).notices || []);
    } else if (p === 'Administration') {
      await refreshAdministration();
    }
  }
  useEffect(() => {
    let mounted = true;
    auth.getUser().then(async (u) => {
      if (!mounted) return;
      setAuthUser(u);
      if (u) {
        try {
          const p=await bootstrap();
          const draft=readSignupDraft();
          if(draft&&!p.onboardingComplete&&
            (!u.email||u.email.toLowerCase()!==draft.email.toLowerCase())){
            setAuthError('This Google/Apple account uses a different email than the registration form. Sign out and verify the intended email.');
          }
          if(draft&&p.onboardingComplete)sessionStorage.removeItem(signupKey);
          if(p.onboardingComplete&&!p.deletedAt)await refreshDashboard();
        } catch (e) { if (mounted) setAuthError(apiMessage(e)); }
      }
      if (mounted) setInitialized(true);
    }).catch((e) => { if (mounted) { setAuthError(apiMessage(e)); setInitialized(true); } });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cp-live-theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem('cp-view-density', density);
  }, [density]);
  useEffect(() => {
    const syncStatus = () => setOnline(navigator.onLine);
    window.addEventListener('online', syncStatus);
    window.addEventListener('offline', syncStatus);
    return () => { window.removeEventListener('online', syncStatus); window.removeEventListener('offline', syncStatus); };
  }, []);
  useEffect(() => {
    if (!queueKey) {setOutbox([]);return;}
    let active=true;
    (async()=>{
      try{
        await migrateOldScans(queueKey);
        const saved=await listQueuedScans(queueKey);
        if(active){setOutbox(saved);setQueueProblem('');}
      }catch(e){
        if(active)setQueueProblem('Secure offline storage unavailable. '+apiMessage(e));
      }
    })();
    return ()=>{active=false;};
  },[queueKey]);
  useEffect(() => {
    if (!profile || !authUser) return;
    refreshPage(page).catch((e) => showMessage(apiMessage(e)));
  }, [page, profile?.role]);
  const liveFacultyIdsKey=Array.from(new Set(profile?.role==='Faculty'
    ? (authUser?.userId?[authUser.userId]:[])
    : sections.filter(s=>!s.archivedAt).map(s=>s.facultyId).filter(Boolean))).sort().join('|');
  liveFacultyIdsRef.current=liveFacultyIdsKey?liveFacultyIdsKey.split('|'):[];

  useEffect(()=>{
    if(!authUser?.userId||!profile?.onboardingComplete||profile.role==='System Administrator')return;
    let alive=true;
    const socket=ws.connect();
    liveSocketRef.current=socket;
    const registered=new Set<string>();
    let working=false;
    let retry=false;
    const syncSubscriptions=async()=>{
      if(working){retry=true;return;}
      working=true;
      try {
        await socket.ready;
        if(!alive||!socket.connectionId)return;
        do {
          retry=false;
          const desired=new Set(liveFacultyIdsRef.current);
          for(const facultyId of Array.from(registered)){
            if(!desired.has(facultyId)){
              try {
                await api.post('/api/live/unsubscribe',{
                  entity_type:'faculty_presence',entity_id:facultyId,
                  connection_id:socket.connectionId,
                });
                registered.delete(facultyId);
              }catch { /* Retry next reconciliation if necessary. */ }
            }
          }
          for(const facultyId of desired){
            if(registered.has(facultyId))continue;
            try {
              await api.post('/api/live/subscribe',{
                entity_type:'faculty_presence',entity_id:facultyId,
                connection_id:socket.connectionId,
              });
              if(alive)registered.add(facultyId);
            }catch { /* A normal refocus also refreshes the dashboard. */ }
          }
        }while(alive&&retry);
      }catch { /* The app still supports a fresh load on refocus. */ }
      finally{working=false;}
    };
    liveSubscriptionRefreshRef.current=()=>{void syncSubscriptions();};
    socket.onMessage(message=>{
      if(!alive||message?.type!=='entity.update'
        ||message?.entity_type!=='faculty_presence')return;
      const facultyId=String(message.entity_id||'');
      if(!liveFacultyIdsRef.current.includes(facultyId))return;
      const update=message.data as {kind?:string;status?:PresenceStatus;updatedAt?:string};
      if(update?.kind==='presence'&&update.status){
        setLive(old=>({...old,updatedAt:new Date().toISOString(),
          faculty:old.faculty.map(f=>f.facultyId===facultyId&&f.source!=='QR session'
            ? {...f,status:update.status!,updatedAt:update.updatedAt||new Date().toISOString(),
              source:'Faculty update'}:f)}));
        if(profile.role==='Faculty'&&facultyId===authUser.userId
          &&!presenceRunningRef.current){
          const updated={status:update.status,updatedAt:update.updatedAt||null};
          confirmedPresenceRef.current=updated;
          setMyPresence(updated);
        }
      }else{
        void refreshLive().catch(()=>{});
        if(page==='Overview')void refreshDashboard().catch(()=>{});
      }
    });
    socket.onOpen(()=>{registered.clear();void syncSubscriptions();});
    void socket.ready.then(()=>syncSubscriptions()).catch(()=>{});
    return ()=>{
      alive=false;
      liveSubscriptionRefreshRef.current=null;
      const connection_id=socket.connectionId;
      if(connection_id)for(const facultyId of registered){
        void api.post('/api/live/unsubscribe',{
          entity_type:'faculty_presence',entity_id:facultyId,connection_id,
        }).catch(()=>{});
      }
      socket.disconnect();
      if(liveSocketRef.current===socket)liveSocketRef.current=null;
    };
  },[authUser?.userId,profile?.role,profile?.onboardingComplete]);

  useEffect(()=>{
    liveSubscriptionRefreshRef.current?.();
  },[liveFacultyIdsKey]);

  useEffect(()=>{
    if(!authUser?.userId||!profile?.onboardingComplete
      ||profile.role==='System Administrator')return;
    const refreshVisible=()=>{
      if(document.visibilityState==='visible'&&navigator.onLine){
        void refreshLive().catch(()=>{});
      }
    };
    window.addEventListener('focus',refreshVisible);
    document.addEventListener('visibilitychange',refreshVisible);
    return ()=>{
      window.removeEventListener('focus',refreshVisible);
      document.removeEventListener('visibilitychange',refreshVisible);
    };
  },[authUser?.userId,profile?.role,profile?.onboardingComplete]);
  useEffect(()=>{
    if(!queueKey||!isStudent||!profile?.onboardingComplete)return;
    const flush=()=>{if(navigator.onLine&&document.visibilityState==='visible')void syncOutbox(true);};
    const interval=window.setInterval(flush,15000);
    window.addEventListener('online',flush);
    window.addEventListener('focus',flush);
    return ()=>{window.clearInterval(interval);window.removeEventListener('online',flush);window.removeEventListener('focus',flush);};
  },[queueKey,profile?.role,profile?.onboardingComplete]);
  useEffect(() => {
    const interval = window.setInterval(() => setTick((s) => s + 1), 1000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    if (!currentSession || modal !== 'qr' || !isFaculty) return;
    const refresh = async () => {
      try {
        const response = await api.get('/api/sessions/' + currentSession.id + '/qr');
        setQrToken((response.data as { token: string }).token);
      } catch { setQrToken(''); }
    };
    refresh();
    // Align display refresh with the server's absolute 15-second HMAC token slots.
    // An unsynchronized 15-second interval can leave a stale QR on screen.
    let interval: number | undefined;
    const offset = 15000 - (Date.now() % 15000) + 100;
    const timeout = window.setTimeout(() => {
      refresh();
      interval = window.setInterval(refresh, 15000);
    }, offset);
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [currentSession?.id, modal, isFaculty]);
  useEffect(() => {
    if (!camera) return;
    let alive = true;
    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!alive) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        if (alive) setScanStatus('scanning');
      } catch (e) {
        const detail = apiMessage(e);
        const explanation = detail.includes('NotAllowed') || detail.includes('Permission')
          ? 'Camera permission is blocked. Allow ClassPulse to access your camera in browser settings, then retry.'
          : detail.includes('NotFound')
            ? 'No available camera was found on this device.'
            : 'Unable to start camera. Confirm camera access is allowed and try again.';
        setScanError(explanation);
        setScanStatus('error');
        setCamera(false);
      }
    };
    start();
    const interval = window.setInterval(async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth || scanLockRef.current) return;
      try {
        let token = '';
        const Detector = (window as unknown as { BarcodeDetector?: new (config: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
        if (Detector) {
          const result = await new Detector({ formats: ['qr_code'] }).detect(video);
          token = result[0]?.rawValue || '';
        }
        if (!token) {
          // Safari/iPhone/iPad fallback: decode video frames in JavaScript.
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (context) {
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const frame = context.getImageData(0, 0, canvas.width, canvas.height);
            token = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' })?.data || '';
          }
        }
        if (token && alive && !scanLockRef.current) {
          if (failedScanRef.current.token === token && Date.now() - failedScanRef.current.at < 4500) return;
          void submitCapturedQr(token);
        }
      } catch {
        // Camera frame can fail during orientation changes; keep the manual field.
      }
    }, 650);
    return () => { alive = false; window.clearInterval(interval); streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null; };
  }, [camera]);
  async function submitCapturedQr(token: string) {
    if (scanLockRef.current || !authUser) return;
    scanLockRef.current = true;
    setScanStatus('submitting');
    const capturedAt = new Date().toISOString();
    try {
      if (!navigator.onLine) {
        const id = crypto.randomUUID();
        await storeQueuedScan({id,ownerId:authUser.userId,token,capturedAt,
          attempts:0,retryAt:0,state:'PENDING',lastError:''});
        setOutbox(await listQueuedScans(authUser.userId));
        setQueueProblem('');
        showMessage('QR stored securely. It will sync for faculty review when online.');
      } else {
        const response = await api.post('/api/attendance/scan', {
          token, capturedAt, clientScanId: crypto.randomUUID(),
        });
        showMessage((response.data as { review: boolean }).review
          ? 'QR recorded and awaiting faculty timestamp review.'
          : 'Attendance automatically verified and recorded.');
        await refreshPage('Attendance');
      }
      setScanStatus('success');
      setCamera(false);
      setModal('');
    } catch (error) {
      failedScanRef.current = { token, at: Date.now() };
      if(!navigator.onLine)setQueueProblem('Offline capture failed; scan was not saved.');
      setScanError('Unable to save or verify this QR. '+apiMessage(error));
      setScanStatus('scanning');
      // Remain on camera; the next rotating faculty QR can be recognized automatically.
    } finally {
      scanLockRef.current = false;
    }
  }
  async function syncOutbox(silent=false) {
    if(!queueKey||!isStudent||syncLockRef.current||!navigator.onLine){
      if(!silent&&!navigator.onLine)showMessage('Reconnect before synchronizing scans.');
      return;
    }
    syncLockRef.current=true;setQueueBusy(true);
    let success=0,attention=0;
    try{
      const saved=await listQueuedScans(queueKey);
      for(const item of saved){
        if(item.state==='NEEDS_ATTENTION'||item.retryAt>Date.now())continue;
        const age=Date.now()-Date.parse(item.capturedAt);
        if(age>12*60*60*1000){
          await storeQueuedScan({...item,state:'NEEDS_ATTENTION',lastError:'12-hour submission window exceeded'});
          attention++;continue;
        }
        try{
          await api.post('/api/attendance/scan',{token:item.token,capturedAt:item.capturedAt,clientScanId:item.id});
          await removeQueuedScan(item.id);success++;
        }catch(e){
          const detail=apiMessage(e);
          const attempts=item.attempts+1;
          const permanent=/422|invalid signature|timestamp|not enrolled|12.hour|rejected/i.test(detail);
          const needsAttention=permanent||attempts>=6;
          await storeQueuedScan({...item,attempts,lastError:detail.slice(0,200),
            retryAt:needsAttention?0:nextRetry(attempts),state:needsAttention?'NEEDS_ATTENTION':'PENDING'});
          if(needsAttention)attention++;
        }
      }
      setOutbox(await listQueuedScans(queueKey));setQueueProblem('');
      if(!silent||success||attention)showMessage(success+' QR scan(s) synchronized'+(attention?' · '+attention+' need review':'')+'.');
      if(success)await refreshPage('Attendance');
    }catch(e){setQueueProblem(apiMessage(e));if(!silent)showMessage(apiMessage(e));}
    finally{syncLockRef.current=false;setQueueBusy(false);}
  }
  async function retryQueuedScans(){
    if(!queueKey)return;
    for(const item of await listQueuedScans(queueKey)){
      if(item.state==='NEEDS_ATTENTION' && Date.now()-Date.parse(item.capturedAt)<12*60*60*1000)
        await storeQueuedScan({...item,state:'PENDING',attempts:0,retryAt:0});
    }
    setOutbox(await listQueuedScans(queueKey));
    await syncOutbox();
  }
  function openEntry(mode: EntryMode) {
    setAuthError('');
    setAuthRedirecting(false);
    setEntryMode(mode);
  }
  async function beginAuthentication() {
    if (authRedirecting) return;
    setAuthError('');
    if (entryMode === 'signup') {
      const d = {
        name:signupDraft.name.trim(), email:signupDraft.email.trim().toLowerCase(),
        studentNumber:signupDraft.studentNumber.trim(), requestedRole:signupDraft.requestedRole
      };
      if (d.name.length < 2) return setAuthError('Please enter your full name.');
      if (!/^[^@ ]+@[^@ .]+\.[^@ ]+$/.test(d.email)) return setAuthError('Enter a valid email address.');
      try {
        sessionStorage.setItem(signupKey, JSON.stringify(d));
        setSignupDraft(d);
      } catch { return setAuthError('Browser storage is unavailable. Open ClassPulse directly in Safari, Chrome or Edge.'); }
    } else {
      try { sessionStorage.removeItem(signupKey); } catch { /* Login should still be available. */ }
    }
    setAuthRedirecting(true);
    try {
      await auth.signInWithRedirect();
    } catch (e) {
      setAuthRedirecting(false);
      const message = apiMessage(e);
      setAuthError(message.includes('storage-unavailable')
        ? 'Enable browser cookies and storage, or open ClassPulse in Safari, Chrome, or Edge.'
        : message.includes('navigation-timeout')
          ? 'The secure sign-in page could not open. Use Safari, Chrome, or Edge to open the app directly.'
          : message);
    }
  }
  async function completeRegistration() {
    if(profile?.role!=='System Administrator'&&!roleChoiceConfirmed){
      setAuthError('Select Student or Faculty to continue.');return;
    }
    if (form.name.trim().length < 2) { setAuthError('Enter your full name first.'); return; }
    const draft = readSignupDraft();
    if (draft && (!authUser?.email || draft.email.toLowerCase() !== authUser.email.toLowerCase())) {
      setAuthError('Please verify the email used during registration.'); return;
    }
    await api.post('/api/onboarding', {
      name: form.name.trim(), studentNumber: form.studentNumber.trim(),
      requestedRole: form.requestedRole || 'Student',
    });
    try { sessionStorage.removeItem(signupKey); } catch { /* Best effort cleanup. */ }
    setAuthError('');
    await bootstrap();
    await refreshDashboard();
    showMessage('Your ClassPulse profile is ready.');
  }
  async function signOut() {
    sessionStorage.removeItem('cp-entry-mode');
    setOutbox([]);setQueueProblem('');
    await auth.signOut();
    setAuthUser(null);
    setRoleChoiceConfirmed(false);
    setProfile(null);
    setData(null);
    setPage('Overview');
  }
  async function action(path: string, body: Record<string, unknown>, reload: NavPage = page) {
    await api.post(path, body);
    await refreshPage(reload);
  }
  async function openMeeting(sectionId: string) {
    const { data: r } = await api.post('/api/sessions/open', { sectionId });
    setCurrentSession((r as { meeting: Meeting }).meeting);
    setModal('qr');
    await refreshDashboard();
  }
  async function qrModal(meeting: Meeting) { setCurrentSession(meeting); setModal('qr'); }
  async function rosterModal(meeting: Meeting) {
    setCurrentSession(meeting);
    const { data: r } = await api.get('/api/sessions/' + meeting.id + '/roster');
    setRoster((r as { students: typeof roster }).students);
    setModal('roster');
  }
  async function submitExcuse() {
    const { data: result } = await api.post('/api/excuses', {
      sectionId: form.sectionId, absenceDate: form.absenceDate, reason: form.reason,
    });
    const excuse = (result as { excuse: Excuse }).excuse;
    if (file) await api.post('/api/excuses/' + excuse.id + '/file', {
      contentType: file.type, content: await fileBase64(file),
    });
    setFile(null);
    setModal('');
    setForm((old) => ({ ...old, reason: '' }));
    await refreshPage('Excuses');
    showMessage('Your absence request was submitted to your assigned faculty.');
  }
  async function uploadPhoto() {
    if (!photoFile) return;
    if (!['image/jpeg','image/png','image/webp'].includes(photoFile.type)) {
      showMessage('Use a JPG, PNG or WebP image for your profile.'); return;
    }
    if (photoFile.size > 2_000_000) {
      showMessage('Choose a profile photo smaller than 2 MB.'); return;
    }
    await api.post('/api/profile/photo', {
      contentType: photoFile.type, content: await fileBase64(photoFile),
    });
    setPhotoFile(null);
    await bootstrap();
    await loadProfilePhoto();
    showMessage('Your new profile photo was saved. Faculty verification is separate.');
  }

  if (!initialized) return <div className='cp-loading'><Brand/><div className='cp-spinner'/><span>Preparing your campus workspace…</span></div>;

  if (!authUser && entryMode) return <div className='cp-auth-page'>
    <aside className='cp-auth-side'>
      <Brand light/>
      <div><span className='cp-eyebrow light'>WELCOME TO CLASSPULSE</span><LogoMark large/>
        <h1>Every class.<br/><em>In sync.</em></h1>
        <p>One academic home for schedules, attendance, consultations, and faculty availability.</p>
        <span className='cp-auth-side-trust'><ShieldCheck size={18}/> Verified identity · Controlled role access</span>
      </div>
      <small>MSU MAIN CAMPUS · CLASS PULSE</small>
    </aside>
    <main className='cp-auth-main'>
      <div className='cp-auth-form'>
        <button className='cp-auth-back' onClick={() => {setEntryMode(null);setAuthError('');}}>‹ Back to website</button>
        <div className='cp-auth-tabs' role='tablist' aria-label='Account access'>
          <button role='tab' aria-selected={entryMode === 'signin'} className={entryMode === 'signin' ? 'selected' : ''} onClick={() => openEntry('signin')}>Sign in</button>
          <button role='tab' aria-selected={entryMode === 'signup'} className={entryMode === 'signup' ? 'selected' : ''} onClick={() => openEntry('signup')}>Create account</button>
        </div>
        <span className='cp-auth-kicker'>{entryMode === 'signup' ? 'NEW CAMPUS PROFILE' : 'WELCOME BACK'}</span>
        <h2>{entryMode === 'signup' ? 'Create your account.' : 'Sign in to ClassPulse.'}</h2>
        <p className='cp-auth-subtitle'>{entryMode === 'signup'
          ? 'Enter your details. Verify with Google, Apple or email, then confirm your role.'
          : 'Continue with Google, Apple or a secure email link.'}</p>
        {entryMode === 'signup' && <div className='cp-auth-fields'>
          <label className='cp-field'><span>Full name *</span><input autoComplete='name' placeholder='Your full name' value={signupDraft.name}
            onChange={e => setSignupDraft(v=>({...v,name:e.target.value}))}/></label>
          <label className='cp-field'><span>Email address *</span><input type='email' inputMode='email' autoComplete='email' placeholder='name@example.com' value={signupDraft.email}
            onChange={e => setSignupDraft(v=>({...v,email:e.target.value}))}/></label>
          <label className='cp-field'><span>Student / Employee ID (optional)</span><input placeholder='Campus ID' value={signupDraft.studentNumber}
            onChange={e => setSignupDraft(v=>({...v,studentNumber:e.target.value}))}/></label>
          <label className='cp-field'><span>Campus role</span><select value={signupDraft.requestedRole}
            onChange={ev => setSignupDraft(v=>({...v,requestedRole:ev.target.value as Role}))}>
            <option value='Student'>Student</option><option value='Faculty'>Faculty</option>
          </select></label>
          <p className='cp-auth-role-note'><ShieldCheck size={16}/>
            You will confirm your role after Google, Apple or email verification.</p>
        </div>}
        {authError && <div role='alert' className='cp-auth-error'>{authError}</div>}
        <button disabled={authRedirecting} className='cp-button dark full cp-auth-submit' onClick={beginAuthentication}>
          {authRedirecting ? 'Opening secure verification…' : entryMode === 'signup' ? 'Verify email & create account' : 'Continue to secure sign in'}
          {authRedirecting ? <span className='cp-spinner small'/> : <ArrowRight size={17}/>}
        </button>
        <p className='cp-auth-hint'><LockKeyhole size={17}/> Secure sign-in · No password to remember.</p>
        <div className='cp-auth-switch'>
          {entryMode === 'signup' ? 'Already registered?' : 'New to ClassPulse?'}
          <button onClick={() => openEntry(entryMode === 'signup' ? 'signin' : 'signup')}>{entryMode === 'signup' ? 'Sign in' : 'Create account'}</button>
        </div>
      </div>
    </main>
  </div>;
  if (!authUser) return <div className='cp-public'>
    <header className='cp-public-nav'><Brand/><nav><a href='#features'>Features</a><a href='#workflow'>How it works</a><a href='#security'>Security</a></nav><div className='cp-public-auth-actions'><button className='cp-public-signin' onClick={() => openEntry('signin')}><LogIn size={16}/> Sign in</button><button className='cp-button dark' onClick={() => openEntry('signup')}>Create account <ArrowUpRight size={17}/></button></div></header>
    <section className='cp-landing-hero'><div className='cp-hero-glow'/>
      <div className='cp-hero-content'>
        <div className='cp-eyebrow light'><span className='cp-live-dot'/> BUILT FOR A MORE CONNECTED CAMPUS</div>
        <h1>Every class.<br/>Every moment.<br/><em>In sync.</em></h1>
        <p>A smarter academic rhythm for Mindanao State University – Main Campus. Classes, QR attendance, digital excuses, and consultations—united in one remarkable workspace.</p>
        <div className='cp-hero-cta'><button className='cp-button lime' onClick={() => openEntry('signup')}>Create your account <ArrowUpRight size={19}/></button><a href='#features'>Explore the platform <ChevronRight size={17}/></a></div>
        <div className='cp-hero-credentials'><span><ShieldCheck size={16}/> Private by design</span><span><Wifi size={16}/> Connected academic life</span><span><Users size={16}/> Three role-based workspaces</span></div>
      </div>
      <div className='cp-hero-art'><div className='cp-hero-orbit orbit-one'/><div className='cp-hero-orbit orbit-two'/><div className='cp-orbit-core'><LogoMark large/><span>CLASS<span>PULSE</span></span></div><div className='cp-floating-card float-a'><QrCode size={22}/><div><b>Dynamic QR</b><small>Faculty-controlled</small></div></div><div className='cp-floating-card float-b'><CalendarDays size={22}/><div><b>Your next class</b><small>Right on schedule</small></div></div><div className='cp-floating-card float-c'><CheckCircle2 size={22}/><div><b>Attendance</b><small>Verified at scan time</small></div></div></div>
    </section>
    <section id='features' className='cp-features'><SectionTitle eyebrow='ONE CAMPUS. ONE PLATFORM.' title='Designed for the way campus really works.' subtitle='A streamlined experience for students, faculty, and authorized administrators.'/>
      <div className='cp-feature-grid'>
        {[
          { n:'01', title:'Your day, organized.', detail:'Schedules, enrolled classes, rooms, and important changes in one place.', icon:CalendarDays },
          { n:'02', title:'Attendance, reimagined.', detail:'Faculty-generated rotating QR, verified records, and a review process for suspicious scans.', icon:QrCode },
          { n:'03', title:'Less paperwork.', detail:'Submit an absence request for an upcoming or missed class and track its review.', icon:FileCheck2 },
          { n:'04', title:'Consultations that click.', detail:'Publish available slots, request appointments, and receive a confirmation.', icon:CalendarClock },
        ].map((f) => <article className='cp-feature' key={f.n}><span>{f.n} / CLASS PULSE</span><f.icon size={36}/><h3>{f.title}</h3><p>{f.detail}</p><ArrowUpRight size={19}/></article>)}
      </div>
    </section>
    <section id='workflow' className='cp-roles-banner'><div><div className='cp-eyebrow light'>ONE PLATFORM. DIFFERENT PERSPECTIVES.</div><h2>Built around<br/><em>your role.</em></h2></div><div className='cp-role-list'><div><GraduationCap/><strong>Student</strong><span>Know your schedule and attendance.</span></div><div><Users/><strong>Faculty</strong><span>Manage meetings, QR scans, and decisions.</span></div><div><ShieldCheck/><strong>Administrator</strong><span>Keep operations running with aggregate-only reporting.</span></div></div></section>
    <section id='security' className='cp-public-ending'><div className='cp-eyebrow'>READY FOR YOUR CAMPUS DAY?</div><h2>Less searching.<br/>More learning.</h2><p>Sign in with your account or create one using a supported provider. Faculty and administrator permissions require approval.</p><div className='cp-public-auth-actions centered'><button className='cp-button dark' onClick={() => openEntry('signup')}>Create account <ArrowUpRight size={18}/></button><button className='cp-public-signin' onClick={() => openEntry('signin')}>Already registered? Sign in</button></div>{authError && <p className='cp-error'>{authError}</p>}</section>
    <footer className='cp-public-footer'><Brand/><span>Academic system for Mindanao State University – Main Campus • Capstone pilot</span></footer>
  </div>;


  if (authUser && !profile) return <div className='cp-loading cp-recovery'>
      <Brand/><h2>Account could not be loaded</h2><p role='alert'>{authError || 'Your profile is unavailable.'}</p>
      <button className='cp-button dark' onClick={() => window.location.reload()}>Retry</button>
      <button className='cp-mini-btn' onClick={() => safeRun('sign-out',signOut)}>Sign out</button>
    </div>;
  if(authUser&&profile?.deletedAt)return <div className='cp-loading cp-account-deleted'>
    <ShieldCheck size={34}/>
    <h2>ClassPulse account deleted</h2>
    <p>This profile is no longer active. Your Google or Apple account is separate.</p>
    <button className='cp-button dark' onClick={()=>safeRun('sign-out',signOut)}>Sign out</button>
  </div>;
  if (authUser && profile && !profile.onboardingComplete) return <div className='cp-registration'>
    <div className='cp-reg-intro'><Brand light/>
      <span className='cp-eyebrow light'>YOUR CAMPUS PROFILE</span>
      <h1>{sessionStorage.getItem('cp-entry-mode') === 'signup' ? 'Create your ClassPulse profile.' : 'Finish setting up your workspace.'}</h1>
      <p>Verify your identity, complete your details, and open the Student or Faculty workspace immediately.</p>
      <div className='cp-reg-steps'><span className='done'><Check size={15}/> Identity verified</span><span className='active'>2. Campus details</span><span>3. Access your workspace</span></div>
      <div className='cp-reg-note'><ShieldCheck size={20}/> Faculty workspaces activate after registration. Classroom ownership remains assigned by the institution. Administrator access is restricted to authorized emails.</div>
    </div>
    <section className='cp-reg-form'>
      <div className='cp-reg-heading'><span>STEP 02 / YOUR DETAILS</span><h2>Tell us about yourself</h2><p>These details are stored in your protected ClassPulse profile.</p></div>
      <div className='cp-reg-identity'><LockKeyhole size={19}/><span>Authenticated email</span><strong>{authUser.email || 'Verified account'}</strong></div>
      <Field label='Full name' name='name' form={form} update={update} placeholder='Enter your first and last name' required/>
      <Field label='Campus / student / employee ID (optional)' name='studentNumber' form={form} update={update} placeholder='Your campus identifier'/>
      <div className='cp-reg-role-label'>{profile?.role==='System Administrator'
        ? 'AUTHORIZED ADMINISTRATOR' : 'CHOOSE YOUR ROLE'}</div>
      {profile?.role==='System Administrator'
        ? <div className='cp-reg-admin-approved'><ShieldCheck size={20}/> Administrator access verified</div>
        : <div className='cp-reg-roles'>
        {[
          { name: 'Student', icon: GraduationCap, desc: 'Classes and attendance' },
          { name: 'Faculty', icon: Users, desc: 'Classroom and records' },
        ].map(({name,icon:Icon,desc}) => <button type='button' key={name}
          aria-pressed={roleChoiceConfirmed&&form.requestedRole===name}
          className={roleChoiceConfirmed&&form.requestedRole===name?'selected':''}
          onClick={()=>{
            setForm(previous=>({...previous,requestedRole:name}));
            setRoleChoiceConfirmed(true);setAuthError('');
          }}>
          <span><Icon size={20}/></span><strong>{name}</strong><small>{desc}</small>
          <i>{roleChoiceConfirmed&&form.requestedRole===name&&<Check size={13}/>}</i>
        </button>)}
      </div>}
      {roleChoiceConfirmed&&form.requestedRole==='Faculty'&&
        <p className='cp-role-explainer'><ShieldCheck size={16}/>
          Faculty QR and records require assigned classes.</p>}
      {(authError || message) && <p className='cp-auth-error' role='alert'>{authError || message}</p>}
      <button disabled={!!busy || form.name.trim().length < 2 ||
        (profile?.role!=='System Administrator'&&!roleChoiceConfirmed)}
        className='cp-button dark full cp-reg-submit' onClick={() => safeRun('registration', completeRegistration)}>Complete registration <ArrowRight size={18}/></button>
      <button className='cp-reg-switch' onClick={() => safeRun('sign-out', signOut)}>Use a different account</button>
    </section>
  </div>;

  const activeSections = sections || [];
  const selectedExcuseSubject=sections.find(section=>section.id===form.sectionId&&!section.archivedAt);
  const openNewExcuse=()=>{
    const first=sections.find(section=>!section.archivedAt);
    setExcuseMonth(dateOnly().slice(0,7));
    setFile(null);
    setForm(old=>({...old,sectionId:first?.id||'',absenceDate:'',reason:''}));
    setModal('excuse');
  };
  const upcomingSlots=slots.filter(s=>(isStudent||s.facultyId===authUser?.userId)
    &&Date.parse(s.startAt)>Date.now()).sort((a,b)=>a.startAt.localeCompare(b.startAt));
  const filteredNotices=notices.filter(n=>{
    if(noticeFilter==='all')return true;
    if(noticeFilter==='unread')return !n.read;
    if(noticeFilter==='requests')return ['excuse','consultation'].includes(n.kind);
    return n.kind===noticeFilter;
  });
  const ownSessions = (data?.meetings || []).filter((m) => activeSections.some((s) => s.id === m.sectionId));
  const profileInitial = (profile?.name || 'C').split(/\s+/).slice(0, 2).map((x) => x[0] || '').join('').toUpperCase();
  const cardReadiness=[
    profile?.name,profile?.studentNumber,profile?.department,
    isFaculty?profile?.officeRoom:isStudent?profile?.yearLevel:profile?.email,
    profilePhotoUrl,
  ].filter(Boolean).length;
  const pendingExcuses = excuses.filter((e) => e.status === 'PENDING').length;
  const pendingBookings = bookings.filter((b) => b.status === 'PENDING').length;
  const pendingRoleUsers = users.filter(u => !!u.roleRequest);
  const filteredUsers = users.filter(u => {
    const eligible = accountView === 'pending' ? !!u.roleRequest : accountView === 'all' || u.role === accountView;
    const q = accountQuery.trim().toLowerCase();
    return eligible && (!q || [u.name,u.email,u.role,u.roleRequest].some(s => s.toLowerCase().includes(q)));
  });
  const finalizedAttendance=attendance.filter(a=>
    ['ACCEPTED','FACULTY_APPROVED','FACULTY_CORRECTED'].includes(a.verificationStatus));
  const statusParts:MonitorPart[]=[
    {label:'Present',value:finalizedAttendance.filter(a=>a.academicStatus==='PRESENT').length,color:'#219e75'},
    {label:'Late',value:finalizedAttendance.filter(a=>a.academicStatus==='LATE').length,color:'#e6a14c'},
    {label:'Absent',value:finalizedAttendance.filter(a=>a.academicStatus==='ABSENT').length,color:'#d76679'},
    {label:'Excused',value:finalizedAttendance.filter(a=>a.academicStatus==='EXCUSED').length,color:'#8076cc'},
  ];
  const sectionOutcomeBars=activeSections.filter(s=>!s.archivedAt).slice(0,6).map(section=>{
    const subject=finalizedAttendance.filter(a=>a.sectionId===section.id &&
      ['PRESENT','LATE','ABSENT'].includes(a.academicStatus));
    return {label:section.courseCode,value:subject.filter(a=>['PRESENT','LATE'].includes(a.academicStatus)).length,total:subject.length};
  });
  const adminRoleBars=operations?[
    {label:'Students',value:operations.roleCounts.Student,total:operations.roleCounts.Student+operations.roleCounts.Faculty+operations.roleCounts.Administrator},
    {label:'Faculty',value:operations.roleCounts.Faculty,total:operations.roleCounts.Student+operations.roleCounts.Faculty+operations.roleCounts.Administrator},
    {label:'Administrators',value:operations.roleCounts.Administrator,total:operations.roleCounts.Student+operations.roleCounts.Faculty+operations.roleCounts.Administrator},
  ]:[];
  const campusParts:MonitorPart[]=[
    {label:'Present',value:summary?.aggregate?.PRESENT||0,color:'#219e75'},
    {label:'Late',value:summary?.aggregate?.LATE||0,color:'#e6a14c'},
    {label:'Absent',value:summary?.aggregate?.ABSENT||0,color:'#d76679'},
    {label:'Excused',value:summary?.aggregate?.EXCUSED||0,color:'#8076cc'},
  ];
  const graded = attendance.filter((a) => ['PRESENT','LATE','ABSENT'].includes(a.academicStatus));
  const onTime = graded.filter((a) => a.academicStatus === 'PRESENT').length;
  const lateCount = graded.filter((a) => a.academicStatus === 'LATE').length;
  const attendanceRate = graded.length ? Math.round((onTime + lateCount) / graded.length * 100) + '%' : '—';
  const punctualityRate = onTime + lateCount ? Math.round(onTime / (onTime + lateCount) * 100) + '%' : '—';
  const phHour = Number(new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Manila',hour:'2-digit',hour12:false}).format(new Date()));
  const greeting = phHour < 12 ? 'Good morning' : phHour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (profile?.name || 'there').split(' ')[0];
  const liveSessions = live.activeSessions;
  const colorFor = (status: string) => ['APPROVED','PRESENT','CONFIRMED','ATTENDING','ACCEPTED'].includes(status) ? 'green' :
    ['REJECTED','ABSENT','CANCELLED'].includes(status) ? 'red' : ['PENDING','PENDING REVIEW','LATE','DELAYED','PENDING_REVIEW'].includes(status) ? 'amber' : 'violet';

  const sidebar = <><div className='cp-sidebar-brand'><Brand light/></div>
    <div className='cp-nav-section-title'>WORKSPACE / {role.toUpperCase()}</div><nav className='cp-side-links'>
      {pages[role].map(({ page: item, icon: Icon, label }) => <button key={item} onClick={() => navigate(item)} className={page === item ? 'active' : ''}><Icon size={19}/><span>{label}</span>{page === item && <span className='cp-nav-active-indicator'/>}</button>)}
    </nav>
    <div className='cp-sidebar-bottom'><button title='Sign out' aria-label='Sign out'
      onClick={() => safeRun('sign-out', signOut)}><LogOut size={18}/><span>Sign out</span></button></div></>;

  return <div className='cp-app'>
    <aside className='cp-sidebar'>{sidebar}</aside>
    {drawer && <div className='cp-drawer-overlay' onClick={() => setDrawer(false)}>
      <aside className='cp-drawer' role='navigation' aria-label='All ClassPulse pages'
        onClick={(ev) => ev.stopPropagation()}>
        <div className='cp-drawer-head'><strong>Menu</strong>
          <button type='button' onClick={()=>setDrawer(false)} aria-label='Close menu'>
            <X size={20}/>
          </button></div>{sidebar}
      </aside>
    </div>}
    <div className='cp-main'>
      <header className='cp-topbar'>
        <button className='cp-menu' aria-label='Open navigation'
          aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={22}/></button>
        <div className='cp-breadcrumb cp-page-crumb'>
          <strong>{page==='Overview'?'Dashboard':page}</strong>
        </div>
        <div className='cp-top-actions'>
        <span className={'cp-net ' + (online ? 'online' : 'offline')}>{online ? <Wifi size={14}/> : <CloudOff size={14}/>} {online ? 'Connected' : 'Offline'}</span>
        <button title='Toggle theme' className='cp-icon-button' onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={19}/> : <Sun size={19}/>}</button>
        {!isAdmin && <button title='Notifications' className='cp-icon-button' onClick={() => navigate('Notifications')}><Bell size={19}/>{notices.some((n) => !n.read) && <i/>}</button>}
        <button className='cp-profile-chip' onClick={() => navigate('Profile')} title='My profile'><span>{profileInitial}</span><div><strong>{profile?.name}</strong><small>{role}</small></div></button>
      </div></header>
      <main className='cp-content'>
        {page === 'Overview' && <>
          {!isAdmin && <section className='cp-intro-hero'><div><div className='cp-eyebrow light'><span className='cp-live-dot'/> {isFaculty ? 'YOUR TEACHING WORKSPACE' : 'YOUR CAMPUS COMPANION'}</div>
            <h1>{isAdmin ? 'Lead the system.' : `${greeting}, ${firstName}.`}</h1>
            <p>{isFaculty ? 'Classes, QR sessions, and requests.' : 'Your classes, attendance, and updates.'}</p>
            <button className='cp-button lime' onClick={() => isStudent ? openScanner() : navigate(isAdmin ? 'Administration' : 'Classes')}>
              {isStudent ? 'Scan class QR' : isFaculty ? 'View assigned classes' : 'Open control plane'}
              {isStudent ? <ScanLine size={17}/> : <ArrowUpRight size={17}/>}
            </button>
          </div><div className='cp-hero-symbol'><div><LogoMark large/><span>LIVE CAMPUS</span></div></div></section>}
          {!isAdmin && <div className='cp-stat-grid'>
            <article><span><BookOpen size={19}/></span><p>ENROLLED CLASSES</p><strong>{activeSections.length.toString().padStart(2,'0')}</strong><small>Current semester</small></article>
            <article><span><CheckCircle2 size={19}/></span><p>{isStudent ? 'ATTENDANCE RATE' : 'QR SESSIONS'}</p><strong>{isStudent ? attendanceRate : isAdmin ? '—' : ownSessions.length}</strong><small>{isStudent ? 'From real attendance records' : 'Faculty-started classes'}</small></article>
            <article><span><Activity size={19}/></span><p>{isStudent ? 'PUNCTUALITY' : isFaculty ? 'PENDING EXCUSES' : 'SYSTEM ACCESS'}</p><strong>{isStudent ? punctualityRate : isFaculty ? pendingExcuses : 'ON'}</strong><small>{isStudent ? 'On-time scanned attendance' : 'Authorized activity only'}</small></article>
            <article><span><QrCode size={19}/></span><p>{isStudent ? 'ACTIVE QR SESSIONS' : 'LIVE CLASS SESSIONS'}</p><strong>{isAdmin ? '—' : liveSessions.length.toString().padStart(2,'0')}</strong><small>Faculty-controlled QR activity</small></article>
          </div>}

          {isAdmin ? <>
            <div className='cp-admin-home-heading'>
              <div><span><span className='cp-live-dot'/> CAMPUS CONTROL PLANE</span>
                <h2>{greeting}, {firstName}.</h2><p>Approve roles, manage course sections, and monitor operational activity.</p></div>
              <button className='cp-button dark' onClick={() => setModal('create-section')}><Plus size={16}/> New class section</button>
            </div>
            <div className='cp-admin-command-grid'>
              <button className='cp-admin-command cp-approval-tile' onClick={() => {setAccountView('pending');navigate('Administration');}}>
                <span><UserCheck size={21}/></span><strong>{operations?.pendingRoles ?? pendingRoleUsers.length}</strong><b>Pending role requests</b><small>Review faculty applications</small><ArrowUpRight size={18}/></button>
              <button className='cp-admin-command' onClick={() => navigate('Classes')}>
                <span><BookOpen size={21}/></span><strong>{operations?.sectionsWithoutRoom ?? 0}</strong><b>Sections needing rooms</b><small>Complete approved schedules</small><ArrowUpRight size={18}/></button>
              <button className='cp-admin-command' onClick={() => navigate('Administration')}>
                <span><Users size={21}/></span><strong>{operations?.incompleteProfiles ?? 0}</strong><b>Incomplete profiles</b><small>Account onboarding status</small><ArrowUpRight size={18}/></button>
              <button className='cp-admin-command' onClick={() => navigate('Administration')}>
                <span><QrCode size={21}/></span><strong>{operations?.activeQrSessions ?? 0}</strong><b>Active QR sessions</b><small>Campus-wide count only</small><ArrowUpRight size={18}/></button>
            </div>
            <div className='cp-two-column cp-monitoring-grid'>
              <MonitoringDonut title='Campus attendance mix' eyebrow='AGGREGATE OUTCOMES'
                parts={campusParts} subtitle='Institution-wide totals only; individual student records remain restricted.'/>
              <MonitoringBars title='Account distribution' eyebrow='CAMPUS ROLES'
                rows={adminRoleBars} subtitle='Current verified account roles.'/>
            </div>
            <div className='cp-two-column cp-admin-dashboard-grid'>
              <section className='cp-panel'>
                <SectionTitle eyebrow='PRIORITY INBOX' title='Account approvals'
                  action={<button className='cp-link' onClick={() => {setAccountView('pending');navigate('Administration');}}>Manage all <ArrowUpRight size={14}/></button>}/>
                {pendingRoleUsers.length ? pendingRoleUsers.slice(0,5).map(u=>
                  <div className='cp-admin-queue-row' key={u.userId}>
                    <span className='cp-user-avatar'>{u.name?.[0] || '?'}</span>
                    <div><strong>{u.name}</strong><small>{u.email}</small></div>
                    <Pill color='amber'>{u.roleRequest}</Pill>
                    {u.roleRequest === 'Faculty' && <button className='cp-mini-btn'
                      onClick={() => safeRun('approve',async()=>{await api.post('/api/admin/role',{userId:u.userId,role:'Faculty'});await refreshAdministration();showMessage('Faculty account approved.');})}>Approve</button>}
                  </div>) : <Empty title='Approvals are clear' detail='New faculty access requests will appear here.' icon={CheckCircle2}/>}
              </section>
              <section className='cp-panel'>
                <SectionTitle eyebrow='CURRENT CAMPUS RECORDS' title='Operational snapshot'/>
                <div className='cp-admin-mini-metrics'>
                  <div><span>Verified faculty</span><b>{operations?.roleCounts.Faculty ?? 0}</b></div>
                  <div><span>Student accounts</span><b>{operations?.roleCounts.Student ?? 0}</b></div>
                  <div><span>Approved sections</span><b>{summary?.courseSections ?? 0}</b></div>
                  <div><span>Active enrollments</span><b>{operations?.enrolledStudents ?? 0}</b></div>
                </div>
                <div className='cp-admin-status-mix'>
                  {Object.entries(operations?.classStatus || {}).map(([status,count])=><div key={status}>
                    <span>{status}</span><div className='cp-admin-progress'><i style={{width:Math.round(count/Math.max(1,summary?.courseSections||0)*100)+'%'}}/></div><b>{count}</b></div>)}
                </div>
                <p className='cp-chart-note'>Counts are from approved records, not estimates or simulated analytics.</p>
              </section>
            </div>
            <div className='cp-two-column cp-admin-dashboard-grid'>
              <section className='cp-panel'>
                <SectionTitle eyebrow='CLASS MANAGEMENT' title='Recently configured sections'
                  action={<button className='cp-link' onClick={() => navigate('Classes')}>Open directory <ArrowUpRight size={14}/></button>}/>
                {activeSections.slice(0,5).map(s=><div className='cp-class-row' key={s.id}>
                  <span className='cp-class-icon'><BookOpen size={19}/></span>
                  <div><strong>{s.courseCode} · {s.section}</strong><small>{s.facultyName} · {s.room||'Room unassigned'}</small></div>
                  <button className='cp-mini-btn' onClick={() => {setForm(old=>({...old,sectionId:s.id,room:s.room,facultyId:s.facultyId,day:s.day,startTime:s.startTime,endTime:s.endTime}));setModal('edit-section');}}>Edit</button>
                </div>)}
                {!activeSections.length && <Empty title='No sections created' detail='Create your first course section to start academic operations.'/>}
              </section>
              <section className='cp-panel'>
                <SectionTitle eyebrow='SECURITY AUDIT' title='Recent administrative actions'
                  action={<button className='cp-link' onClick={() => navigate('Administration')}>Full audit <ArrowUpRight size={14}/></button>}/>
                {adminEvents.slice(0,5).map(e=><div key={e.id} className='cp-update-row'>
                  <span className='cp-update-dot'/><div><strong>{e.actionType.replace(/_/g,' ')}</strong><small>{dateFmt(e.timestamp)}</small></div>
                </div>)}
                {!adminEvents.length && <Empty title='No recent admin events' detail='Account approvals and class changes are audited.' icon={LockKeyhole}/>}
              </section>
            </div>
          </>
          : isStudent ? <>
            <div className='cp-two-column cp-dashboard-top'>
              <section className='cp-panel cp-class-status-board'>
                <SectionTitle eyebrow='YOUR SUBJECTS' title='Class status'/>
                {activeSections.length ? activeSections.map((s) => {
                  const latest = live.updates.find((u) => u.sectionId === s.id);
                  const status = latest?.type || s.status;
                  return <div className='cp-class-status-row' key={s.id}>
                    <span className='cp-class-icon'><BookOpen size={19}/></span>
                    <div><button type='button' className='cp-subject-dashboard-open'
                      onClick={()=>{setExpandedSubjectId(s.id);navigate('Classes');}}>
                      <strong>{s.courseCode} · {s.title}</strong>
                      <ChevronRight size={15}/></button>
                    <small>{s.day} {s.startTime}–{s.endTime} · {latest?.room || s.room || 'Room not assigned'}</small>
                    {latest?.message && <p>{latest.message}</p>}</div>
                    <Pill color={colorFor(status)}>{status}</Pill>
                  </div>;
                }) : <Empty title='No enrolled subjects yet' detail='Use a faculty-provided class join code to add your enrolled subjects.'/>}
              </section>
              <section className='cp-panel cp-faculty-presence-panel'>
                <SectionTitle eyebrow='ENROLLED FACULTY' title='Faculty availability' subtitle='Published status and QR sessions.'/>
                {live.faculty.length ? live.faculty.map((f) => {
                  const stale = f.updatedAt && Date.now()-Date.parse(f.updatedAt) > 45*60000 && f.source !== 'QR session';
                  return <div className='cp-faculty-row' key={f.facultyId}>
                    <span className='cp-faculty-avatar'><Users size={19}/></span>
                    <div><strong>{f.name}</strong><small>{f.classCodes.join(' · ')}</small><small>{f.updatedAt ? (stale ? 'Last reported ' : 'Updated ') + dateFmt(f.updatedAt) : 'No availability published yet'}</small></div>
                    <Pill color={f.status === 'AVAILABLE' ? 'green' : f.status === 'IN CLASS' ? 'violet' : f.status === 'AWAY' ? 'amber' : 'default'}>{stale ? 'LAST: ' + f.status : f.status}</Pill>
                  </div>;
                }) : <Empty title='Faculty status will appear here' detail='Once you join sections, availability from your assigned faculty will be visible here.'/>}
                <p className='cp-presence-disclaimer'><ShieldCheck size={14}/> Live academic status, not GPS location or personal tracking.</p>
              </section>
            </div>
            <AttendanceAnalytics attendance={attendance} meetings={data?.meetings || []}/>
            <MonitoringDonut title='My attendance outcomes' eyebrow='RECORDED STATUS'
              parts={statusParts} subtitle='Finalized subject records; pending reviews are excluded.'/>
            <StudentAttendanceInsights sections={activeSections} meetings={data?.meetings || []} attendance={attendance}/>
            <div className='cp-two-column cp-dashboard-lower'>
              <section className='cp-panel'>
                <SectionTitle eyebrow='FACULTY-GENERATED' title='ACTIVE CLASSROOM QR SESSIONS' subtitle='Only meetings that faculty have explicitly opened show here.'/>
                {liveSessions.length ? liveSessions.map((m) => <div className='cp-live-session-row' key={m.id}>
                  <span className='cp-live-session-icon'><QrCode size={24}/></span>
                  <div><strong>{m.courseCode}</strong><small>{dateFmt(m.openedAt)} · Session live</small></div>
                  <button className='cp-mini-btn' onClick={openScanner}><ScanLine size={15}/> Scan in class</button>
                </div>) : <Empty title='No active classroom QR sessions' detail='Your faculty will generate a QR session when attendance opens. No session means no automatic absence.'/>}
              </section>
              <section className='cp-panel'>
                <SectionTitle eyebrow='CLASS ANNOUNCEMENTS' title='Latest subject updates' subtitle='Class cancellations, delays, rooms, and other status changes.'/>
                {live.updates.length ? live.updates.slice(0,6).map((u) => <div className='cp-update-row' key={u.id}>
                  <span className='cp-update-dot'/>
                  <div><strong>{u.courseCode} · {u.type}</strong><p>{u.message || 'Status updated by faculty.'}</p><small>{dateFmt(u.publishedAt)}</small></div>
                </div>) : <Empty title='No recent class updates' detail='Changes published by faculty will appear here and in notifications.'/>}
              </section>
            </div>
          </> : <>
            <div className='cp-two-column'>
              <section className='cp-panel'><SectionTitle eyebrow='YOUR TEACHING SCHEDULE' title='Assigned classes' action={<button className='cp-link' onClick={() => navigate('Classes')}>Manage subjects <ArrowUpRight size={14}/></button>}/>
                {activeSections.length ? activeSections.slice(0,7).map((s) => <div className='cp-class-row' key={s.id}><span className='cp-class-icon'><BookOpen size={20}/></span><div><button type='button' className='cp-subject-dashboard-open'
                onClick={()=>{setExpandedSubjectId(s.id);navigate('Classes');}}>
                <strong>{s.courseCode} · {s.title}</strong><ChevronRight size={15}/></button>
                <small>{s.day} · {s.startTime}–{s.endTime} · {s.room}</small></div><Pill color={colorFor(s.status)}>{s.status}</Pill></div>) : <Empty title='No classes assigned' detail='Your administrator must assign an approved class before you can open attendance.'/>}
              </section>
              <section className='cp-panel cp-faculty-control'><SectionTitle eyebrow='FACULTY LIVE STATUS' title='Publish your availability' subtitle='Students enrolled in your classes can see this status. No location data is collected.'/>
                <div className='cp-faculty-status-controls' role='group' aria-label='Publish faculty availability'>{[
                  {status:'AVAILABLE' as PresenceStatus, label:'Available', className:'available', Icon:CheckCircle2, sub:'Open for consultation'},
                  {status:'IN CLASS' as PresenceStatus, label:'In class', className:'inclass', Icon:BookOpen, sub:'Currently teaching'},
                  {status:'AWAY' as PresenceStatus, label:'Away', className:'away', Icon:Clock3, sub:'Not available'},
                ].map(({status,label,className,Icon,sub}) => {
                  const selected=myPresence.status===status;
                  return <button key={status} type='button' aria-pressed={selected}
                    aria-label={'Set faculty status to '+label}
                    className={'cp-presence-control '+className+(selected?' active':'')}
                    onClick={()=>{void setFacultyPresence(status);}}>
                    <span className='cp-presence-head'><Icon size={18}/>{selected ? <Check size={18} className='cp-presence-selected'/> : <span className='cp-presence-empty-check'/>}</span>
                    <strong>{label}</strong><small>{selected?'Selected':sub}</small>
                  </button>;
                })}</div>
                <p className='cp-presence-feedback' role='status' aria-live='polite'>
                  <span className='cp-presence-state-dot'/>
                  {myPresence.status==='NOT SET'?'Status not set':myPresence.status.toLowerCase()}
                  {myPresence.updatedAt ? ' · '+dateFmt(myPresence.updatedAt) : ''}
                </p>
                <p className='cp-chart-note'>Students see your published status. A live QR session may temporarily show “In class.”</p>
                <div className='cp-faculty-pulse'><span><QrCode size={17}/> {liveSessions.length} active QR sessions</span><span><FileText size={17}/> {pendingExcuses} pending excuses</span></div>
                <button className='cp-button dark' onClick={() => navigate('Attendance')}>Manage QR attendance <ArrowRight size={16}/></button>
              </section>
            </div>
            <div className='cp-two-column cp-monitoring-grid'>
              <MonitoringDonut title='Class attendance breakdown' eyebrow='FACULTY ANALYTICS'
                parts={statusParts} subtitle='Finalized records across your assigned subjects.'/>
              <MonitoringBars title='Subject attendance' eyebrow='MY CLASS MONITOR'
                rows={sectionOutcomeBars} subtitle='Present and late outcomes as a share of finalized records.'/>
            </div>
            <div className='cp-two-column cp-dashboard-lower'>
              <section className='cp-panel'><SectionTitle eyebrow='IN SESSION' title='Active classroom QR sessions'/>
              {liveSessions.length ? liveSessions.map((m) => <div key={m.id} className='cp-live-session-row'><span className='cp-live-session-icon'><QrCode size={20}/></span><div><strong>{m.courseCode}</strong><small>Opened {dateFmt(m.openedAt)}</small></div><button className='cp-mini-btn' onClick={() => qrModal(m)}>Display QR</button></div>) : <Empty title='No active sessions' detail='When you open a class QR, the active session appears here.'/>}</section>
              <section className='cp-panel'><SectionTitle eyebrow='RECENTLY PUBLISHED' title='Your class updates'/>
              {live.updates.length ? live.updates.slice(0,6).map((u) => <div className='cp-update-row' key={u.id}><span className='cp-update-dot'/><div><strong>{u.courseCode} · {u.type}</strong><p>{u.message || 'Class status changed.'}</p></div></div>) : <Empty title='No updates published' detail='Publish a classroom status from the Classes page.'/>}</section>
            </div>
          </>}
          <div className='cp-secondary-note'><ShieldCheck size={19}/> Records and permissions are enforced on the server. Student attendance details never appear in administrator reports.</div>
        </>}

        {page === 'Classes' && <>
          <SectionTitle eyebrow={isAdmin ? 'REFERENCE DATA' : 'ACADEMIC SCHEDULE'} title={isAdmin ? 'Class directory' : isFaculty ? 'My subjects' : 'My schedule'} subtitle={isAdmin ? 'Class assignments and join codes.' : undefined}
            action={isStudent ? <button className='cp-button dark' onClick={() => setModal('join')}><Plus size={17}/> Join a class</button> : isFaculty ? <button className='cp-button dark' onClick={newMySubject}><Plus size={17}/> Add subject</button> : isAdmin ? <button className='cp-button dark' onClick={() => setModal('create-section')}><Plus size={17}/> Create class</button> : undefined}/>
          {!isAdmin && !expandedSubjectId && <ClassDayFocus sections={sections}/>}
          {!isAdmin && !expandedSubjectId && sections.length>0 && <section id='classpulse-week-schedule' className='cp-panel cp-week-panel'>
            <div className='cp-week-toolbar'><div><span>MY CLASS WEEK</span></div>
              <button className='cp-mini-btn cp-week-export' onClick={()=>{
                if(!exportWeeklyCalendar(sections,isFaculty?'faculty':'student')) showMessage('No active class schedule to export.');
                else showMessage('Calendar saved. Import the .ics file into your calendar app.');
              }}><CalendarDays size={16}/> Export calendar</button></div>
            <WeekTimetable sections={sections} role={role} onRoster={isFaculty ? (id)=>{void loadFacultyRoster(id);} : undefined}/>
          </section>}
          <section className='cp-panel'><div className='cp-table-scroll'><table className='cp-table cp-classes-table'><thead><tr><th>CLASS</th><th>WHEN</th><th>ROOM</th><th>FACULTY</th><th>STATUS</th><th>MANAGE</th></tr></thead><tbody>{sections.filter(s=>!expandedSubjectId||s.id===expandedSubjectId).map((s) => <Fragment key={s.id}>{expandedSubjectId!==s.id&&<tr><td>{isAdmin
            ? <><b>{s.courseCode}</b><small>{s.title} · {s.section}</small></>
            : <button type='button' className='cp-subject-open' aria-expanded={expandedSubjectId===s.id}
                onClick={()=>setExpandedSubjectId(prev=>prev===s.id?null:s.id)}>
                <strong>{s.courseCode}</strong><small>{s.title} · {s.section}</small>
                <ChevronRight size={17} className={expandedSubjectId===s.id?'rotated':''}/>
              </button>}</td><td>{s.day}<small>{s.startTime}–{s.endTime}</small></td><td>{s.room || 'Unassigned'}</td><td>{s.facultyName}</td><td><Pill color={s.archivedAt ? 'amber' : colorFor(s.status)}>{s.archivedAt ? 'ARCHIVED' : s.status}</Pill></td><td>{isFaculty ? <div className='cp-faculty-class-actions'>
  <div className='cp-faculty-code'><span>JOIN CODE</span><code>{s.archivedAt ? 'Inactive' : s.joinCode || '—'}</code></div>
  <button className='cp-mini-btn primary' onClick={()=>{void loadFacultyRoster(s.id);}}><Users size={14}/> Roster</button>
  {!s.archivedAt ? <>
    <button className='cp-mini-btn' onClick={()=>editMySubject(s)}><Settings size={14}/> Edit</button>
    <button className='cp-mini-btn' onClick={()=>{update('sectionId',s.id);update('status',s.status);update('room',s.room);setModal('status');}}><Bell size={14}/> Update</button>
    <button className='cp-mini-btn' title='Replace subject join code' onClick={()=>safeRun('faculty-code',async()=>{
      if(!window.confirm('Issue a new join code for '+s.courseCode+'?'))return;
      await api.post('/api/faculty/sections/'+s.id+'/rotate-code',{});
      await refreshPage('Classes');showMessage('New join code issued. Share it with your students.');
    })}><RefreshCcw size={14}/> Code</button>
    <button className='cp-mini-btn danger' onClick={()=>safeRun('remove-subject',async()=>{
      if(!window.confirm('Remove '+s.courseCode+'? Subjects with academic records will be archived to preserve history.'))return;
      const result=await api.post('/api/faculty/sections/'+s.id+'/remove',{});
      await refreshPage('Classes');
      showMessage((result.data as {message:string}).message);
    })}>Remove</button>
  </> : <button className='cp-mini-btn' onClick={()=>safeRun('restore-subject',async()=>{
    await api.post('/api/faculty/sections/'+s.id+'/restore',{});
    await refreshPage('Classes');showMessage('Subject restored with a new class join code.');
  })}>Restore</button>}
</div> : isAdmin ? <div className='cp-admin-section-actions'>
  <code className='cp-code'>{s.joinCode}</code>
  <button className='cp-mini-btn' onClick={()=>{setForm(old=>({...old,sectionId:s.id,facultyId:s.facultyId,day:s.day,startTime:s.startTime,endTime:s.endTime,room:s.room}));setModal('edit-section');}}>Edit</button>
  <button className='cp-mini-btn' title='Replace class join code'
    onClick={()=>safeRun('rotate-code',async()=>{
      if(!window.confirm('Replace the join code for '+s.courseCode+'? Existing enrollments remain valid.'))return;
      await api.post('/api/admin/section/'+s.id+'/rotate-code',{});
      await refreshPage('Classes');showMessage('New class code issued. The previous code no longer works.');
    })}><RefreshCcw size={14}/> Rotate</button>
</div> : <Pill>Enrolled</Pill>}</td></tr>}
            {expandedSubjectId===s.id&&!isAdmin&&<tr className='cp-subject-table-expanded'><td colSpan={6}>
              <SubjectDetailPanel key={s.id} section={s} role={role}
                onRoster={isFaculty ? id=>{void loadFacultyRoster(id);} : undefined}
                onClose={()=>setExpandedSubjectId(null)}/>
            </td></tr>}
          </Fragment>)}</tbody></table></div>{sections.length === 0 && <Empty title='No subjects yet' detail={isStudent ? 'Enter your course join code.' : isFaculty ? 'Add a subject to get started.' : 'Create a course section to get started.'}/>}
          {isFaculty && <p className='cp-class-management-note'><ShieldCheck size={15}/> Historical attendance is preserved when a subject is archived.</p>}</section>
        </>}

        {page === 'Attendance' && !isAdmin && <>
          <SectionTitle eyebrow='QR ATTENDANCE' title={isFaculty ? 'Attendance' : 'My attendance'}
            subtitle={isFaculty ? 'Generate a QR for a scheduled class.' : undefined}/>
          {isStudent && <div className='cp-attendance-cta cp-attendance-cta-compact cp-checkin-scene'>
            <div className='cp-checkin-copy'>
              <span className='cp-checkin-eyebrow'>CLASS ATTENDANCE</span>
              <h2>Class check-in</h2>
              <button type='button' className='cp-button lime cp-checkin-button' onClick={openScanner}>
                <ScanLine size={18}/> Scan QR <ArrowRight size={15}/>
              </button>
            </div>
            <div className='cp-checkin-visual' aria-hidden='true'>
              <div className='cp-checkin-halo'/>
              <div className='cp-checkin-slab cp-checkin-slab-back'/>
              <div className='cp-checkin-slab cp-checkin-slab-front'>
                <QrCode size={71} strokeWidth={1.5}/>
                <span className='cp-checkin-beam'/>
                <i className='cp-checkin-corner tl'/><i className='cp-checkin-corner tr'/>
                <i className='cp-checkin-corner bl'/><i className='cp-checkin-corner br'/>
              </div>
              <span className='cp-checkin-glint cp-checkin-glint-one'/>
              <span className='cp-checkin-glint cp-checkin-glint-two'/>
            </div>
          </div>
          }{isFaculty && <section className='cp-panel'><SectionTitle eyebrow='START A SESSION' title='Open attendance'/><div className='cp-session-grid'>{sections.filter(s=>!s.archivedAt).map((s) => {
            const canOpenToday = matchesClassDay(s.day, dateOnly());
            const meeting = ownSessions.find((m) => m.sectionId === s.id && m.status === 'OPEN');
            return <article className='cp-session-card' key={s.id}><span>{s.courseCode} · {s.section}</span><h3>{s.title}</h3><small>{s.day} · {s.startTime} – {s.endTime}</small>{meeting ? <div className='cp-inline-actions'><button className='cp-button dark' onClick={() => qrModal(meeting)}><QrCode size={16}/> Display QR</button><button className='cp-mini-btn' onClick={() => safeRun('roster', async () => rosterModal(meeting))}>Roster</button></div>
              : <button disabled={!!busy || !canOpenToday} className='cp-button dark' onClick={() => safeRun('session', async () => openMeeting(s.id))}><Plus size={16}/> {!canOpenToday ? 'Not scheduled today' : 'Generate QR session'}</button>}</article>;
          })}</div>{sections.length === 0 && <Empty title='No assigned sections' detail='An administrator must assign a section to your Faculty account before you can open its QR attendance.'/>}</section>}
          {isStudent && <StudentAttendanceInsights sections={sections} meetings={data?.meetings || []} attendance={attendance}/>}
          {isStudent && <OfflineSyncCenter scans={outbox} online={online} syncing={queueBusy}
            problem={queueProblem} onSync={()=>{void syncOutbox();}}
            onRetry={()=>{void safeRun('retry',retryQueuedScans);}}/>}
          <section className='cp-panel'><SectionTitle eyebrow='VERIFIED RECORDS' title='Attendance history' action={<button className='cp-link' onClick={() => csvExport('classpulse-attendance.csv', attendance.map((a) => ({ Section: sections.find((s) => s.id === a.sectionId)?.courseCode || '', Status: a.academicStatus, Validation: a.verificationStatus, Captured: a.capturedAt || '', Received: a.receivedAt || '' })))}><Download size={16}/> Export CSV</button>}/>
            <div className='cp-table-scroll'><table className='cp-table cp-attendance-table'><thead><tr><th>CLASS</th><th>CAPTURED</th><th>ACADEMIC STATUS</th><th>VERIFICATION</th>{isFaculty && <th>REVIEW</th>}</tr></thead><tbody>{attendance.map((a) => <tr key={a.id}><td><b>{sections.find((s) => s.id === a.sectionId)?.courseCode || 'Class'}</b></td><td>{a.capturedAt ? dateFmt(a.capturedAt) : 'Not scanned'}</td><td><Pill color={colorFor(a.academicStatus)}>{a.academicStatus}</Pill></td><td>{a.verificationStatus}</td>{isFaculty && <td><button className='cp-mini-btn' onClick={() => { update('sessionId', a.sessionId); update('studentId', a.studentId); update('status', a.academicStatus); setModal('review'); }}>Review</button></td>}</tr>)}</tbody></table></div>
            {attendance.length === 0 && <Empty title='No attendance records yet' detail='Records appear after a valid faculty QR session is created and scanned.'/>}
          </section>
        </>}


        {page === 'Student Records' && isFaculty && <>
          <SectionTitle eyebrow='FACULTY RECORDS' title='Student Records'
            subtitle='View your enrolled students, review scan results, and export subject reports.'/>
          <section className='cp-panel cp-record-filters'>
            <label className='cp-field'><span>Subject / section</span>
              <select value={selectedSubjectId} onChange={e=>{
                if(e.target.value)void loadFacultyRoster(e.target.value);
                else {setSelectedSubjectId('');setFacultyRoster(null);}
              }}>
                <option value=''>Select a subject</option>
                {sections.map(s=><option key={s.id} value={s.id}>{s.courseCode} · {s.section}{s.archivedAt?' (Archived)':''}</option>)}
              </select>
            </label>
            <label className='cp-field'><span>Student name or ID</span>
              <input value={rosterSearch} onChange={e=>setRosterSearch(e.target.value)}
                placeholder='Find a student' aria-label='Search enrolled students'/>
            </label>
            <label className='cp-field'><span>Record status</span>
              <select value={recordStatusFilter} onChange={e=>setRecordStatusFilter(e.target.value)}>
                {['ALL','PRESENT','LATE','ABSENT','EXCUSED','PENDING REVIEW'].map(x=>
                  <option key={x} value={x}>{x==='ALL'?'All recorded statuses':x}</option>)}
              </select>
            </label>
            <label className='cp-field'><span>From</span><input type='date' value={recordFrom}
              onChange={e=>setRecordFrom(e.target.value)}/></label>
            <label className='cp-field'><span>Until</span><input type='date' value={recordUntil}
              onChange={e=>setRecordUntil(e.target.value)}/></label>
            <button className='cp-mini-btn cp-record-export' disabled={!facultyRoster}
              onClick={()=>{
                if(!facultyRoster)return;
                const matching=facultyRoster.records.filter(r=>{
                  const student=facultyRoster.students.find(s=>s.studentId===r.studentId);
                  const q=rosterSearch.trim().toLowerCase();
                  const stamp=phDateOf(r.capturedAt||r.receivedAt);
                  return (!q||[student?.name,student?.studentNumber].join(' ').toLowerCase().includes(q))
                    &&(recordStatusFilter==='ALL'||r.academicStatus===recordStatusFilter)
                    &&(!recordFrom||stamp>=recordFrom)&&(!recordUntil||stamp<=recordUntil);
                });
                csvExport('classpulse-'+facultyRoster.section.courseCode+'-attendance.csv',
                  matching.map(r=>{
                    const student=facultyRoster.students.find(s=>s.studentId===r.studentId);
                    return {Subject:facultyRoster.section.courseCode,Section:facultyRoster.section.section,
                      Student:student?.name||'Student',StudentID:student?.studentNumber||'',
                      Status:r.academicStatus,Verification:r.verificationStatus,
                      ScanCaptured:r.capturedAt||'',ReceivedAt:r.receivedAt||'',
                      ReviewReason:r.reviewReason||''};
                  }));
                showMessage(matching.length?'Attendance report exported.':'No records match these filters.');
              }}><Download size={16}/> Export report</button>
          </section>
          {facultyRosterLoading && <section className='cp-panel cp-record-loading'><span className='cp-spinner'/> Loading verified class records…</section>}
          {!facultyRosterLoading && !facultyRoster &&
            <section className='cp-panel'><Empty title='Choose a subject'
              detail='Select your class to see student rosters, attendance history and reports.' icon={Users}/></section>}
          {!facultyRosterLoading && facultyRoster && <>
            <div className='cp-record-summary'>
              <div><span>Enrolled students</span><strong>{facultyRoster.students.length}</strong></div>
              <div><span>QR class sessions</span><strong>{facultyRoster.meetings.length}</strong></div>
              <div><span>Recorded attendance</span><strong>{facultyRoster.records.length}</strong></div>
              <div><span>For faculty review</span><strong>{facultyRoster.records.filter(r=>r.verificationStatus==='PENDING_REVIEW').length}</strong></div>
            </div>
            <section className='cp-panel cp-record-roster'>
              <div className='cp-record-heading'><div><span>ENROLLED ROSTER</span>
                <h2>{facultyRoster.section.courseCode} · {facultyRoster.section.section}</h2></div>
                <button className='cp-mini-btn' disabled={!!busy}
                  onClick={()=>{void loadFacultyRoster(facultyRoster.section.id,false);}}>
                  <RefreshCcw size={15}/> Refresh</button></div>
              {facultyRoster.students.filter(s=>[s.name,s.studentNumber].join(' ').toLowerCase()
                .includes(rosterSearch.trim().toLowerCase())).map(student=>{
                  const records=facultyRoster.records.filter(r=>{
                    const stamp=phDateOf(r.capturedAt||r.receivedAt);
                    return r.studentId===student.studentId
                      &&(recordStatusFilter==='ALL'||r.academicStatus===recordStatusFilter)
                      &&(!recordFrom||stamp>=recordFrom)&&(!recordUntil||stamp<=recordUntil);
                  }).sort((x,y)=>y.receivedAt.localeCompare(x.receivedAt));
                  // Informational risk estimate only; the backend remains authoritative
                  // for excused absences, attendance conversion, and drop decisions.
                  const absenceCount=student.counts.ABSENT;
                  const lateCount=student.counts.LATE;
                  const riskCount=absenceCount+Math.floor(lateCount/3);
                  const attendanceWarning=riskCount>=5?'DROP REVIEW':riskCount>=3?'HIGH RISK':riskCount>=2?'WARNING':'';
                  const open=expandedStudent===student.studentId;
                  return <article className='cp-record-student' key={student.studentId}>
                    <button type='button' className='cp-record-student-head'
                      aria-expanded={open} onClick={()=>setExpandedStudent(open?null:student.studentId)}>
                      {student.photo?<img src={student.photo} alt=''/>:
                        <span className='cp-record-avatar'>{student.name.charAt(0)}</span>}
                      <span className='cp-record-name'><strong>{student.name}</strong>
                        <small>{student.studentNumber||'Student ID not provided'}</small></span>
                      <span className='cp-record-badges'>
                        <small>{student.counts.PRESENT} present</small>
                        <small>{student.counts.LATE} late</small>
                        <small>{student.counts.ABSENT} absent</small></span>
                      {attendanceWarning&&<Pill color={riskCount>=5?'red':'amber'}>
                        <span aria-hidden='true'>● </span>{attendanceWarning}
                      </Pill>}
                      {student.pendingReview>0&&<Pill color='amber'>{student.pendingReview} pending</Pill>}
                      <ChevronRight size={18} className={open?'rotated':''}/>
                    </button>
                    {open&&<div className='cp-record-history'>
                      {records.length?records.map(r=><div className='cp-record-event' key={r.id}>
                        <div><strong>{dateFmt(r.capturedAt||r.receivedAt)}</strong>
                          <small>{r.verificationStatus.replace(/_/g,' ')} · {r.reviewReason||'QR attendance'}</small></div>
                        <Pill color={colorFor(r.academicStatus)}>{r.academicStatus}</Pill>
                        <button className='cp-mini-btn' onClick={()=>{
                          update('sessionId',r.sessionId);update('studentId',r.studentId);
                          update('status',['PRESENT','LATE','ABSENT','EXCUSED'].includes(r.academicStatus)?r.academicStatus:'PRESENT');
                          update('reason','');setModal('review');
                        }}><FileCheck2 size={14}/> Correct</button>
                      </div>):<p className='cp-chart-note'>No attendance records match the selected filters.</p>}
                      {(facultyRoster.corrections||[]).filter(c=>c.studentId===student.studentId)
                        .slice(0,5).map(c=><div className='cp-record-audit' key={c.id}>
                          <ShieldCheck size={14}/><span>{c.previousStatus} → {c.nextStatus} · {c.reason}
                            <small>{dateFmt(c.timestamp)}</small></span></div>)}
                    </div>}
                  </article>;
                })}
              {!facultyRoster.students.length&&<Empty title='No enrolled students'
                detail='Students can join using the subject join code. Records appear after Faculty QR sessions.' icon={Users}/>}
            </section>
            <p className='cp-record-privacy'><ShieldCheck size={17}/>
              Manual corrections require a reason and are recorded in the audit trail. Original QR timestamps are preserved. No session means no automatic absence.</p>
          </>}
        </>}

        {page === 'Excuses' && !isAdmin && <>
          <SectionTitle eyebrow='DIGITAL EXCUSE' title={isFaculty ? 'Excuse inbox' : 'My excuses'} subtitle={undefined}
            action={isStudent ? <button className='cp-button dark' onClick={openNewExcuse}><Plus size={17}/> New excuse</button> : undefined}/>
          <section className='cp-panel cp-excuse-library-panel'>
            <ExcuseFileStack excuses={excuses} sections={sections} isFaculty={isFaculty}
              onAttachment={(excuseId)=>safeRun('file',async()=>{
                const response=await api.get('/api/excuses/'+excuseId+'/file');
                window.open((response.data as {url:string}).url,'_blank','noopener');
              })}
              onDecision={(excuse)=>{update('excuseId',excuse.id);update('reason','');setModal('excuse-decision');}}/>
          </section>
        </>}

        {page === 'Consultations' && !isAdmin && <>
          <SectionTitle eyebrow='CONSULTATION BOOKING' title={isFaculty ? 'Consultation calendar' : 'Faculty consultations'} subtitle={isFaculty ? 'Publish available times.' : 'Choose a slot; faculty confirms.'}
            action={isFaculty ? <button className='cp-button dark' onClick={showSlotCalendar}><CalendarDays size={17}/> Open calendar</button> : undefined}/>
          
          <div className='cp-two-column'><section className='cp-panel'><SectionTitle eyebrow='OPEN TIMES' title='Available slots'/><div className='cp-slot-carousel' tabIndex={0} role='region' aria-label='Swipe consultation slots'>{upcomingSlots.map((s) => <article className='cp-slot cp-slot-slide' key={s.id}><span className='cp-slot-calendar'><CalendarClock size={22}/></span><div><span className='cp-slot-course'>{s.subjectCode||'General consultation'}</span>
              <strong>{dateFmt(s.startAt)}</strong>
              <small>{s.subjectTitle ? s.subjectTitle+' · ' : ''}{s.facultyName}</small>
              <small>{s.confirmedCount}/{s.capacity} confirmed</small></div>{isStudent && <button className='cp-mini-btn' disabled={s.confirmedCount >= s.capacity} onClick={() => { update('slotId', s.id); setModal('booking'); }}>{s.confirmedCount >= s.capacity ? 'Full' : 'Request'}</button>}
            {isFaculty && <button className='cp-mini-btn danger' title='Cancel this consultation date'
              onClick={() => safeRun('cancel-slot', async () => {
                if (!window.confirm('Cancel this consultation? Confirmed and pending students will be notified.')) return;
                const response = await api.post('/api/slots/'+s.id+'/cancel',{});
                await refreshPage('Consultations');
                showMessage('Consultation cancelled. '+(response.data as {affectedBookings:number}).affectedBookings+' booking(s) affected.');
              })}><X size={14}/> Cancel</button>}</article>)}</div>{upcomingSlots.length === 0 && <Empty title='No upcoming slots' detail='Faculty availability will appear here.'/>}</section>
          <section className='cp-panel'><SectionTitle eyebrow='BOOKING HISTORY' title='Consultation requests'/><div className='cp-request-list'>{bookings.map((b) => <article className='cp-request compact' key={b.id}><span className='cp-request-icon'><CalendarClock size={20}/></span><div><span className='cp-slot-course'>{b.slot?.subjectCode||'General consultation'}</span>
                  <strong>{b.slot ? dateFmt(b.slot.startAt) : 'Consultation'}</strong><p>{b.topic}</p><small>{b.decisionReason || ''}</small></div><Pill color={colorFor(b.status)}>{b.status}</Pill>
                  {isStudent && ['PENDING','CONFIRMED'].includes(b.status) && b.slot && Date.parse(b.slot.startAt)>Date.now() &&
                    <button className='cp-mini-btn danger' disabled={!!busy}
                      onClick={()=>safeRun('cancel-own-booking',async()=>{
                        if(!window.confirm('Cancel this consultation request?')) return;
                        await api.post('/api/bookings/'+b.id+'/cancel',{});
                        await refreshPage('Consultations');
                        showMessage('Consultation cancelled. You can book another available date.');
                      })}><X size={14}/> Cancel</button>}
                  {isFaculty && b.status === 'PENDING' && <button className='cp-mini-btn' onClick={() => { update('bookingId', b.id); update('reason', ''); setModal('booking-decision'); }}>Decide</button>}</article>)}</div>{bookings.length === 0 && <Empty title='No consultation requests' detail='New requests appear here with a pending status.'/>}</section></div>
        </>}

        {page === 'Notifications' && !isAdmin && <>
          <SectionTitle eyebrow='ACADEMIC UPDATES' title='Notifications'/>
          <div className='cp-notice-toolbar'>
            <div className='cp-notice-filters' role='group' aria-label='Filter notifications'>
              {([
                ['all','All'],['unread','Unread'],['class','Classes'],
                ['attendance','Attendance'],['requests','Requests'],
              ] as const).map(([key,label])=><button key={key} type='button'
                className={noticeFilter===key?'active':''} aria-pressed={noticeFilter===key}
                onClick={()=>setNoticeFilter(key)}>{label}
                {key==='unread'&&notices.some(n=>!n.read)&&<span>{notices.filter(n=>!n.read).length}</span>}
              </button>)}
            </div>
            {notices.some(n=>!n.read)&&<button type='button' className='cp-mini-btn' disabled={!!busy}
              onClick={()=>safeRun('read-all',async()=>{
                for(const notice of notices.filter(n=>!n.read)) {
                  await api.post('/api/notices/'+notice.id+'/read',{});
                }
                await refreshPage('Notifications');
              })}><Check size={15}/> Mark all read</button>}
          </div>
          <section className='cp-panel cp-notification-list'>
            {[
              {title:'Today',items:filteredNotices.filter(n=>phDateOf(n.createdAt)===dateOnly())},
              {title:'Earlier',items:filteredNotices.filter(n=>phDateOf(n.createdAt)!==dateOnly())},
            ].map(group=>group.items.length>0&&<div className='cp-notice-group' key={group.title}>
              <h3>{group.title}</h3>
              {group.items.map(n=><button type='button' key={n.id}
                className={'cp-notification '+(n.read?'read':'')}
                onClick={()=>safeRun('mark-read',async()=>{
                  if(!n.read){await api.post('/api/notices/'+n.id+'/read',{});await refreshPage('Notifications');}
                })}>
                <span className='cp-request-icon'>{n.kind==='attendance'?<ScanLine size={19}/>:
                  n.kind==='class'?<BookOpen size={19}/>:
                  n.kind==='consultation'?<CalendarClock size={19}/>:<Bell size={19}/>}</span>
                <div><strong>{n.title}</strong><p>{n.body}</p><small>{dateFmt(n.createdAt)}</small></div>
                {!n.read&&<span className='cp-unread'/>}
              </button>)}
            </div>)}
            {!filteredNotices.length&&<Empty title='No updates' detail='Try another filter.'/>}
          </section>
        </>}

        {page === 'Administration' && isAdmin && <>
          <SectionTitle eyebrow='CAMPUS OPERATIONS' title='Administrator workspace'
            subtitle='Role approvals, class reference management, audit activity and aggregate-only reporting.'
            action={<button className='cp-button dark' onClick={() => setModal('create-section')}><Plus size={16}/> New section</button>}/>
          <section className='cp-panel cp-admin-invites-panel'>
            <div className='cp-admin-invites-head'>
              <div><strong>Administrator invitations</strong>
                <small>Verified email required · Only existing administrators can invite</small></div>
              <button type='button' className='cp-mini-btn primary' onClick={()=>{
                update('inviteEmail','');setModal('invite-admin');
              }}><Plus size={15}/> Invite admin</button>
            </div>
            {adminInvites.filter(inv=>inv.status!=='REVOKED').length>0&&
              <div className='cp-admin-invites-list'>
                {adminInvites.filter(inv=>inv.status!=='REVOKED').map(inv=>
                  <div key={inv.id} className='cp-admin-invite-row'>
                    <span><strong>{inv.email}</strong>
                      <small>{inv.status==='ACCEPTED'?'Active administrator':'Expires '+dateFmt(inv.expiresAt)}</small></span>
                    <Pill color={inv.status==='ACCEPTED'?'green':'amber'}>{inv.status}</Pill>
                    <button type='button' className='cp-mini-btn danger' onClick={()=>safeRun('revoke-admin',async()=>{
                      if(!window.confirm('Revoke administrator access for '+inv.email+'?'))return;
                      await api.post('/api/admin/invite/revoke',{email:inv.email});
                      await refreshAdministration();showMessage('Administrator invitation revoked.');
                    })}>Revoke</button>
                  </div>)}
              </div>}
            <p className='cp-admin-invite-hint'>Invitees sign in using their exact email.
              Share the ClassPulse link with them.</p>
          </section>
          <section className='cp-panel cp-admin-import-banner'>
            <div><strong>Academic data imports</strong><small>CSV validation · Audited changes</small></div>
            <div className='cp-inline-actions'>
              <button className='cp-mini-btn' onClick={()=>{
                setImportKind('rooms');setImportRows([]);setImportReport(null);setModal('admin-import');
              }}><Plus size={15}/> Import CSV</button>
              <button className='cp-mini-btn' onClick={()=>setModal('admin-rooms')}>
                <BookOpen size={15}/> Rooms ({adminRooms.length})</button>
            </div>
          </section>
          <div className='cp-admin-summary-rail'>
            <div><span>Accounts</span><strong>{summary?.accounts ?? '—'}</strong></div>
            <div><span>Faculty requests</span><strong>{operations?.pendingRoles ?? '—'}</strong></div>
            <div><span>Course sections</span><strong>{summary?.courseSections ?? '—'}</strong></div>
            <div><span>Aggregate attendance</span><strong>{summary?.totalRecords ?? '—'}</strong></div>
          </div>
          <div className='cp-two-column cp-admin-management'>
            <section className='cp-panel'>
              <SectionTitle eyebrow='ACCOUNT DIRECTORY' title='Manage roles and requests'/>
              <div className='cp-admin-filter-bar'>
                <label><Search size={16}/><input aria-label='Filter users by name, email, or role'
                  value={accountQuery} onChange={e=>setAccountQuery(e.target.value)} placeholder='Filter accounts'/></label>
                <div className='cp-admin-filter-tabs'>
                  {([
                    ['pending','Pending'],['all','All'],['Faculty','Faculty'],['Student','Students']
                  ] as const).map(([key,label])=><button key={key} onClick={()=>setAccountView(key)}
                    className={accountView===key?'selected':''}>{label}</button>)}
                </div>
              </div>
              <div className='cp-admin-users'>
                {filteredUsers.slice(0,70).map(u=><div key={u.userId} className='cp-admin-user'>
                  <span className='cp-user-avatar'>{u.name?.[0]||'?'}</span>
                  <div><strong>{u.name}</strong><small>{u.email} · {u.role}</small>
                    {u.roleRequest && <Pill color='amber'>Requested {u.roleRequest}</Pill>}
                  </div>
                  {u.role==='Student' && u.roleRequest==='Faculty' && <button className='cp-mini-btn'
                    disabled={!!busy} onClick={()=>safeRun('approve',async()=>{
                      await api.post('/api/admin/role',{userId:u.userId,role:'Faculty'});
                      await refreshAdministration();showMessage('Faculty access approved.');
                    })}>Approve</button>}
                  {u.role==='Faculty' && <button className='cp-mini-btn'
                    disabled={!!busy} onClick={()=>safeRun('revoke',async()=>{
                      if(!window.confirm('Change this Faculty account back to Student?'))return;
                      await api.post('/api/admin/role',{userId:u.userId,role:'Student'});
                      await refreshAdministration();showMessage('Account role changed to Student.');
                    })}>Set Student</button>}
                </div>)}
                {!filteredUsers.length && <Empty title='Nothing in this view' detail='Try All accounts or change your search.' icon={Users}/>}
              </div>
              {filteredUsers.length>70 && <p className='cp-chart-note'>Showing the first 70 matching accounts. Refine your search to narrow the list.</p>}
            </section>
            <section className='cp-admin-side-stack'>
              <section className='cp-panel'>
                <SectionTitle eyebrow='INSTITUTION REPORTS' title='Attendance totals'/>
                {summary && <div className='cp-aggregate-list'>{Object.entries(summary.aggregate).map(([name,count])=><div key={name}><span>{name}</span><strong>{count}</strong></div>)}</div>}
                <button className='cp-button dark' onClick={()=>summary && csvExport('classpulse-campus-summary.csv',
                  Object.entries(summary.aggregate).map(([Status,Total])=>({Status,Total})))}>
                  <Download size={16}/> Export campus summary</button>
                <div className='cp-privacy-note'><ShieldCheck size={17}/> Only aggregate totals—no individual student attendance.</div>
              </section>
              <section className='cp-panel'>
                <SectionTitle eyebrow='REFERENCE COMPLETENESS' title='Data quality checks'/>
                <div className='cp-admin-mini-metrics'>
                  <div><span>Profiles to complete</span><b>{operations?.incompleteProfiles ?? '—'}</b></div>
                  <div><span>Sections without rooms</span><b>{operations?.sectionsWithoutRoom ?? '—'}</b></div>
                  <div><span>Enrollment records</span><b>{operations?.enrolledStudents ?? '—'}</b></div>
                  <div><span>Availability updates</span><b>{operations?.publishedAvailability ?? '—'}</b></div>
                </div>
                <button className='cp-mini-btn' onClick={()=>navigate('Classes')}>Maintain section records <ArrowUpRight size={14}/></button>
              </section>
            </section>
          </div>
          <section className='cp-panel cp-admin-audit'>
            <SectionTitle eyebrow='ACCOUNTABILITY' title='Administrative audit trail'
              subtitle='Role approvals, reference changes and administrative access actions.'/>
            {adminEvents.length ? adminEvents.slice(0,35).map(e=><div className='cp-admin-audit-row' key={e.id}>
              <LockKeyhole size={15}/><span>{e.actionType.replace(/_/g,' ')}</span><time>{dateFmt(e.timestamp)}</time></div>) :
              <Empty title='No administrative actions yet' detail='Access and changes are recorded here.'/>}
          </section>
        </>}

        {page === 'Profile' && <>
          <SectionTitle eyebrow='YOUR IDENTITY' title='My profile'
            subtitle='Your personal and academic information.'/>
          <div className='cp-profile-layout'>
            <section className='cp-id-studio' aria-label='My digital academic profile card'>
              <div className='cp-id-intro'>
                <div><span className='cp-id-overline'>CLASS PULSE / ACADEMIC IDENTITY</span>
                  <h2>My campus card</h2>
</div>
                <span className='cp-id-kind'><ShieldCheck size={15}/> In-app profile</span>
              </div>
              <div className={'cp-id-stage '+(isFaculty?'role-faculty':isAdmin?'role-admin':'role-student')}>
                <div className={'cp-id-card'+(idCardBack?' is-reversed':'')}
                  role='button' tabIndex={0} aria-pressed={idCardBack}
                  aria-label={idCardBack?'Flip campus profile card to front':'Flip campus profile card to details'}
                  onClick={()=>setIdCardBack(v=>!v)}
                  onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setIdCardBack(v=>!v);}}}>
                  <div className='cp-id-side cp-id-front' aria-hidden={idCardBack}>
                    <div className='cp-id-glow' aria-hidden='true'/>
                    <div className='cp-id-head'>
                      <div className='cp-id-brand'><LogoMark large/>
                        <div><strong>ClassPulse</strong><small>Mindanao State University · Main Campus</small></div>
                      </div>
                      <div className='cp-id-card-type'><span>ACADEMIC</span><strong>PROFILE</strong></div>
                    </div>
                    <div className='cp-id-front-main'>
                      <div className='cp-id-portrait'>
                        {profilePhotoUrl
                          ? <img src={profilePhotoUrl} alt='Your ClassPulse profile portrait'/>
                          : <span aria-label='Profile photo not yet uploaded'>{profileInitial}</span>}
                      </div>
                      <div className='cp-id-personal'>
                        <span className='cp-id-small-key'>CARD HOLDER</span>
                        <h3>{profile?.name||'Add your name'}</h3>
                        <span className='cp-id-role-tag'><span className='cp-id-role-dot'/>{role}</span>
                        <div className='cp-id-personal-code'>
                          <span>ACADEMIC IDENTIFIER</span>
                          <strong>{profile?.studentNumber||'Not yet provided'}</strong>
                        </div>
                      </div>
                    </div>
                    <div className='cp-id-bottom'>
                      <div><span>DEPARTMENT / COLLEGE</span>
                        <strong>{profile?.department||'Not yet provided'}</strong></div>
                      <span className='cp-id-pulse' aria-hidden='true'>
                        <svg viewBox='0 0 94 29'><path d='M1 15 H20 L28 15 L36 6 L44 24 L53 3 L61 15 H93'
                          stroke='currentColor' strokeWidth='2.7' strokeLinejoin='round' fill='none'/></svg>
                      </span>
                    </div>
                    <div className='cp-id-legal'>CLASS PULSE WORKSPACE PROFILE · NOT AN OFFICIAL UNIVERSITY ID</div>
                  </div>
                  <div className='cp-id-side cp-id-back' aria-hidden={!idCardBack}>
                    <div className='cp-id-back-head'>
                      <div className='cp-id-brand'><LogoMark large/>
                        <div><strong>ClassPulse</strong><small>Campus profile details</small></div></div>
                      <ShieldCheck size={25}/>
                    </div>
                    <span className='cp-id-back-eyebrow'>ACADEMIC IDENTITY / DETAILS</span>
                    <div className='cp-id-back-grid'>
                      <div><span>ACCOUNT ROLE</span><strong>{role}</strong></div>
                      <div><span>{isFaculty?'OFFICE / CONSULTATION ROOM':isStudent?'YEAR LEVEL':'WORKSPACE ACCESS'}</span>
                        <strong>{isFaculty?profile?.officeRoom||'Not set':isStudent?profile?.yearLevel||'Not set':'System Administration'}</strong></div>
                      <div className='cp-id-back-wide'><span>VERIFIED SIGN-IN EMAIL</span>
                        <strong>{profile?.email||'Email unavailable'}</strong></div>
                      <div className='cp-id-back-wide'><span>DEPARTMENT / COLLEGE</span>
                        <strong>{profile?.department||'Not set'}</strong></div>
                    </div>
                    <div className='cp-id-back-footer'>
                      <ShieldCheck size={16}/>
                      <span>Not an official campus ID</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className='cp-id-controls'>
                <div role='group' aria-label='Digital ID card side' className='cp-id-switch'>
                  <button type='button' aria-pressed={!idCardBack} className={!idCardBack?'active':''}
                    onClick={()=>setIdCardBack(false)}>Card front</button>
                  <button type='button' aria-pressed={idCardBack} className={idCardBack?'active':''}
                    onClick={()=>setIdCardBack(true)}>Card details</button>
                </div>
              </div>
              <div className='cp-id-actions'>
                <label className='cp-id-photo-change'><Plus size={16}/> Change profile photo
                  <input type='file' accept='image/jpeg,image/png,image/webp'
                    onChange={e=>setPhotoFile(e.target.files?.[0]||null)}/></label>
                <button type='button' className='cp-id-copy' disabled={!profile?.studentNumber}
                  onClick={()=>safeRun('copy-academic-id',async()=>{
                    await navigator.clipboard.writeText(profile?.studentNumber||'');
                    showMessage('Academic identifier copied.');
                  })}><FileText size={16}/> Copy campus ID</button>
              </div>
              {photoFile&&<div className='cp-id-photo-pending' role='status'>
                <span>{photoFile.name}</span><button className='cp-button dark' disabled={!!busy}
                  onClick={()=>safeRun('photo',uploadPhoto)}>Save new photo <Check size={15}/></button>
              </div>}
              <div className='cp-id-completion'>
                <div><span>PROFILE READINESS</span><strong>{cardReadiness} of 5 details</strong></div>
                <div role='progressbar' aria-label='Academic profile completeness'
                  aria-valuenow={cardReadiness} aria-valuemin={0} aria-valuemax={5}>
                  <i style={{width:(cardReadiness/5*100)+'%'}}/>
                </div>
                <p>Complete missing fields using the form beside your card.</p>
              </div>
            </section>
            <div className='cp-profile-editor'>
              <section className='cp-panel'>
                <SectionTitle eyebrow='PERSONAL DETAILS' title='Edit your information'
                  subtitle='Your verified email is managed through the sign-in provider.'/>
                <div className='cp-form-grid'>
                  <Field label='Full name' name='name' form={form} update={update} required/>
                  <Field label='Student / employee ID' name='studentNumber' form={form} update={update}/>
                </div>
                <label className='cp-field'><span>Department / College</span>
                  <input value={form.department || ''} maxLength={90} onChange={e => update('department', e.target.value)}
                    placeholder='e.g. College of Information and Computing Sciences'/></label>
                {isStudent && <label className='cp-field'><span>Year level</span>
                  <select value={form.yearLevel || ''} onChange={e=>update('yearLevel',e.target.value)}>
                    <option value=''>Select year level</option>
                    {['1st Year','2nd Year','3rd Year','4th Year','5th Year','Graduate'].map(x=><option key={x}>{x}</option>)}
                  </select></label>}
                {isFaculty && <label className='cp-field'><span>Faculty office / consultation room</span>
                  <input maxLength={70} value={form.officeRoom || ''} onChange={e=>update('officeRoom',e.target.value)}
                    placeholder='e.g. CICS Faculty Office'/></label>}
                <label className='cp-field'><span>Contact number (optional)</span>
                  <input type='tel' inputMode='tel' maxLength={24} value={form.contactPhone || ''}
                    onChange={e=>update('contactPhone',e.target.value)} placeholder='09XX XXX XXXX'/></label>
                <label className='cp-field'><span>About me</span>
                  <textarea value={form.bio || ''} maxLength={180} onChange={e => update('bio', e.target.value)}
                    placeholder='Your course, interests, or academic focus (optional)'/></label>
                <div className='cp-profile-save'>
                  <span>Changes are saved to your private academic profile.</span>
                  <button className='cp-button dark' disabled={!!busy} onClick={()=>safeRun('profile',async()=>{
                    await api.put('/api/profile', { name:form.name, studentNumber:form.studentNumber,
                      department:form.department, bio:form.bio, contactPhone:form.contactPhone,
                      yearLevel:form.yearLevel, officeRoom:form.officeRoom });
                    await bootstrap();showMessage('Your ClassPulse profile was updated.');
                  })}>Save changes <Check size={16}/></button>
                </div>
              </section>
            </div>
          </div>
        </>}

        {page === 'Settings' && <>
          <SectionTitle eyebrow='PREFERENCES' title='Settings' subtitle='Display, reminders and account preferences.'/>
          <section className='cp-panel cp-preferences-only'>
                <SectionTitle eyebrow='YOUR EXPERIENCE' title='Display & notifications'/>
                <div className='cp-settings-list'>
                  <div className='cp-density-setting'>
                    <span><Settings size={18}/> Text size</span>
                    <div role='group' aria-label='Interface text size'>
                      {(['compact','comfortable','spacious'] as const).map(item=>
                        <button type='button' aria-pressed={density===item} key={item}
                          className={density===item?'selected':''} onClick={()=>setDensity(item)}>
                          {item === 'compact' ? 'Standard' : item === 'comfortable' ? 'Large' : 'Extra large'}
                        </button>)}
                    </div>
                  </div>
                  <div className='cp-theme-setting'>
                    <span><Sun size={18}/> Appearance</span>
                    <div className='cp-theme-switch' role='group' aria-label='Color theme'>
                      <button type='button' className={theme==='light'?'active':''}
                        aria-pressed={theme==='light'} onClick={()=>setTheme('light')}>
                        <Sun size={16}/> Light</button>
                      <button type='button' className={theme==='dark'?'active':''}
                        aria-pressed={theme==='dark'} onClick={()=>setTheme('dark')}>
                        <Moon size={16}/> Dark</button>
                    </div>
                  </div>
                  {!isAdmin && <button onClick={()=>{
                    if(exportWeeklyCalendar(sections,isFaculty?'faculty':'student'))
                      showMessage('Class timetable exported. Import it into an Android calendar or ClassPulse native alarm companion.');
                    else showMessage('Add an active subject before exporting reminders.');
                  }}>
                    <span><CalendarDays size={18}/> Class reminders · Android</span>
                    <strong>Export schedule <ArrowUpRight size={14}/></strong>
                  </button>}
                  {!isAdmin && <p className='cp-settings-helper'>Calendar export includes a 15-minute alert. For reliable Android system alarms, import the .ics into the separate native companion app. Web notifications depend on browser/device support.</p>}
                  <button onClick={()=>safeRun('notify',async()=>{await notifications.subscribe();showMessage('Notification setup requested.');})}>
                    <span><Bell size={18}/> Academic notifications</span><strong>Enable <ArrowUpRight size={14}/></strong>
                  </button>

                  {!isAdmin&&<button type='button' className='cp-delete-account-link'
                    onClick={()=>{setDeleteConfirm('');setModal('delete-account');}}>
                    <span><ShieldCheck size={18}/> Delete account</span><strong>Manage <ArrowUpRight size={14}/></strong>
                  </button>}
                  {isAdmin&&<p className='cp-settings-helper'>Administrator account deletion
                    requires transferring administrator access.</p>}
                </div>
              </section>
        </>}
      </main>
      <footer className='cp-footer'>CLASSPULSE / MSU MAIN CAMPUS <span>Designed for students and faculty. Protected by role-based access.</span></footer>
    </div>
    <nav className='cp-mobile-dock' aria-label='Quick navigation'>{pages[role].slice(0, 5).map(({ page: item, icon: Icon, label }) => <button type='button' aria-label={label} title={label} key={item} className={page === item ? 'active' : ''} onClick={() => navigate(item)}><Icon size={18}/><span>{label}</span></button>)}</nav>

    {modal && <div className='cp-modal-backdrop' onClick={() => { closeScanner(); }}><section className='cp-modal' onClick={(e) => e.stopPropagation()}><div className='cp-modal-head'><div><span>CLASSPULSE / ACTION</span><h2>{{
      join:'Join an enrolled section', 'create-section':'Create a class section', 'edit-section':'Edit approved class',
      'faculty-create':'Add a subject', 'faculty-edit':'Customize subject', 'faculty-roster':'My student roster',
      'admin-import':'CSV Import', 'admin-rooms':'Campus Rooms',
      'invite-admin':'Invite administrator', 'delete-account':'Delete account',
      status:'Publish class update',
      scan:'Scan attendance QR', qr:'Live class QR session', roster:'Class attendance roster', review:'Correct attendance',
      excuse:'Submit a digital excuse', 'excuse-decision':'Faculty excuse decision',
      slot:'Publish consultation dates', booking:'Request a consultation', 'booking-decision':'Confirm or reject booking',
    }[modal] || 'ClassPulse'}</h2></div><button className='cp-icon-button' onClick={closeScanner}><X size={18}/></button></div>
    <div className='cp-modal-body'>
      {modal==='invite-admin'&&isAdmin&&<>
        <label className='cp-field'><span>Administrator email</span>
          <input type='email' inputMode='email' autoComplete='email'
            placeholder='verified@example.edu'
            value={form.inviteEmail||''}
            onChange={ev=>update('inviteEmail',ev.target.value)}/></label>
        <p className='cp-modal-help'>The invitation is valid for seven days.
          Only this verified email can accept it. Share ClassPulse's sign-in link.</p>
        <button type='button' className='cp-button dark full'
          disabled={!!busy||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.inviteEmail||'')}
          onClick={()=>safeRun('invite-admin',async()=>{
            await api.post('/api/admin/invite',{email:(form.inviteEmail||'').trim()});
            setModal('');await refreshAdministration();
            showMessage('Invitation saved. Share the ClassPulse sign-in URL with the invited email.');
          })}>Create invitation <ArrowRight size={16}/></button>
      </>}
      {modal==='delete-account'&&!isAdmin&&<>
        <div className='cp-account-delete-info'>
          <ShieldCheck size={23}/>
          <div><strong>Delete your ClassPulse profile?</strong>
            <p>Your profile will be disabled and personal fields cleared.
              Attendance, enrollment and audit history may be retained by the institution.
              This does not delete your Google or Apple account.</p></div>
        </div>
        <label className='cp-field'><span>Type DELETE to confirm</span>
          <input autoComplete='off' value={deleteConfirm}
            onChange={ev=>setDeleteConfirm(ev.target.value)}
            placeholder='DELETE' aria-label='Type DELETE to delete ClassPulse account'/></label>
        <button type='button' className='cp-button dark full cp-confirm-delete'
          disabled={!!busy||deleteConfirm!=='DELETE'}
          onClick={()=>safeRun('delete-account',async()=>{
            await api.post('/api/account/delete',{confirmation:deleteConfirm});
            setModal('');await signOut();
          })}>Delete ClassPulse account</button>
      </>}
      {modal === 'join' && <><Field label='Class join code' name='joinCode' form={form} update={update} placeholder='Enter faculty-issued code'/><p className='cp-modal-help'>Ask your faculty for the current subject join code.</p><button className='cp-button dark full' onClick={() => safeRun('join', async () => { await action('/api/sections/join', { joinCode: form.joinCode }, 'Classes'); setModal(''); showMessage('You have joined this class.'); })}>Join class <ArrowRight size={16}/></button></>}

      {modal === 'admin-import' && isAdmin && <div className='cp-import-panel'>
        <p className='cp-modal-help'>Preview first. Existing records are never overwritten. Maximum 15 records per import.</p>
        <label className='cp-field'><span>Import type</span>
          <select value={importKind} onChange={e=>{
            setImportKind(e.target.value as ImportKind);setImportRows([]);setImportReport(null);
          }}>
            <option value='rooms'>Rooms</option><option value='sections'>Sections</option>
            <option value='enrollments'>Enrollments</option>
          </select></label>
        <button className='cp-mini-btn' onClick={()=>downloadImportTemplate(importKind)}><Download size={16}/> Download CSV template</button>
        <label className='cp-field'><span>Choose CSV</span>
          <input type='file' key={importKind} accept='.csv,text/csv' onChange={e=>{
            const file=e.target.files?.[0];if(!file)return;
            void safeRun('preview-import',async()=>{
              setImportReport(null);
              const rows=parseCsvImport(await file.text(),importKind);
              const result=await api.post('/api/admin/import/preview',{kind:importKind,rows});
              setImportRows(rows);setImportRequestId(crypto.randomUUID());
              setImportReport(result.data as ImportReport);
            });
          }}/></label>
        {importReport&&<div className='cp-import-result' role='status'>
          <strong>{importReport.valid} valid / {importReport.total} rows</strong>
          {importReport.issues.length?importReport.issues.map((issue,i)=>
            <p key={i}>Row {issue.row}: {issue.reason}</p>):<p>Ready to commit, subject to a final server validation.</p>}
        </div>}
        {importReport?.example&&<div className='cp-import-rows'>
          {importReport.example.map((item,i)=><p key={i}>{i+2} · {Object.values(item).join(' · ')}</p>)}
        </div>}
        <button className='cp-button dark full' disabled={!importReport||!!importReport.issues.length||!!busy}
          onClick={()=>safeRun('commit-import',async()=>{
            if(!importReport||!window.confirm('Import '+importReport.valid+' verified records?'))return;
            const response=await api.post('/api/admin/import/commit',{
              kind:importKind,rows:importRows,fingerprint:importReport.fingerprint,requestId:importRequestId,
            });
            setModal('');setImportReport(null);setImportRows([]);
            await refreshAdministration();showMessage((response.data as {imported:number}).imported+' records imported.');
          })}><Check size={16}/> Commit {importReport?.valid||0} records</button>
      </div>}
      {modal === 'admin-rooms' && isAdmin && <div className='cp-room-directory'>
        {!adminRooms.length&&<Empty title='No rooms added' detail='Use CSV import to add rooms.'/>}
        {adminRooms.map(room=><div key={room.id} className='cp-room-row'>
          <div><strong>{room.code}</strong><small>{room.building} · {room.capacity} seats</small></div>
          <select value={room.status} disabled={!!busy} aria-label={'Status of '+room.code}
            onChange={e=>{const status=e.target.value;void safeRun('room-update',async()=>{
              await api.post('/api/admin/rooms/'+room.id+'/status',{status});
              await refreshAdministration();showMessage('Room status saved.');
            });}}>
            <option value='AVAILABLE'>Available</option><option value='MAINTENANCE'>Maintenance</option><option value='INACTIVE'>Inactive</option>
          </select>
        </div>)}
        <button className='cp-mini-btn' onClick={()=>{
          setImportKind('rooms');setImportReport(null);setModal('admin-import');
        }}><Plus size={15}/> Import rooms</button>
      </div>}

      {modal === 'create-section' && <><div className='cp-form-grid'><Field label='Course code' name='courseCode' form={form} update={update}/><Field label='Section' name='section' form={form} update={update}/></div><Field label='Course title' name='title' form={form} update={update}/><Field label='Assigned faculty' name='facultyId' form={form} update={update}><option value=''>Select a verified faculty account</option>{users.filter((u) => u.role === 'Faculty').map((u) => <option key={u.userId} value={u.userId}>{u.name} · {u.email}</option>)}</Field><div className='cp-form-grid'><Field label='Day' name='day' form={form} update={update}>
            {!campusDayOptions.some(o=>o.value===form.day)&&form.day&&<option value={form.day}>{form.day} · Existing schedule</option>}
            {campusDayOptions.map(o=><option value={o.value} key={o.value}>{o.label}</option>)}</Field><Field label='Room' name='room' form={form} update={update}/><Field label='Start time' name='startTime' form={form} update={update} type='time'/><Field label='End time' name='endTime' form={form} update={update} type='time'/></div><button className='cp-button dark full' onClick={() => safeRun('create-section', async () => { await action('/api/admin/section', { ...form }, 'Classes'); setModal(''); showMessage('Class created. Copy the join code from the directory.'); })}>Create class section</button></>}

      {modal === 'faculty-create' && isFaculty && <>
        <p className='cp-modal-help'>A join code is generated when you create the subject. This is a ClassPulse workspace record, not an official COR change.</p>
        <div className='cp-form-grid'>
          <Field label='Subject code *' name='courseCode' form={form} update={update} placeholder='e.g. IT 103'/>
          <Field label='Section *' name='section' form={form} update={update} placeholder='e.g. BSIT 3A'/>
        </div>
        <Field label='Subject title *' name='title' form={form} update={update} placeholder='e.g. Database Management'/>
        <Field label='Semester / term *' name='term' form={form} update={update}/>
        <div className='cp-form-grid'>
          <Field label='Class day *' name='day' form={form} update={update}>
            {!campusDayOptions.some(o=>o.value===form.day)&&form.day&&<option value={form.day}>{form.day} · Existing schedule</option>}
            {campusDayOptions.map(o=><option value={o.value} key={o.value}>{o.label}</option>)}
          </Field>
          <Field label='Classroom *' name='room' form={form} update={update} placeholder='e.g. CICS Lab 2'/>
          <Field label='Start time *' name='startTime' form={form} update={update} type='time'/>
          <Field label='End time *' name='endTime' form={form} update={update} type='time'/>
        </div>
        <button className='cp-button dark full' disabled={!!busy} onClick={()=>safeRun('new-subject',async()=>{
          const response=await api.post('/api/faculty/sections',{
            courseCode:form.courseCode,title:form.title,section:form.section,term:form.term,
            day:form.day,startTime:form.startTime,endTime:form.endTime,room:form.room
          });
          await refreshPage('Classes');setModal('');
          showMessage('Subject created. Join code: '+((response.data as {subject:Section}).subject.joinCode||'View your class'));
        })}><Plus size={16}/> Create my subject</button>
      </>}
      {modal === 'faculty-edit' && isFaculty && <>
        <p className='cp-modal-help'>Update your subject details. Enrolled students are notified of schedule changes.</p>
        <div className='cp-form-grid'>
          <Field label='Subject code *' name='courseCode' form={form} update={update}/>
          <Field label='Section *' name='section' form={form} update={update}/>
        </div>
        <Field label='Subject title *' name='title' form={form} update={update}/>
        <Field label='Semester / term *' name='term' form={form} update={update}/>
        <div className='cp-form-grid'>
          <Field label='Class day *' name='day' form={form} update={update}>
            {!campusDayOptions.some(o=>o.value===form.day)&&form.day&&<option value={form.day}>{form.day} · Existing schedule</option>}
            {campusDayOptions.map(o=><option value={o.value} key={o.value}>{o.label}</option>)}
          </Field>
          <Field label='Classroom *' name='room' form={form} update={update}/>
          <Field label='Start time *' name='startTime' form={form} update={update} type='time'/>
          <Field label='End time *' name='endTime' form={form} update={update} type='time'/>
        </div>
        <button className='cp-button dark full' disabled={!!busy} onClick={()=>safeRun('save-subject',async()=>{
          await api.post('/api/faculty/sections/'+selectedSubjectId+'/update',{
            courseCode:form.courseCode,title:form.title,section:form.section,term:form.term,
            day:form.day,startTime:form.startTime,endTime:form.endTime,room:form.room
          });
          setModal('');await refreshPage('Classes');showMessage('Subject updated and enrolled students notified.');
        })}><Check size={16}/> Save subject changes</button>
      </>}
      {modal === 'faculty-roster' && isFaculty && <>
        {facultyRosterLoading && <div className='cp-faculty-roster-loading'><span className='cp-spinner'/> Loading student records…</div>}
        {facultyRoster && <>
          <div className='cp-roster-overview'>
            <div><small>SUBJECT</small><strong>{facultyRoster.section.courseCode} · {facultyRoster.section.section}</strong></div>
            <div><small>ENROLLED STUDENTS</small><strong>{facultyRoster.students.length}</strong></div>
            <div><small>QR CLASS SESSIONS</small><strong>{facultyRoster.meetings.length}</strong></div>
            <div><small>RECORDED ATTENDANCE</small><strong>{facultyRoster.records.length}</strong></div>
          </div>
          <div className='cp-roster-followup'>
            <strong>Class attendance follow-up</strong>
            <span>{facultyRoster.students.filter(s=>s.counts.ABSENT>=2 || s.counts.LATE>=4).length} students with multiple absences/lates · advisory only</span>
            <small>Discuss individual records; never assign automatic dismissal or final grades.</small>
          </div>
          <div className='cp-roster-tools'>
            <label><Search size={15}/><input aria-label='Search your student roster'
              placeholder='Search name or student ID' value={rosterSearch}
              onChange={e=>setRosterSearch(e.target.value)}/></label>
            <button className='cp-mini-btn' onClick={()=>csvExport('ClassPulse-'+facultyRoster.section.courseCode+'-roster.csv',
              facultyRoster.students.map(s=>({Name:s.name,StudentID:s.studentNumber,Present:s.counts.PRESENT,
                Late:s.counts.LATE,Absent:s.counts.ABSENT,Excused:s.counts.EXCUSED,
                PendingReview:s.pendingReview})))}><Download size={14}/> Export roster</button>
            <button className='cp-mini-btn' onClick={()=>csvExport('ClassPulse-'+facultyRoster.section.courseCode+'-attendance.csv',
              facultyRoster.records.map(r=>({Student:facultyRoster.students.find(s=>s.studentId===r.studentId)?.name||'Student',
              AcademicStatus:r.academicStatus,Verification:r.verificationStatus,CapturedAt:r.capturedAt||'',ReceivedAt:r.receivedAt||''})))}>
              <Download size={14}/> Export attendance</button>
          </div>
          {facultyRoster.students.filter(s=>[s.name,s.studentNumber].join(' ').toLowerCase().includes(rosterSearch.toLowerCase())).map(s=>{
            const open=expandedStudent===s.studentId;
            const total=s.counts.PRESENT+s.counts.LATE+s.counts.ABSENT;
            const ratio=total ? Math.round((s.counts.PRESENT+s.counts.LATE)/total*100)+'%' : '—';
            return <article className='cp-roster-person' key={s.studentId}>
              <button type='button' className='cp-roster-person-main' aria-expanded={open}
                onClick={()=>setExpandedStudent(open?null:s.studentId)}>
                {s.photo?<img src={s.photo} alt='Student profile photo'/>:<span className='cp-roster-person-avatar'><Users size={18}/></span>}
                <span className='cp-roster-person-name'><strong>{s.name}</strong><small>{s.studentNumber||'No student ID added'}</small></span>
                <span className='cp-roster-person-rate'><strong>{ratio}</strong><small>Attendance</small></span>
                {s.pendingReview>0&&<Pill color='amber'>{s.pendingReview} review</Pill>}
                <ChevronRight size={17} className={open?'rotated':''}/>
              </button>
              {open && <div className='cp-roster-person-details'>
                <div className='cp-roster-counts'>
                  {Object.entries(s.counts).map(([status,n])=><span key={status}><b>{n}</b><small>{status}</small></span>)}
                </div>
                <div className='cp-roster-history'><strong>Recent attendance</strong>
                  {facultyRoster.records.filter(r=>r.studentId===s.studentId).slice(-8).reverse().map(r=>
                    <div key={r.id}><span>{r.capturedAt?dateFmt(r.capturedAt):dateFmt(r.receivedAt)}</span>
                      <Pill color={colorFor(r.academicStatus)}>{r.academicStatus}</Pill>
                      <small>{r.verificationStatus}</small></div>)}
                  {!facultyRoster.records.some(r=>r.studentId===s.studentId)&&<p>No QR attendance recorded yet.</p>}
                </div>
              </div>}
            </article>;
          })}
          {!facultyRoster.students.length && <Empty title='No students enrolled' detail='Share the subject join code with enrolled students. Their records will appear here.' icon={Users}/>}
        </>}
      </>}

      {modal === 'edit-section' && isAdmin && <>
        <p className='cp-modal-help'>Update approved timetable reference data. Editing is blocked while a QR session is active.</p>
        <Field label='Assigned faculty' name='facultyId' form={form} update={update}>
          <option value=''>Select approved faculty</option>
          {users.filter(u=>u.role==='Faculty').map(u=><option key={u.userId} value={u.userId}>{u.name} · {u.email}</option>)}
        </Field>
        <div className='cp-form-grid'>
          <Field label='Day' name='day' form={form} update={update}>
            {!campusDayOptions.some(o=>o.value===form.day)&&form.day&&<option value={form.day}>{form.day} · Existing schedule</option>}
            {campusDayOptions.map(o=><option value={o.value} key={o.value}>{o.label}</option>)}
          </Field>
          <Field label='Room' name='room' form={form} update={update}/>
          <Field label='Start time' name='startTime' form={form} update={update} type='time'/>
          <Field label='End time' name='endTime' form={form} update={update} type='time'/>
        </div>
        <button className='cp-button dark full' disabled={!!busy} onClick={()=>safeRun('save-section',async()=>{
          await api.post('/api/admin/section/'+form.sectionId+'/update',{
            facultyId:form.facultyId,day:form.day,startTime:form.startTime,endTime:form.endTime,room:form.room
          });
          setModal('');await refreshAdministration();showMessage('Class reference updated and enrolled students notified.');
        })}>Save approved class details <Check size={16}/></button>
      </>}
      {modal === 'status' && <><Field label='Class status' name='status' form={form} update={update}>{['ATTENDING','DELAYED','CANCELLED','RESCHEDULED','ROOM CHANGED'].map((value) => <option key={value}>{value}</option>)}</Field><Field label='Room' name='room' form={form} update={update}/><label className='cp-field'><span>Update message</span><textarea value={form.message || ''} onChange={(e) => update('message', e.target.value)} placeholder='Write a clear update for your enrolled students…'/></label><button className='cp-button dark full' onClick={() => safeRun('status', async () => { await action('/api/sections/status', { ...form }, 'Classes'); setModal(''); showMessage('Class update published to enrolled students.'); })}>Publish status update</button></>}
      {modal === 'scan' && <>
        <div className='cp-auto-scan'>
          <div className='cp-camera-window cp-camera-auto'>
            {camera ? <video ref={videoRef} autoPlay muted playsInline aria-label='Live QR scanning camera'/> : <ScanLine size={65} strokeWidth={1.5}/>}
            {camera && <div className='cp-scan-target' aria-hidden='true'><i/><i/><i/><i/></div>}
          </div>
          <div className='cp-camera-status cp-camera-status-outside' role='status'><span className='cp-live-dot'/>
            {scanStatus==='opening'?'Opening camera…':scanStatus==='submitting'?'Recording attendance…':
              scanStatus==='error'?'Camera unavailable':'Scan the live classroom QR'}
          </div>
          {scanError && <div role='status' className='cp-camera-feedback'>{scanError}</div>}
          {scanStatus === 'error' && <button className='cp-button dark full'
            onClick={() => { setScanError(''); setScanStatus('opening'); setCamera(true); }}><RefreshCcw size={16}/> Retry camera</button>}
          <div className='cp-auto-scan-help'><ShieldCheck size={20}/><p><strong>No typing or submission required.</strong>
            The camera recognizes the signed QR and records attendance automatically. Offline scans are saved for later server verification and faculty review.</p></div>
        </div>
      </>}
      {modal === 'qr' && currentSession && <><div className='cp-qr-paper'>{qrToken ? <QRCodeSVG value={qrToken} size={244} level='M'/> : <div className='cp-spinner'/>}</div><div className='cp-qr-timer'><span className='cp-live-dot'/> Signed QR rotates every 15 seconds · refresh in {15 - (Math.floor(tick % 15))}s</div><p className='cp-modal-help'>Only scanned, enrolled students can create attendance records. No QR session exists unless faculty explicitly opens one.</p><div className='cp-inline-actions'><button className='cp-mini-btn' onClick={() => safeRun('roster', async () => rosterModal(currentSession))}>Open roster</button><button className='cp-mini-btn danger' onClick={() => safeRun('close', async () => { await api.post('/api/sessions/' + currentSession.id + '/close', {}); setModal(''); await refreshDashboard(); showMessage('Attendance session closed.'); })}>Close session</button></div></>}
      {modal === 'roster' && currentSession && <><div className='cp-roster'>{roster.map((student) => <div key={student.studentId} className='cp-roster-row'>{student.photo ? <img src={student.photo} alt='Verified profile reference'/> : <span className='cp-student-placeholder'><Users size={18}/></span>}<div><strong>{student.name}</strong><small>{student.studentNumber || student.studentId.slice(0,8)}</small></div><Pill color={colorFor(student.attendance?.academicStatus || '')}>{student.attendance?.academicStatus || 'NO SCAN'}</Pill>{student.attendance && <button className='cp-mini-btn' onClick={() => { update('studentId', student.studentId); update('sessionId', currentSession.id); update('status', student.attendance?.academicStatus || 'ABSENT'); setModal('review'); }}>Review</button>}</div>)}</div><button className='cp-mini-btn' onClick={() => safeRun('finalize', async () => { const r = await api.post('/api/sessions/' + currentSession.id + '/finalize', {}); showMessage((r.data as { ready: boolean }).ready ? 'Eligible missing attendance records finalized.' : 'The 12-hour post-class window has not elapsed.'); await rosterModal(currentSession); })}>Finalize absence after 12-hour window</button></>}
      {modal === 'review' && <>
        <p className='cp-modal-help'>Corrections change the academic status, not the original QR scan evidence. A reason is required and saved in the audit trail.</p>
        <Field label='Corrected academic status' name='status' form={form} update={update}>
          {['PRESENT','LATE','ABSENT','EXCUSED'].map((s)=><option key={s}>{s}</option>)}
        </Field>
        <label className='cp-field'><span>Reason for correction (required, at least 6 characters)</span>
          <textarea value={form.reason||''} onChange={e=>update('reason',e.target.value)}
            placeholder='Explain the evidence and reason for the correction'/></label>
        <button className='cp-button dark full' disabled={!!busy||form.reason.trim().length<6}
          onClick={()=>safeRun('review',async()=>{
            await api.post('/api/attendance/review',{
              sessionId:form.sessionId,studentId:form.studentId,status:form.status,reason:form.reason,
            });
            setModal('');
            if(selectedSubjectId)await loadFacultyRoster(selectedSubjectId,false);
            await refreshPage('Attendance');
            showMessage('Correction saved with a complete audit entry.');
          })}><FileCheck2 size={17}/> Save audited correction</button>
      </>}
      {modal==='excuse'&&<>
        <label className='cp-field cp-excuse-class-select'><span>Subject</span>
          <select value={form.sectionId||''} onChange={ev=>{
            setForm(previous=>({...previous,sectionId:ev.target.value,absenceDate:''}));
          }}>
            <option value=''>Choose subject</option>
            {sections.filter(section=>!section.archivedAt).map(section=>
              <option key={section.id} value={section.id}>
                {section.courseCode} · {section.title}
              </option>)}
          </select>
        </label>
        <ExcuseDateChooser section={selectedExcuseSubject} month={excuseMonth}
          onMonth={setExcuseMonth} selected={form.absenceDate||''}
          onSelect={date=>update('absenceDate',date)}/>
        <label className='cp-field'><span>Excuse letter</span>
          <textarea rows={4} value={form.reason||''}
            onChange={ev=>update('reason',ev.target.value)}
            placeholder='Explain your absence…'/></label>
        <label className='cp-field'><span>Attachment (optional)</span>
          <input type='file' accept='.pdf,image/png,image/jpeg'
            onChange={ev=>setFile(ev.target.files?.[0]||null)}/></label>
        <button type='button' className='cp-button dark full'
          disabled={!!busy||!selectedExcuseSubject||!form.absenceDate||
            !matchesClassDay(selectedExcuseSubject.day,form.absenceDate)||
            (form.reason||'').trim().length<8}
          onClick={()=>safeRun('excuse',submitExcuse)}>
          Submit excuse <ArrowRight size={16}/>
        </button>
      </>}
      {modal === 'excuse-decision' && <><Field label='Decision reason' name='reason' form={form} update={update} placeholder='Explain the faculty decision'/><div className='cp-inline-actions'><button className='cp-button dark' onClick={() => safeRun('approve', async () => { await action('/api/excuses/' + form.excuseId + '/decision', { status: 'APPROVED', reason: form.reason }, 'Excuses'); setModal(''); })}><Check size={16}/> Approve</button><button className='cp-mini-btn danger' onClick={() => safeRun('reject', async () => { await action('/api/excuses/' + form.excuseId + '/decision', { status: 'REJECTED', reason: form.reason }, 'Excuses'); setModal(''); })}>Reject</button></div></>}

      {modal === 'slot' && isFaculty && <>
        <div className='cp-calendar-modal'>
          <div className='cp-calendar-heading'>
            <div><strong>{calendarGrid(consultationMonth).title}</strong><span>Select up to 14 dates</span></div>
            <div className='cp-calendar-nav'>
              <button type='button' aria-label='Previous month' disabled={consultationMonth <= dateOnly().slice(0,7)}
                onClick={() => setConsultationMonth(m => monthByStep(m,-1))}>
                <ChevronRight size={18} style={{transform:'rotate(180deg)'}}/>
              </button>
              <button type='button' aria-label='Next month'
                disabled={consultationMonth >= monthByStep(dateOnly().slice(0,7),5)}
                onClick={() => setConsultationMonth(m => monthByStep(m,1))}><ChevronRight size={18}/></button>
            </div>
          </div>
          <label className='cp-field cp-consultation-subject'><span>Offering subject *</span>
            <select value={form.consultationSubjectId||''} onChange={e=>update('consultationSubjectId',e.target.value)}>
              <option value=''>Select your teaching subject</option>
              {sections.filter(s=>!s.archivedAt).map(s=><option key={s.id} value={s.id}>{s.courseCode} · {s.title} · {s.section}</option>)}
            </select>
          </label>
          <div className='cp-calendar-grid' role='group' aria-label='Consultation dates'>
            {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>
              <span className='cp-calendar-weekday' key={d}>{d}</span>)}
            {calendarGrid(consultationMonth).days.map((date,i) => {
              if (!date) return <span className='cp-calendar-empty' key={'blank-'+i}/>;
              const selected=consultationDates.includes(date);
              const unavailable=date<dateOnly() || date>monthByStep(dateOnly().slice(0,7),6)+'-01';
              const already=slots.some(s=>s.facultyId===authUser.userId
                && phDateOf(s.startAt)===date);
              return <button key={date} type='button' aria-pressed={selected} aria-label={date+(selected?' selected':'')}
                className={'cp-calendar-day'+(selected?' selected':'')+(date===dateOnly()?' today':'')}
                disabled={unavailable || (!selected && consultationDates.length>=14)}
                onClick={()=>toggleConsultationDate(date)}>
                <span>{Number(date.slice(-2))}</span>
                {selected ? <Check size={12}/> : already ? <i/> : null}
              </button>;
            })}
          </div>
          <div className='cp-calendar-selected'>
            <strong>{consultationDates.length} date{consultationDates.length===1?'':'s'} selected</strong>
            {consultationDates.length>0 && <button onClick={()=>setConsultationDates([])}>Clear</button>}
          </div>
          {consultationDates.length>0 && <div className='cp-calendar-date-chips'>{consultationDates.map(d=>
            <button type='button' key={d} aria-label={'Remove '+d} onClick={()=>toggleConsultationDate(d)}>
              {new Date(d+'T12:00:00+08:00').toLocaleDateString('en-PH',{month:'short',day:'numeric',timeZone:'Asia/Manila'})} <X size={12}/>
            </button>)}</div>}
          <div className='cp-calendar-time-fields'>
            <Field label='From' name='slotStartTime' form={form} update={update} type='time'/>
            <Field label='Until' name='slotEndTime' form={form} update={update} type='time'/>
            <Field label='Seats' name='capacity' form={form} update={update} type='number'/>
          </div>
          <div className='cp-calendar-help'><ShieldCheck size={17}/>
            Times use Philippine Standard Time. Overlapping classes or consultations are blocked.</div>
          <button className='cp-button dark full' disabled={!!busy || !consultationDates.length || !form.consultationSubjectId}
            onClick={()=>safeRun('publish-calendar', async()=>{
              const response=await api.post('/api/slots/batch',{
                dates:consultationDates,startTime:form.slotStartTime,endTime:form.slotEndTime,
                capacity:Number(form.capacity),sectionId:form.consultationSubjectId,
              });
              setConsultationDates([]);setModal('');
              await refreshPage('Consultations');
              showMessage((response.data as {created:number}).created+' consultation slot(s) published.');
            })}><CalendarClock size={17}/> Publish {consultationDates.length||''} slot{consultationDates.length===1?'':'s'}</button>
        </div>
      </>}

      {modal === 'booking' && <><Field label='Consultation topic' name='topic' form={form} update={update} placeholder='What will you discuss?'/><p className='cp-modal-help'>A submitted request remains PENDING until the faculty member confirms or rejects it.</p><button className='cp-button dark full' disabled={!!busy||!form.slotId||form.topic.trim().length<5}
          onClick={() => safeRun('booking', async () => { await action('/api/bookings', { slotId: form.slotId, topic: form.topic.trim() }, 'Consultations'); setModal(''); })}>
            Request consultation <ArrowRight size={16}/></button></>}
      {modal === 'booking-decision' && <><Field label='Decision note (optional)' name='reason' form={form} update={update}/><div className='cp-inline-actions'><button className='cp-button dark' onClick={() => safeRun('confirm', async () => { await action('/api/bookings/' + form.bookingId + '/decision', { status: 'CONFIRMED', reason: form.reason }, 'Consultations'); setModal(''); })}>Confirm booking</button><button className='cp-mini-btn danger' onClick={() => safeRun('reject-booking', async () => { await action('/api/bookings/' + form.bookingId + '/decision', { status: 'REJECTED', reason: form.reason }, 'Consultations'); setModal(''); })}>Reject</button></div></>}
      {busy && <div className='cp-modal-progress'><span className='cp-spinner small'/> Processing your request…</div>}
    </div></section></div>}
    {message && <div className='cp-toast'><span><Activity size={16}/></span>{message}<button onClick={() => setMessage('')}><X size={15}/></button></div>}
  </div>;
}
