-- 0030_decide_send_authorisation.sql
--
-- decide_send was SECURITY DEFINER with no check on who was calling. The
-- Control Center calls it from the browser, so any signed-in user who knew or
-- guessed a batch id could approve, cancel or resize another franchise's
-- mailing, and decided_by was written from an unvalidated argument - meaning
-- the audit trail could be set to anyone.
--
-- Behaviour for a legitimate caller is unchanged, including p_user => null for
-- the deadline auto-approve path.

create or replace function public.decide_send(
  p_batch_id text,
  p_cards    integer,
  p_user     uuid default null
)
returns send_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     send_queue;
  v_claims  jsonb;
  v_system  boolean;
  v_uid     uuid := auth.uid();
  v_cap     integer;
begin
  select * into v_row from send_queue where batch_id = p_batch_id;
  if not found then
    raise exception 'unknown batch %', p_batch_id;
  end if;

  -- Who is asking. A direct database connection carries no PostgREST JWT;
  -- anything over the API always does, even anon.
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_system := v_claims is null or (v_claims ->> 'role') = 'service_role';

  if not v_system then
    if v_uid is null then
      raise exception 'sign in to decide a batch' using errcode = '42501';
    end if;
    if not (
      is_super_admin()
      or exists (
        select 1 from tenant_users tu
         where tu.user_id = v_uid
           and tu.location_id = v_row.location_id
           and tu.role in ('owner', 'admin')
      )
    ) then
      -- Same message whether the batch belongs to someone else or does not
      -- exist for this caller: do not confirm another tenant's batch ids.
      raise exception 'not authorised for batch %', p_batch_id using errcode = '42501';
    end if;
  end if;

  -- Once it has left for print there is nothing to decide: postage is spent.
  if v_row.status in ('sending', 'sent') then
    raise exception 'this batch has already been sent';
  end if;

  -- A person deciding is always the person signed in. p_user is honoured only
  -- for the system path, where there is no session to read.
  if not v_system then
    p_user := v_uid;
  end if;

  -- Backstop against a typo that spends real postage: an owner meaning 50 and
  -- typing 500 is the failure mode. The ceiling is this location's radius
  -- count, or what was proposed, whichever is larger.
  select greatest(coalesce(c.radius_count, 25), coalesce(v_row.proposed_cards, 0))
    into v_cap
    from config c where c.location_id = v_row.location_id;

  if coalesce(p_cards, 0) > coalesce(v_cap, 25) then
    raise exception 'cannot approve % cards for this batch; the ceiling is %',
      p_cards, coalesce(v_cap, 25);
  end if;

  update send_queue
     set approved_cards = greatest(coalesce(p_cards, 0), 0),
         status         = case when coalesce(p_cards, 0) > 0 then 'approved' else 'skipped' end,
         decided_at     = now(),
         decided_by     = p_user
   where batch_id = p_batch_id
  returning * into v_row;

  return v_row;
end $$;

revoke all     on function public.decide_send(text, integer, uuid) from public, anon;
grant  execute on function public.decide_send(text, integer, uuid) to authenticated, service_role;

comment on function public.decide_send(text, integer, uuid) is
  'Approve, resize or skip a queued batch. Requires membership (owner|admin) of the batch location, super admin, or a service-role/system caller. decided_by is taken from the session for user calls.';;
