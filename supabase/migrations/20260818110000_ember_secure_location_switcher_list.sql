
create or replace function public.ember_list_locations_for_user(p_user_id uuid)
returns jsonb
language sql
security invoker
set search_path=''
as $function$
with platform as (
  select role
  from ember.platform_user
  where user_id=p_user_id and is_active is true
  limit 1
),
allowed as (
  select
    l.location_id,
    l.display_name,
    l.timezone,
    l.onboarding_status,
    coalesce((select role from platform),lu.role) as role,
    exists(select 1 from platform) as platform_access
  from ember.location l
  left join ember.location_user lu
    on lu.location_id=l.location_id
   and lu.user_id=p_user_id
   and lu.is_active is true
  where exists(select 1 from platform) or lu.user_id is not null
)
select jsonb_build_object(
  'ok',true,
  'platform',exists(select 1 from platform),
  'locations',coalesce(jsonb_agg(
    jsonb_build_object(
      'location_id',location_id,
      'display_name',display_name,
      'timezone',timezone,
      'onboarding_status',onboarding_status,
      'role',role,
      'platform_access',platform_access
    ) order by display_name,location_id
  ),'[]'::jsonb)
)
from allowed
$function$;

revoke all on function public.ember_list_locations_for_user(uuid) from public,anon,authenticated;
grant execute on function public.ember_list_locations_for_user(uuid) to service_role;
;
