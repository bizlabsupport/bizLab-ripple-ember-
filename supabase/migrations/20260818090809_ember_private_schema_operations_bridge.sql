
create or replace function public.ember_operation(
  p_action text,
  p_location_id text,
  p_user_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
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
$function$;

revoke all on function public.ember_operation(text,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.ember_operation(text,text,uuid,jsonb) to service_role;
;
