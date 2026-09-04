create or replace function public.ember_store_webhook_event(
  p_event_type text,
  p_fieldroutes_office_id text,
  p_customer_id text,
  p_appointment_id text,
  p_subscription_id text,
  p_external_id text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_location_id text;
  v_enabled boolean;
  v_id bigint;
  v_status text;
  v_received_at timestamptz;
begin
  select om.location_id, om.enabled
    into v_location_id, v_enabled
  from ember.office_map om
  where om.fieldroutes_office_id = p_fieldroutes_office_id;

  if v_location_id is null or not coalesce(v_enabled, false) then
    return jsonb_build_object(
      'ok', false,
      'error', 'unknown_or_disabled_office',
      'officeID', p_fieldroutes_office_id
    );
  end if;

  insert into ember.webhook_event (
    source, event_type, fieldroutes_office_id, customer_id,
    appointment_id, subscription_id, external_id, payload, status
  ) values (
    'fieldroutes', p_event_type, p_fieldroutes_office_id, p_customer_id,
    p_appointment_id, nullif(p_subscription_id, ''), p_external_id, p_payload, 'received'
  )
  on conflict (external_id) do nothing
  returning id, status, received_at into v_id, v_status, v_received_at;

  if v_id is null then
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'event_type', p_event_type,
      'location_id', v_location_id
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'accepted', true,
    'event_id', v_id,
    'event_type', p_event_type,
    'location_id', v_location_id,
    'status', v_status,
    'received_at', v_received_at
  );
end;
$$;

revoke all on function public.ember_store_webhook_event(text,text,text,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.ember_store_webhook_event(text,text,text,text,text,text,jsonb)
  to service_role;

comment on function public.ember_store_webhook_event(text,text,text,text,text,text,jsonb) is
'Service-role-only atomic FieldRoutes event store for the Ember webhook receiver.';;
