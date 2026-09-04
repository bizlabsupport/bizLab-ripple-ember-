create or replace function public.ember_admin_list_locations()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'location_id', l.location_id,
        'display_name', l.display_name,
        'ghl_location_id', l.ghl_location_id,
        'timezone', l.timezone,
        'onboarding_status', l.onboarding_status,
        'opted_in_at', l.opted_in_at,
        'created_at', l.created_at,
        'enabled', coalesce(s.enabled, false),
        'backfill_completed_at', s.backfill_completed_at,
        'offices', coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'fieldroutes_office_id', om.fieldroutes_office_id,
                'office_name', om.office_name,
                'enabled', om.enabled
              )
              order by om.fieldroutes_office_id
            )
            from ember.office_map om
            where om.location_id = l.location_id
          ),
          '[]'::jsonb
        )
      )
      order by l.display_name
    ),
    '[]'::jsonb
  )
  from ember.location l
  left join ember.settings s on s.location_id = l.location_id;
$$;

revoke all on function public.ember_admin_list_locations() from public, anon, authenticated;
grant execute on function public.ember_admin_list_locations() to service_role;

comment on function public.ember_admin_list_locations() is
'Service-role-only Ember location summary for the verified BizLab super-admin console.';;
