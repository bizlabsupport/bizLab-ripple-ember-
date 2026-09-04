create or replace function ember.enroll_location(
  p_location_id text,
  p_display_name text,
  p_fieldroutes_office_id text,
  p_timezone text default 'America/New_York',
  p_ghl_location_id text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_location_id text := upper(trim(p_location_id));
  v_display_name text := trim(p_display_name);
  v_office_id text := trim(p_fieldroutes_office_id);
  v_timezone text := trim(p_timezone);
  v_ghl_location_id text := nullif(trim(p_ghl_location_id), '');
begin
  if v_location_id !~ '^[A-Z0-9][A-Z0-9_-]{2,63}$' then
    raise exception using errcode = '22023', message = 'Ember location ID must be 3-64 characters using letters, numbers, hyphens, or underscores.';
  end if;
  if length(v_display_name) < 2 or length(v_display_name) > 120 then
    raise exception using errcode = '22023', message = 'Display name must be between 2 and 120 characters.';
  end if;
  if v_office_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception using errcode = '22023', message = 'FieldRoutes office ID is invalid.';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    raise exception using errcode = '22023', message = 'Timezone is not a recognized IANA timezone.';
  end if;
  if exists (select 1 from ember.location where location_id = v_location_id) then
    raise exception using errcode = '23505', message = 'That Ember location ID is already enrolled.';
  end if;
  if exists (select 1 from ember.office_map where fieldroutes_office_id = v_office_id) then
    raise exception using errcode = '23505', message = 'That FieldRoutes office ID is already assigned to another Ember location.';
  end if;
  if v_ghl_location_id is not null and exists (
    select 1 from ember.location where ghl_location_id = v_ghl_location_id
  ) then
    raise exception using errcode = '23505', message = 'That HighLevel location is already enrolled in Ember.';
  end if;

  insert into ember.location (
    location_id, display_name, ghl_location_id, timezone,
    onboarding_status, metadata
  ) values (
    v_location_id, v_display_name, v_ghl_location_id, v_timezone,
    'testing', jsonb_build_object('product', 'ember', 'enrollment_source', 'super_admin')
  );

  insert into ember.settings (
    location_id, enabled, backfill_completed_at
  ) values (
    v_location_id, false, null
  );

  insert into ember.office_map (
    fieldroutes_office_id, location_id, office_name, enabled
  ) values (
    v_office_id, v_location_id, v_display_name, true
  );

  insert into ember.field_map (location_id) values (v_location_id);

  return jsonb_build_object(
    'location_id', v_location_id,
    'display_name', v_display_name,
    'fieldroutes_office_id', v_office_id,
    'timezone', v_timezone,
    'onboarding_status', 'testing',
    'enabled', false,
    'backfill_completed', false
  );
end;
$$;

revoke all on function ember.enroll_location(text,text,text,text,text) from public, anon, authenticated;
grant execute on function ember.enroll_location(text,text,text,text,text) to service_role;

comment on function ember.enroll_location(text,text,text,text,text) is
'Atomically enrolls an Ember tenant, disabled and in testing. Callable only by service_role through the authenticated super-admin Edge Function.';;
