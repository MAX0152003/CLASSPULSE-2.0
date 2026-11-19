-- ClassPulse 2.0 — apply in Supabase SQL Editor before connecting Vercel.
-- Stores existing ClassPulse record shapes in JSONB while preserving atomic
-- multi-record updates required for attendance reviews and consultation booking.
-- The service role is server-only; no client can directly read academic data.

create table if not exists public.cp_records (
  table_name text not null check(length(table_name) between 1 and 100),
  id text not null check(length(id) between 1 and 200),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(table_name,id)
);
create index if not exists cp_records_recent on public.cp_records(table_name,updated_at desc);
alter table public.cp_records enable row level security;
revoke all on public.cp_records from anon,authenticated;
grant select,insert,update,delete on public.cp_records to service_role;

create or replace function public.cp_apply_batch(operations jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  op jsonb;
  item jsonb;
  row_data jsonb;
  old_data jsonb;
  condition jsonb;
  table_id text;
  record_id text;
  op_mode text;
  patch_mode boolean;
  op_results jsonb;
  all_results jsonb := '[]'::jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the authenticated server may update ClassPulse records'
      using errcode='42501';
  end if;
  if operations is null or jsonb_typeof(operations)<>'array'
     or jsonb_array_length(operations)>80 then
    raise exception 'Invalid transaction batch' using errcode='22023';
  end if;
  for op in select value from jsonb_array_elements(operations) loop
    table_id := op->>'table';
    op_mode := op->>'kind';
    patch_mode := coalesce((op->>'patch')::boolean,true);
    if table_id is null or length(table_id)>100
       or op_mode not in ('add','update','delete') then
       raise exception 'Unsupported ClassPulse operation' using errcode='22023';
    end if;
    op_results := '[]'::jsonb;
    for item in select value from jsonb_array_elements(op->'items') loop
      record_id := item->>'id';
      if record_id is null or length(record_id)>200 or length(record_id)=0 then
        raise exception 'Invalid record identifier' using errcode='22023';
      end if;
      -- All operations take one per-record advisory lock first.
      -- Batch operations are atomic because the entire function is one SQL transaction.
      perform pg_advisory_xact_lock(hashtextextended(table_id||'|'||record_id,0));
      if op_mode='add' then
        row_data := coalesce(item->'record','{}'::jsonb)
                    ||jsonb_build_object('id',record_id);
        insert into public.cp_records(table_name,id,data)
          values(table_id,record_id,row_data)
          on conflict do nothing;
        if not found then
          raise exception 'Duplicate ClassPulse record' using errcode='23505';
        end if;
        op_results:=op_results||jsonb_build_array(record_id);
      elsif op_mode='update' then
        condition:=coalesce(item->'if','{}'::jsonb);
        select data into old_data from public.cp_records
          where table_name=table_id and id=record_id for update;
        if not found or not (old_data @> condition) then
          raise exception 'ClassPulse record changed while being reviewed'
            using errcode='40001';
        end if;
        row_data:=coalesce(item->'record','{}'::jsonb);
        if patch_mode then
          row_data:=old_data||row_data;
        end if;
        row_data:=row_data||jsonb_build_object('id',record_id);
        update public.cp_records
          set data=row_data,updated_at=now()
          where table_name=table_id and id=record_id;
        op_results:=op_results||' [true]'::jsonb;
      else
        delete from public.cp_records where table_name=table_id and id=record_id;
        if not found then
          raise exception 'ClassPulse record not found' using errcode='40001';
        end if;
        op_results:=op_results||'[true]'::jsonb;
      end if;
    end loop;
    all_results:=all_results||jsonb_build_array(op_results);
  end loop;
  return all_results;
end;
$$;
revoke all on function public.cp_apply_batch(jsonb) from public,anon,authenticated;
grant execute on function public.cp_apply_batch(jsonb) to service_role;

-- Private supporting documents: profile photos and excuse attachments.
insert into storage.buckets(id,name,public,file_size_limit)
  values('classpulse-files','classpulse-files',false,3300000)
  on conflict(id) do update set public=false,file_size_limit=3300000;

-- storage.objects RLS: no public policies. Supabase service role signs URLs.
-- Do not grant anonymous upload/download access to student materials.
