create table if not exists public.ripple_appointment_sync_events (
 id bigint generated always as identity primary key,
 location_id text references public.config(location_id),
 office_id text,
 appointment_id text,
 event_type text not null,
 status text not null check (status in ('processed','rejected','error','duplicate')),
 reason text,
 job_id bigint references public.jobs(id),
 event_time timestamptz,
 received_at timestamptz not null default now()
);
create index if not exists ripple_appointment_sync_events_location_time_idx on public.ripple_appointment_sync_events(location_id, received_at desc);
alter table public.ripple_appointment_sync_events enable row level security;
revoke all on public.ripple_appointment_sync_events from anon, authenticated;
create unique index if not exists ripple_fieldroutes_office_config_unique on public.config (fieldroutes_office_id) where fieldroutes_office_id is not null and fieldroutes_office_id <> '';
