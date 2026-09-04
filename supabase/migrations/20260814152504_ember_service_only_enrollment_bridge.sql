create or replace function public.ember_enroll_location(
  p_location_id text,
  p_display_name text,
  p_fieldroutes_office_id text,
  p_timezone text default 'America/New_York',
  p_ghl_location_id text default null
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select ember.enroll_location(
    p_location_id,
    p_display_name,
    p_fieldroutes_office_id,
    p_timezone,
    p_ghl_location_id
  );
$$;

revoke all on function public.ember_enroll_location(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.ember_enroll_location(text,text,text,text,text) to service_role;

comment on function public.ember_enroll_location(text,text,text,text,text) is
'Service-role-only API bridge to the atomic Ember enrollment routine. Browser callers must pass the admin-operations super-admin gate.';;
