do $migration$
declare
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef('public.ember_process_webhook_events(integer)'::regprocedure)
    into v_definition;

  v_updated := replace(
    v_definition,
    E'            reference_date=case\n              when reference_date is null then v_service_date\n              else greatest(reference_date, v_service_date)\n            end,\n            next_appointment_date=case',
    E'            next_appointment_date=case'
  );

  if v_updated = v_definition then
    raise exception 'Expected reference_date assignment was not found';
  end if;

  execute v_updated;
end
$migration$;;
