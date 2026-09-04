
do $fix$
declare
  v_ddl text;
begin
  select pg_get_functiondef(p.oid) into v_ddl
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='ember_import_backfill_batch'
    and pg_get_function_identity_arguments(p.oid)='p_location_id text, p_fieldroutes_office_id text, p_batch_id text, p_expected_count integer, p_records jsonb, p_finalize boolean';

  v_ddl := replace(
    v_ddl,
    'was_subscriber,next_appointment_date,reference_date,shelf,shelf_computed_at,ltv,updated_at',
    'was_subscriber,next_appointment_date,shelf,shelf_computed_at,ltv,updated_at'
  );
  v_ddl := replace(
    v_ddl,
    E'        nullif(r->>\'nextAppointmentDate\',\'\')::date,\n        v_reference_date,\n        case',
    E'        nullif(r->>\'nextAppointmentDate\',\'\')::date,\n        case'
  );
  v_ddl := replace(
    v_ddl,
    E'        reference_date=coalesce(excluded.reference_date,ember.person.reference_date),\n',
    ''
  );

  execute v_ddl;
end
$fix$;

revoke all on function public.ember_import_backfill_batch(text,text,text,integer,jsonb,boolean)
from public,anon,authenticated;
grant execute on function public.ember_import_backfill_batch(text,text,text,integer,jsonb,boolean)
to service_role;
;
