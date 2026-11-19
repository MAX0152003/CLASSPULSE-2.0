-- ClassPulse 2.0: independent PostgreSQL foundation.
-- Existing cp_records is intentionally preserved; no production data is deleted.
create table if not exists public.cp_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null default 'Student' check (role in ('Student','Faculty','System Administrator')),
  student_number text,
  photo_path text,
  created_at timestamptz not null default now()
);
create table if not exists public.cp_sections (
  id uuid primary key default gen_random_uuid(),
  course_code text not null,
  title text not null,
  section_name text not null,
  faculty_id uuid references public.cp_profiles(user_id),
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  room text,
  term text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.cp_enrollments (
  section_id uuid not null references public.cp_sections(id) on delete cascade,
  student_id uuid not null references public.cp_profiles(user_id) on delete cascade,
  enrollment_status text not null default 'ACTIVE' check (enrollment_status in ('ACTIVE','DROPPED','WITHDRAWN')),
  dropped_at timestamptz,
  primary key(section_id,student_id)
);
create table if not exists public.cp_meetings (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.cp_sections(id) on delete cascade,
  opened_by uuid not null references public.cp_profiles(user_id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  token_digest text,
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED','CANCELLED')),
  created_at timestamptz not null default now()
);
create table if not exists public.cp_attendance (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.cp_meetings(id) on delete cascade,
  student_id uuid not null references public.cp_profiles(user_id),
  status text not null check (status in ('PRESENT','LATE','ABSENT','EXCUSED')),
  verification_status text not null default 'PENDING',
  captured_at timestamptz,
  received_at timestamptz not null default now(),
  unique(meeting_id,student_id)
);
create table if not exists public.cp_attendance_audit (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references public.cp_attendance(id),
  changed_by uuid not null references public.cp_profiles(user_id),
  old_status text,
  new_status text not null,
  reason text not null,
  changed_at timestamptz not null default now()
);
alter table public.cp_profiles enable row level security;
alter table public.cp_sections enable row level security;
alter table public.cp_enrollments enable row level security;
alter table public.cp_meetings enable row level security;
alter table public.cp_attendance enable row level security;
alter table public.cp_attendance_audit enable row level security;
-- No permissive client writes until role-checked policies and API are implemented.
create policy "profile owner read" on public.cp_profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "student enrollment read" on public.cp_enrollments for select to authenticated using ((select auth.uid()) = student_id);
create policy "student attendance read" on public.cp_attendance for select to authenticated using ((select auth.uid()) = student_id);
