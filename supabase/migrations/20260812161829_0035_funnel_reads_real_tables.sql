-- 0035_funnel_reads_real_tables.sql
--
-- The owner dashboard showed zeros for A4 despite two real mailings and two
-- real claims. Two independent causes, both invisible from the browser.
--
-- 1. mailed and events still carry the FIRST-generation RLS predicate,
--    `location_id = auth_location_id()`, which reads a `location_id` claim
--    from the JWT. Supabase Auth never sets that claim - tenancy moved to the
--    identity layer in migration 0010 - so the function returns null and the
--    policy matches NOTHING. Not "nothing for super admins": nothing for
--    anyone. prize_visits and wins were migrated to my_locations(); these two
--    were missed.
--
-- 2. funnel_summary counted scans, reveals, bookings and wins out of `events`,
--    which has zero rows and no writer. The neighbour journey has been
--    recorded in prize_visits since v12, and wins has its own table. The
--    summary was reading a table the product stopped using.

-- ── 1. Bring mailed and events onto the identity layer ─────────────────────
drop policy if exists mailed_tenant_read on mailed;
create policy mailed_tenant_read on mailed for select
  using (location_id in (select location_id from my_locations()));

drop policy if exists events_tenant_read on events;
create policy events_tenant_read on events for select
  using (location_id in (select location_id from my_locations()));

-- auth_location_id() now has no callers. Left in place rather than dropped:
-- something outside this repo may still reference it, and a comment costs
-- nothing while a surprise dependency costs a session.
comment on function public.auth_location_id() is
  'DEPRECATED - reads a JWT location_id claim that Supabase Auth never sets, so it always returns null. Tenancy is my_locations() (migration 0010). Do not use in new policies.';

-- ── 2. Count the funnel from the tables that actually carry it ─────────────
create or replace function public.funnel_summary(p_location_id text, p_days integer default 7)
returns table(mailed bigint, delivered bigint, scanned bigint, revealed bigint,
              booked bigint, won bigint, revenue numeric)
language sql
stable
set search_path to 'public'
as $function$
  with cutoff as (select now() - (p_days || ' days')::interval as since),
  m as (
    select * from mailed
     where location_id = p_location_id and ts > (select since from cutoff)
  ),
  ev as (
    -- Still the source for delivery: that comes from thanks.io webhooks, whose
    -- ingestion is not built yet, so `delivered` legitimately reads zero.
    select * from events
     where location_id = p_location_id and ts > (select since from cutoff)
  ),
  v as (
    -- One row per household per batch. created_at is the arrival (the scan),
    -- revealed_at the scratch, claimed_at the booking.
    select * from prize_visits
     where location_id = p_location_id and created_at > (select since from cutoff)
  ),
  w as (
    select * from wins
     where location_id = p_location_id and ts > (select since from cutoff)
  )
  select
    (select count(*) from m where status in ('sent','delivered'))                as mailed,
    (select count(*) from m where status = 'delivered'
        or exists (select 1 from ev e where e.mailed_id = m.id and e.type='delivered')) as delivered,
    -- distinct by address: re-scanning a card is not a second neighbour.
    (select count(distinct addr_hash) from v)                                    as scanned,
    (select count(distinct addr_hash) from v where revealed_at is not null)      as revealed,
    (select count(distinct addr_hash) from v where claimed_at is not null)       as booked,
    (select count(*) from w)                                                     as won,
    coalesce((select sum(revenue) from w), 0)                                    as revenue;
$function$;

comment on function public.funnel_summary(text, integer) is
  'Owner funnel for the last N days. mailed/delivered from mailed+events; scanned/revealed/booked from prize_visits; won/revenue from wins. Security invoker - RLS does the scoping.';;
