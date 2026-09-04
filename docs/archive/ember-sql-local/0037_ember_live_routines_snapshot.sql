-- Snapshot of Ember routines deployed after the foundation migration.
-- Generated from the live Ember project on 2026-08-27. Review before applying.
-- These routines depend on the base Ember tables documented in the implementation runbook.

-- ember.enroll_location(p_location_id text, p_display_name text, p_fieldroutes_office_id text, p_timezone text, p_ghl_location_id text)
CREATE OR REPLACE FUNCTION ember.enroll_location(p_location_id text, p_display_name text, p_fieldroutes_office_id text, p_timezone text DEFAULT 'America/New_York'::text, p_ghl_location_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$

-- public.ember_admin_list_locations()
CREATE OR REPLACE FUNCTION public.ember_admin_list_locations()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
$function$

-- public.ember_enroll_location(p_location_id text, p_display_name text, p_fieldroutes_office_id text, p_timezone text, p_ghl_location_id text)
CREATE OR REPLACE FUNCTION public.ember_enroll_location(p_location_id text, p_display_name text, p_fieldroutes_office_id text, p_timezone text DEFAULT 'America/New_York'::text, p_ghl_location_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select ember.enroll_location(
    p_location_id,
    p_display_name,
    p_fieldroutes_office_id,
    p_timezone,
    p_ghl_location_id
  );
$function$

-- public.ember_get_backfill_config(p_location_id text)
CREATE OR REPLACE FUNCTION public.ember_get_backfill_config(p_location_id text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
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
$function$

-- public.ember_import_backfill_batch(p_location_id text, p_fieldroutes_office_id text, p_batch_id text, p_expected_count integer, p_records jsonb, p_finalize boolean)
CREATE OR REPLACE FUNCTION public.ember_import_backfill_batch(p_location_id text, p_fieldroutes_office_id text, p_batch_id text, p_expected_count integer, p_records jsonb, p_finalize boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  r jsonb;
  v_customer_id text;
  v_hash text;
  v_imported integer;
  v_rejected integer;
  v_received integer;
  v_expected integer;
  v_errors jsonb;
  v_reference_date date;
begin
  if p_location_id is null or btrim(p_location_id)='' then
    raise exception using errcode='22023', message='location_id is required';
  end if;
  if p_batch_id is null or btrim(p_batch_id)='' or length(p_batch_id)>120 then
    raise exception using errcode='22023', message='batch_id is required and must be 120 characters or fewer';
  end if;
  if p_expected_count is not null and p_expected_count < 1 then
    raise exception using errcode='22023', message='expected_count must be positive';
  end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) > 500 then
    raise exception using errcode='22023', message='records must be an array of at most 500 items';
  end if;
  if not exists (
    select 1 from ember.office_map
    where location_id=p_location_id
      and fieldroutes_office_id=p_fieldroutes_office_id
      and enabled is true
  ) then
    raise exception using errcode='22023', message='office is not mapped to this Ember location';
  end if;

  insert into ember.backfill_batch(
    location_id,batch_id,fieldroutes_office_id,expected_count,status,updated_at
  ) values (
    p_location_id,p_batch_id,p_fieldroutes_office_id,p_expected_count,'receiving',now()
  )
  on conflict (location_id,batch_id) do update set
    expected_count=coalesce(ember.backfill_batch.expected_count,excluded.expected_count),
    updated_at=now();

  if exists (
    select 1 from ember.backfill_batch
    where location_id=p_location_id and batch_id=p_batch_id
      and fieldroutes_office_id<>p_fieldroutes_office_id
  ) then
    raise exception using errcode='22023', message='batch office does not match';
  end if;
  if p_expected_count is not null and exists (
    select 1 from ember.backfill_batch
    where location_id=p_location_id and batch_id=p_batch_id
      and expected_count is not null and expected_count<>p_expected_count
  ) then
    raise exception using errcode='22023', message='batch expected_count does not match';
  end if;

  for r in select value from jsonb_array_elements(p_records)
  loop
    v_customer_id := nullif(btrim(coalesce(r->>'customerId','')), '');
    v_hash := nullif(btrim(coalesce(r->>'recordHash','')), '');
    begin
      if v_customer_id is null then
        raise exception 'customerId is required';
      end if;

      v_reference_date := coalesce(
        nullif(r->>'referenceDate','')::date,
        nullif(r->>'lastServiceDate','')::date,
        nullif(r->>'cancellationDate','')::date
      );

      insert into ember.person(
        location_id,fieldroutes_office_id,fieldroutes_customer_id,
        first_name,last_name,company_name,is_commercial,email,phone,phone_alt,
        address_line1,city,state,postal_code,
        last_service_date,last_service_type_id,last_service_description,service_count,
        customer_since,subscription_status,cancellation_date,cancellation_reason,
        was_subscriber,next_appointment_date,shelf,shelf_computed_at,ltv,updated_at
      ) values (
        p_location_id,p_fieldroutes_office_id,v_customer_id,
        nullif(btrim(r->>'firstName'),''),
        nullif(btrim(r->>'lastName'),''),
        nullif(btrim(r->>'companyName'),''),
        coalesce((r->>'isCommercial')::boolean,false),
        nullif(btrim(r->>'email'),''),
        nullif(regexp_replace(coalesce(r->>'phone',''),'[^0-9+]','','g'),''),
        nullif(regexp_replace(coalesce(r->>'phoneAlt',''),'[^0-9+]','','g'),''),
        nullif(btrim(r->>'address1'),''),
        nullif(btrim(r->>'city'),''),
        nullif(btrim(r->>'state'),''),
        nullif(btrim(r->>'postalCode'),''),
        nullif(r->>'lastServiceDate','')::date,
        nullif(btrim(r->>'lastServiceTypeId'),''),
        nullif(btrim(r->>'lastServiceDescription'),''),
        greatest(coalesce((r->>'serviceCount')::integer,0),0),
        nullif(r->>'customerSince','')::date,
        nullif(btrim(r->>'subscriptionStatus'),''),
        nullif(r->>'cancellationDate','')::date,
        nullif(btrim(r->>'cancellationReason'),''),
        coalesce((r->>'wasSubscriber')::boolean,false),
        nullif(r->>'nextAppointmentDate','')::date,
        case
          when v_reference_date is null or v_reference_date > current_date - interval '2 months' then null
          when v_reference_date > current_date - interval '4 months' then 'warm'
          when v_reference_date > current_date - interval '12 months' then 'cool'
          else 'cold'
        end,
        now(),
        nullif(r->>'ltv','')::numeric,
        now()
      )
      on conflict (location_id,fieldroutes_office_id,fieldroutes_customer_id)
      do update set
        first_name=coalesce(excluded.first_name,ember.person.first_name),
        last_name=coalesce(excluded.last_name,ember.person.last_name),
        company_name=coalesce(excluded.company_name,ember.person.company_name),
        is_commercial=excluded.is_commercial,
        email=coalesce(excluded.email,ember.person.email),
        phone=coalesce(excluded.phone,ember.person.phone),
        phone_alt=coalesce(excluded.phone_alt,ember.person.phone_alt),
        address_line1=coalesce(excluded.address_line1,ember.person.address_line1),
        city=coalesce(excluded.city,ember.person.city),
        state=coalesce(excluded.state,ember.person.state),
        postal_code=coalesce(excluded.postal_code,ember.person.postal_code),
        last_service_date=case
          when excluded.last_service_date is null then ember.person.last_service_date
          when ember.person.last_service_date is null then excluded.last_service_date
          else greatest(ember.person.last_service_date,excluded.last_service_date)
        end,
        last_service_type_id=coalesce(excluded.last_service_type_id,ember.person.last_service_type_id),
        last_service_description=coalesce(excluded.last_service_description,ember.person.last_service_description),
        service_count=greatest(ember.person.service_count,excluded.service_count),
        customer_since=coalesce(excluded.customer_since,ember.person.customer_since),
        subscription_status=coalesce(excluded.subscription_status,ember.person.subscription_status),
        cancellation_date=coalesce(excluded.cancellation_date,ember.person.cancellation_date),
        cancellation_reason=coalesce(excluded.cancellation_reason,ember.person.cancellation_reason),
        was_subscriber=ember.person.was_subscriber or excluded.was_subscriber,
        next_appointment_date=coalesce(excluded.next_appointment_date,ember.person.next_appointment_date),
        shelf=coalesce(excluded.shelf,ember.person.shelf),
        shelf_computed_at=now(),
        ltv=coalesce(excluded.ltv,ember.person.ltv),
        updated_at=now();

      insert into ember.backfill_record(
        location_id,batch_id,fieldroutes_customer_id,record_hash,status,error,processed_at
      ) values (
        p_location_id,p_batch_id,v_customer_id,v_hash,'imported',null,now()
      )
      on conflict (location_id,batch_id,fieldroutes_customer_id)
      do update set record_hash=excluded.record_hash,status='imported',error=null,processed_at=now();
    exception when others then
      insert into ember.backfill_record(
        location_id,batch_id,fieldroutes_customer_id,record_hash,status,error,processed_at
      ) values (
        p_location_id,p_batch_id,coalesce(v_customer_id,'missing:'||substr(md5(r::text),1,16)),
        v_hash,'rejected',left(sqlerrm,500),now()
      )
      on conflict (location_id,batch_id,fieldroutes_customer_id)
      do update set record_hash=excluded.record_hash,status='rejected',error=excluded.error,processed_at=now();
    end;
  end loop;

  select
    count(*),
    count(*) filter (where status='imported'),
    count(*) filter (where status='rejected'),
    coalesce(jsonb_agg(jsonb_build_object('customerId',fieldroutes_customer_id,'error',error))
      filter (where status='rejected'),'[]'::jsonb)
  into v_received,v_imported,v_rejected,v_errors
  from ember.backfill_record
  where location_id=p_location_id and batch_id=p_batch_id;

  select expected_count into v_expected
  from ember.backfill_batch
  where location_id=p_location_id and batch_id=p_batch_id
  for update;

  update ember.backfill_batch set
    received_count=v_received,
    imported_count=v_imported,
    rejected_count=v_rejected,
    error_summary=v_errors,
    status=case
      when p_finalize and v_expected is not null and v_received=v_expected and v_rejected=0 then 'complete'
      when p_finalize then 'failed'
      else 'receiving'
    end,
    completed_at=case
      when p_finalize and v_expected is not null and v_received=v_expected and v_rejected=0 then now()
      else null
    end,
    updated_at=now()
  where location_id=p_location_id and batch_id=p_batch_id;

  if p_finalize and v_expected is not null and v_received=v_expected and v_rejected=0 then
    update ember.settings
    set backfill_completed_at=now(), updated_at=now()
    where location_id=p_location_id;
  end if;

  return jsonb_build_object(
    'ok',true,
    'location_id',p_location_id,
    'batch_id',p_batch_id,
    'status',case
      when p_finalize and v_expected is not null and v_received=v_expected and v_rejected=0 then 'complete'
      when p_finalize then 'failed'
      else 'receiving'
    end,
    'expected_count',v_expected,
    'received_count',v_received,
    'imported_count',v_imported,
    'rejected_count',v_rejected,
    'errors',v_errors,
    'backfill_completed',p_finalize and v_expected is not null and v_received=v_expected and v_rejected=0,
    'sending_enabled',false
  );
end;
$function$

-- public.ember_list_locations_for_user(p_user_id uuid)
CREATE OR REPLACE FUNCTION public.ember_list_locations_for_user(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
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
$function$

-- public.ember_operation(p_action text, p_location_id text, p_user_id uuid, p_payload jsonb)
CREATE OR REPLACE FUNCTION public.ember_operation(p_action text, p_location_id text, p_user_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_platform_role text;
  v_location_role text;
  v_can_operate boolean := false;
  v_can_admin boolean := false;
  v_result jsonb;
  v_updates jsonb;
  v_template ember.template%rowtype;
begin
  select role into v_platform_role
  from ember.platform_user
  where user_id = p_user_id and is_active is true;

  select role into v_location_role
  from ember.location_user
  where user_id = p_user_id
    and location_id = p_location_id
    and is_active is true;

  if v_platform_role is null and v_location_role is null then
    return jsonb_build_object('ok', false, 'error', 'ember_location_access_denied');
  end if;

  v_can_operate := v_platform_role is not null or v_location_role in ('owner','admin','operator');
  v_can_admin := v_platform_role is not null or v_location_role in ('owner','admin');

  if p_action = 'getDashboard' then
    if not exists (select 1 from ember.location where location_id = p_location_id) then
      return jsonb_build_object('ok', false, 'error', 'ember_location_not_found');
    end if;

    select jsonb_build_object(
      'ok', true,
      'access', jsonb_build_object(
        'platform', v_platform_role is not null,
        'role', coalesce(v_platform_role, v_location_role, ''),
        'canOperate', v_can_operate,
        'canAdmin', v_can_admin
      ),
      'location', (
        select jsonb_build_object(
          'location_id', l.location_id,
          'display_name', l.display_name,
          'timezone', l.timezone,
          'onboarding_status', l.onboarding_status,
          'opted_in_at', l.opted_in_at
        )
        from ember.location l where l.location_id = p_location_id
      ),
      'settings', coalesce((
        select to_jsonb(s) from ember.settings s where s.location_id = p_location_id
      ), '{}'::jsonb),
      'people', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', p.id,
          'shelf', p.shelf,
          'first_name', p.first_name,
          'last_name', p.last_name,
          'last_service_date', p.last_service_date
        ) order by p.id)
        from ember.person p where p.location_id = p_location_id
      ), '[]'::jsonb),
      'peopleCount', (select count(*) from ember.person p where p.location_id = p_location_id),
      'queue', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', q.id,
          'person_id', q.person_id,
          'shelf', q.shelf,
          'channel', q.channel,
          'status', q.status,
          'review_deadline', q.review_deadline,
          'body_preview', q.body_preview,
          'person', jsonb_build_object(
            'first_name', p.first_name,
            'last_name', p.last_name,
            'last_service_date', p.last_service_date
          )
        ) order by q.review_deadline)
        from (
          select * from ember.queue
          where location_id = p_location_id and status in ('pending','approved')
          order by review_deadline
          limit 50
        ) q
        left join ember.person p on p.id = q.person_id
      ), '[]'::jsonb),
      'templates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id,
          'template_key', t.template_key,
          'channel', t.channel,
          'subject', t.subject,
          'body', t.body,
          'is_default', t.is_default,
          'updated_at', t.updated_at
        ) order by t.template_key, t.channel)
        from ember.template t where t.location_id = p_location_id
      ), '[]'::jsonb),
      'suppressionCount', (select count(*) from ember.suppression s where s.location_id = p_location_id),
      'ledger', coalesce((
        select jsonb_agg(jsonb_build_object('outcome', x.outcome))
        from ember.send_ledger x where x.location_id = p_location_id
      ), '[]'::jsonb)
    ) into v_result;
    return v_result;
  end if;

  if p_action = 'updateSettings' then
    if not v_can_admin then
      return jsonb_build_object('ok', false, 'error', 'ember_admin_required');
    end if;
    v_updates := coalesce(p_payload->'updates', '{}'::jsonb);

    if coalesce((v_updates->>'enabled')::boolean, false) is true
       and (
         not exists (
           select 1 from ember.settings s
           where s.location_id = p_location_id and s.backfill_completed_at is not null
         )
         or not exists (
           select 1 from ember.location l
           where l.location_id = p_location_id and l.onboarding_status = 'active'
         )
       ) then
      return jsonb_build_object(
        'ok', false,
        'error', 'activation_gates_not_met',
        'requires', jsonb_build_array('active_onboarding','completed_backfill')
      );
    end if;

    update ember.settings s set
      enabled = case when v_updates ? 'enabled' then (v_updates->>'enabled')::boolean else s.enabled end,
      warm_enabled = case when v_updates ? 'warm_enabled' then (v_updates->>'warm_enabled')::boolean else s.warm_enabled end,
      cool_enabled = case when v_updates ? 'cool_enabled' then (v_updates->>'cool_enabled')::boolean else s.cool_enabled end,
      cold_enabled = case when v_updates ? 'cold_enabled' then (v_updates->>'cold_enabled')::boolean else s.cold_enabled end,
      sms_enabled = case when v_updates ? 'sms_enabled' then (v_updates->>'sms_enabled')::boolean else s.sms_enabled end,
      email_enabled = case when v_updates ? 'email_enabled' then (v_updates->>'email_enabled')::boolean else s.email_enabled end,
      postcard_enabled = case when v_updates ? 'postcard_enabled' then (v_updates->>'postcard_enabled')::boolean else s.postcard_enabled end,
      season_start_date = case when v_updates ? 'season_start_date' then nullif(v_updates->>'season_start_date','')::date else s.season_start_date end,
      season_lead_weeks = case when v_updates ? 'season_lead_weeks' then (v_updates->>'season_lead_weeks')::smallint else s.season_lead_weeks end,
      auto_approve_sends = case when v_updates ? 'auto_approve_sends' then (v_updates->>'auto_approve_sends')::boolean else s.auto_approve_sends end,
      wake_override_at = case when v_updates ? 'wake_override_at' then nullif(v_updates->>'wake_override_at','')::timestamptz else s.wake_override_at end,
      updated_at = now()
    where s.location_id = p_location_id
    returning to_jsonb(s) into v_result;

    if v_result is null then
      return jsonb_build_object('ok', false, 'error', 'ember_settings_not_found');
    end if;
    return jsonb_build_object('ok', true, 'settings', v_result);
  end if;

  if p_action = 'updateTemplate' then
    if not v_can_operate then
      return jsonb_build_object('ok', false, 'error', 'ember_operator_required');
    end if;

    insert into ember.template(location_id, template_key, channel, subject, body, is_default, updated_at)
    values (
      p_location_id,
      lower(p_payload->>'templateKey'),
      lower(coalesce(p_payload->>'channel','sms')),
      nullif(p_payload->>'subject',''),
      p_payload->>'body',
      false,
      now()
    )
    on conflict (location_id, template_key, channel)
    do update set
      subject = excluded.subject,
      body = excluded.body,
      is_default = false,
      updated_at = now()
    returning * into v_template;

    return jsonb_build_object('ok', true, 'template', to_jsonb(v_template));
  end if;

  if p_action = 'updateQueue' then
    if not v_can_operate then
      return jsonb_build_object('ok', false, 'error', 'ember_operator_required');
    end if;
    return public.ember_queue_decide(
      p_location_id,
      (p_payload->>'queueId')::bigint,
      lower(p_payload->>'decision'),
      p_user_id
    );
  end if;

  return jsonb_build_object('ok', false, 'error', 'unknown_action');
end;
$function$

-- public.ember_process_webhook_events(p_limit integer)
CREATE OR REPLACE FUNCTION public.ember_process_webhook_events(p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$

-- public.ember_queue_decide(p_location_id text, p_queue_id bigint, p_decision text, p_decided_by uuid)
CREATE OR REPLACE FUNCTION public.ember_queue_decide(p_location_id text, p_queue_id bigint, p_decision text, p_decided_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_item ember.queue%rowtype;
begin
  if p_decision not in ('approved','skipped','never') then
    raise exception using errcode='22023', message='invalid queue decision';
  end if;

  select * into v_item
  from ember.queue
  where id=p_queue_id and location_id=p_location_id
  for update;

  if v_item.id is null then
    raise exception using errcode='P0002', message='queue item not found';
  end if;
  if v_item.status <> 'pending' then
    raise exception using errcode='55000', message='queue item is not pending';
  end if;

  if p_decision='never' then
    insert into ember.suppression(location_id,person_id,reason,channel,until)
    values(p_location_id,v_item.person_id,'never_contact',null,null);

    update ember.person
    set never_contact=true, updated_at=now()
    where id=v_item.person_id and location_id=p_location_id;

    update ember.queue
    set status='cancelled', decided_at=now(), decided_by=p_decided_by,
        skip_reason='never_contact'
    where person_id=v_item.person_id and location_id=p_location_id
      and status in ('pending','approved');
  else
    update ember.queue
    set status=p_decision,
        decided_at=now(),
        decided_by=p_decided_by,
        skip_reason=case when p_decision='skipped' then 'manual_skip' else null end
    where id=p_queue_id and location_id=p_location_id and status='pending';
  end if;

  return jsonb_build_object('ok',true,'queue_id',p_queue_id,'decision',p_decision);
end;
$function$

-- public.ember_store_webhook_event(p_event_type text, p_fieldroutes_office_id text, p_customer_id text, p_appointment_id text, p_subscription_id text, p_external_id text, p_payload jsonb)
CREATE OR REPLACE FUNCTION public.ember_store_webhook_event(p_event_type text, p_fieldroutes_office_id text, p_customer_id text, p_appointment_id text, p_subscription_id text, p_external_id text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$

-- Privileged routines are server-side only.
revoke all on function public.ember_admin_list_locations() from public, anon, authenticated;
revoke all on function public.ember_enroll_location(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.ember_get_backfill_config(text) from public, anon, authenticated;
revoke all on function public.ember_import_backfill_batch(text,text,text,integer,jsonb,boolean) from public, anon, authenticated;
revoke all on function public.ember_list_locations_for_user(uuid) from public, anon, authenticated;
revoke all on function public.ember_operation(text,text,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.ember_process_webhook_events(integer) from public, anon, authenticated;
revoke all on function public.ember_queue_decide(text,bigint,text,uuid) from public, anon, authenticated;
revoke all on function public.ember_store_webhook_event(text,text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.ember_admin_list_locations() to service_role;
grant execute on function public.ember_enroll_location(text,text,text,text,text) to service_role;
grant execute on function public.ember_get_backfill_config(text) to service_role;
grant execute on function public.ember_import_backfill_batch(text,text,text,integer,jsonb,boolean) to service_role;
grant execute on function public.ember_list_locations_for_user(uuid) to service_role;
grant execute on function public.ember_operation(text,text,uuid,jsonb) to service_role;
grant execute on function public.ember_process_webhook_events(integer) to service_role;
grant execute on function public.ember_queue_decide(text,bigint,text,uuid) to service_role;
grant execute on function public.ember_store_webhook_event(text,text,text,text,text,text,jsonb) to service_role;

