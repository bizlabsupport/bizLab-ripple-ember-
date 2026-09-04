insert into ember.platform_user (user_id, role, is_active)
select au.id, 'super_admin', true
from public.app_users au
where au.is_super_admin is true
on conflict (user_id) do update set role='super_admin', is_active=true;

create or replace function public.ember_queue_decide(
  p_location_id text,
  p_queue_id bigint,
  p_decision text,
  p_decided_by uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

revoke all on function public.ember_queue_decide(text,bigint,text,uuid) from public, anon, authenticated;
grant execute on function public.ember_queue_decide(text,bigint,text,uuid) to service_role;
comment on function public.ember_queue_decide(text,bigint,text,uuid) is
'Service-role-only atomic Ember queue decision. Never-contact creates a permanent suppression and cancels outstanding messages for that person.';;
