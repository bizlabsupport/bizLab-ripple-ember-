-- 0029_scope_tenant_views.sql
--
-- Three views read config with security_invoker off and no tenancy filter, so
-- every one of them returns every client's row to any signed-in session. The
-- dashboard reads `tenants` straight from the browser with the anon key, which
-- means changing ?loc= in the URL was enough to read another franchise's
-- config - including their thanks.io sub-account and billing posture.
--
-- Fix at the view, not the caller: these are PostgREST-exposed surfaces, so
-- anyone with the anon key can query them directly regardless of what the page
-- does. The predicate is deliberately the same on all three.

create or replace function public.caller_can_see_location(p_location_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- A direct database connection (SQL editor, psql, a migration) carries no
    -- PostgREST JWT. Anything arriving over the API always does, even anon.
    nullif(current_setting('request.jwt.claims', true), '') is null
    or (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role'
    or public.is_super_admin()
    or exists (
      select 1 from tenant_users tu
       where tu.user_id = auth.uid()
         and tu.location_id = p_location_id
    );
$$;

comment on function public.caller_can_see_location(text) is
  'Shared tenancy predicate for the config-backed views. Service role and direct DB connections pass; a user session must be a member of the location or a super admin.';

-- ── tenants ────────────────────────────────────────────────────────────────
create or replace view public.tenants as
  select location_id as id,
         client_name as name,
         location_id as slug,
         prize_weights,
         booking_url,
         report_emails,
         radius_count,
         suppression_days,
         daily_throttle,
         paused,
         address_backfill_completed_at,
         thanksio_subaccount_id,
         thanksio_template_id,
         created_at
    from config c
   where c.location_id is not null
     and c.location_id not like 'company:%'   -- 0012: junk installs are not franchises
     and public.caller_can_see_location(c.location_id);

-- ── billing_balances ───────────────────────────────────────────────────────
create or replace view public.billing_balances as
  select location_id,
         client_name,
         billing_mode,
         stripe_payment_method_id is not null as has_card,
         location_balance_cents(location_id) as balance_cents,
         topup_threshold_cents,
         auto_topup_cents
    from config c
   where public.caller_can_see_location(c.location_id);

-- ── send_queue_due ─────────────────────────────────────────────────────────
-- Same body as before; only the tenancy predicate is added. The drain runs as
-- service_role, so it still sees every location.
create or replace view public.send_queue_due as
  with day_totals as (
    select q_1.location_id,
           date_trunc('day', q_1.review_deadline) as day,
           sum(coalesce(q_1.approved_cards, q_1.proposed_cards)) over (
             partition by q_1.location_id, date_trunc('day', q_1.review_deadline)
             order by q_1.id rows between unbounded preceding and current row
           ) as running_cards,
           q_1.id
      from send_queue q_1
     where q_1.status = any (array['pending', 'approved'])
  )
  select q.id, q.location_id, q.job_id, q.batch_id, q.neighborhood,
         q.service_address, q.completed_at, q.proposed_cards, q.approved_cards,
         q.status, q.review_deadline, q.notify_at, q.decided_at, q.decided_by,
         q.sent_at, q.skip_reason, q.created_at,
         c.auto_approve_sends, c.daily_card_cap, d.running_cards,
         q.status = 'approved' as explicitly_approved,
         q.status = 'pending' and c.auto_approve_sends
           and d.running_cards <= c.daily_card_cap as auto_approved
    from send_queue q
    join config c on c.location_id = q.location_id
    join day_totals d on d.id = q.id
   where q.review_deadline <= now()
     and q.status = any (array['pending', 'approved'])
     and coalesce(q.approved_cards, q.proposed_cards) > 0
     and public.caller_can_see_location(q.location_id);;
