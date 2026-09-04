
create or replace function public.ember_get_backfill_config(p_location_id text)
returns jsonb
language sql
security invoker
set search_path=''
as $function$
  select jsonb_build_object(
    'location_id',l.location_id,
    'fieldroutes_office_id',om.fieldroutes_office_id,
    'enabled',om.enabled,
    'customer_id_field',fm.customer_id_field,
    'office_id_field',fm.office_id_field,
    'status_field',fm.status_field,
    'commercial_account_field',fm.commercial_account_field,
    'subscriptions_field',fm.subscriptions_field,
    'field_ids',coalesce(fm.field_ids,'{}'::jsonb)
  )
  from ember.location l
  join ember.office_map om on om.location_id=l.location_id and om.enabled is true
  left join ember.field_map fm on fm.location_id=l.location_id
  where l.location_id=p_location_id
  limit 1
$function$;

revoke all on function public.ember_get_backfill_config(text) from public,anon,authenticated;
grant execute on function public.ember_get_backfill_config(text) to service_role;
;
