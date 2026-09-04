create or replace function public.ember_process_webhook_events(p_limit integer default 25)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  v_location_id text;
  v_person_id bigint;
  v_service_date date;
  v_occurred_at timestamptz;
  v_activity_inserted integer;
  v_processed integer := 0;
  v_failed integer := 0;
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception using errcode='22023', message='p_limit must be between 1 and 100';
  end if;

  for r in
    select w.*
    from ember.webhook_event w
    where w.status in ('received','failed')
      and w.attempts < 5
    order by w.received_at
    limit p_limit
    for update skip locked
  loop
    begin
      update ember.webhook_event
      set status='processing', attempts=attempts+1,
          processing_started_at=now(), error=null
      where id=r.id;

      select om.location_id into v_location_id
      from ember.office_map om
      where om.fieldroutes_office_id=r.fieldroutes_office_id
        and om.enabled;

      if v_location_id is null then
        raise exception 'unknown or disabled FieldRoutes office %', r.fieldroutes_office_id;
      end if;

      if coalesce(r.payload->>'serviceDate', r.payload->>'service_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'serviceDate is missing or invalid';
      end if;
      v_service_date := coalesce(r.payload->>'serviceDate', r.payload->>'service_date')::date;

      begin
        v_occurred_at := coalesce(
          nullif(coalesce(
            r.payload->>'eventTimestamp',
            r.payload->>'event_timestamp',
            r.payload->>'timestamp',
            r.payload->>'updatedAt'
          ), '')::timestamptz,
          r.received_at
        );
      exception when others then
        v_occurred_at := r.received_at;
      end;

      insert into ember.person (
        location_id, fieldroutes_office_id, fieldroutes_customer_id,
        first_name, last_name, company_name, is_commercial,
        email, phone, phone_alt, address_line1, city, state, postal_code,
        next_appointment_date, updated_at
      ) values (
        v_location_id, r.fieldroutes_office_id, r.customer_id,
        nullif(trim(coalesce(r.payload->>'fname', r.payload->>'firstName', '')), ''),
        nullif(trim(coalesce(r.payload->>'lname', r.payload->>'lastName', '')), ''),
        nullif(trim(coalesce(r.payload->>'companyName', '')), ''),
        nullif(trim(coalesce(r.payload->>'companyName', '')), '') is not null,
        nullif(trim(coalesce(r.payload->>'email', '')), ''),
        nullif(regexp_replace(coalesce(r.payload->>'phone1', r.payload->>'phone', ''), '[^0-9+]', '', 'g'), ''),
        nullif(regexp_replace(coalesce(r.payload->>'phone2', ''), '[^0-9+]', '', 'g'), ''),
        nullif(trim(coalesce(r.payload->>'address', r.payload->>'address1', '')), ''),
        nullif(trim(coalesce(r.payload->>'city', '')), ''),
        nullif(trim(coalesce(r.payload->>'state', '')), ''),
        nullif(trim(coalesce(r.payload->>'zip', r.payload->>'postalCode', '')), ''),
        case when r.event_type in ('appointment_scheduled','appointment_rescheduled')
             then v_service_date else null end,
        now()
      )
      on conflict (location_id, fieldroutes_office_id, fieldroutes_customer_id)
      do update set
        first_name=coalesce(excluded.first_name, ember.person.first_name),
        last_name=coalesce(excluded.last_name, ember.person.last_name),
        company_name=coalesce(excluded.company_name, ember.person.company_name),
        is_commercial=case when excluded.company_name is not null then true else ember.person.is_commercial end,
        email=coalesce(excluded.email, ember.person.email),
        phone=coalesce(excluded.phone, ember.person.phone),
        phone_alt=coalesce(excluded.phone_alt, ember.person.phone_alt),
        address_line1=coalesce(excluded.address_line1, ember.person.address_line1),
        city=coalesce(excluded.city, ember.person.city),
        state=coalesce(excluded.state, ember.person.state),
        postal_code=coalesce(excluded.postal_code, ember.person.postal_code),
        next_appointment_date=case
          when r.event_type in ('appointment_scheduled','appointment_rescheduled') then v_service_date
          when r.event_type='appointment_cancelled' then null
          else ember.person.next_appointment_date
        end,
        updated_at=now()
      returning id into v_person_id;

      insert into ember.activity_event (
        webhook_event_id, location_id, person_id, event_type,
        fieldroutes_office_id, customer_id, appointment_id, subscription_id,
        service_type_id, service_description, service_date,
        service_start_time, service_end_time, service_address,
        city, state, postal_code, occurred_at
      ) values (
        r.id, v_location_id, v_person_id, r.event_type,
        r.fieldroutes_office_id, r.customer_id, r.appointment_id, r.subscription_id,
        nullif(trim(coalesce(r.payload->>'serviceType', r.payload->>'serviceTypeID', '')), ''),
        nullif(trim(coalesce(r.payload->>'serviceDescription', r.payload->>'description', '')), ''),
        v_service_date,
        nullif(trim(coalesce(r.payload->>'serviceStartTime', '')), ''),
        nullif(trim(coalesce(r.payload->>'serviceEndTime', '')), ''),
        nullif(trim(coalesce(r.payload->>'address', r.payload->>'address1', '')), ''),
        nullif(trim(coalesce(r.payload->>'city', '')), ''),
        nullif(trim(coalesce(r.payload->>'state', '')), ''),
        nullif(trim(coalesce(r.payload->>'zip', r.payload->>'postalCode', '')), ''),
        v_occurred_at
      )
      on conflict do nothing;
      get diagnostics v_activity_inserted = row_count;

      if r.event_type='service_completed' and v_activity_inserted=1 then
        update ember.person
        set service_count=service_count+1,
            last_service_date=case
              when last_service_date is null then v_service_date
              else greatest(last_service_date, v_service_date)
            end,
            last_service_type_id=coalesce(
              nullif(trim(coalesce(r.payload->>'serviceType', r.payload->>'serviceTypeID', '')), ''),
              last_service_type_id
            ),
            last_service_description=coalesce(
              nullif(trim(coalesce(r.payload->>'serviceDescription', r.payload->>'description', '')), ''),
              last_service_description
            ),
            reference_date=case
              when reference_date is null then v_service_date
              else greatest(reference_date, v_service_date)
            end,
            next_appointment_date=case
              when next_appointment_date is not null and next_appointment_date <= v_service_date then null
              else next_appointment_date
            end,
            updated_at=now()
        where id=v_person_id;
      end if;

      update ember.webhook_event
      set status='processed', processed_at=now(), error=null
      where id=r.id;
      v_processed := v_processed+1;
    exception when others then
      update ember.webhook_event
      set status='failed', error=left(sqlerrm,1000), processed_at=now()
      where id=r.id;
      v_failed := v_failed+1;
    end;
  end loop;

  return jsonb_build_object('ok',true,'processed',v_processed,'failed',v_failed);
end;
$$;

revoke all on function public.ember_process_webhook_events(integer)
  from public, anon, authenticated;
grant execute on function public.ember_process_webhook_events(integer)
  to service_role;

comment on function public.ember_process_webhook_events(integer) is
'Service-role-only idempotent processor for stored Ember FieldRoutes webhooks. Does not build queues or enable sending.';;
