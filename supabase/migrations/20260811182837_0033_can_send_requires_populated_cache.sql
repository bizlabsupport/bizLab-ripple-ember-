-- 0033_can_send_requires_populated_cache.sql
--
-- can_send() gated on address_backfill_completed_at being non-null. That is a
-- claim, not evidence: A4 Outdoors had the timestamp set by hand during
-- testing while client_addresses held zero rows, so the gate said yes and
-- suppression check 1 had nothing to compare against.
--
-- The consequence is the worst failure this product has: mailing a
-- "new customer" offer to somebody who is already the client's customer,
-- referencing a job the client did for them last week.
--
-- So the gate now requires the cache to actually contain something. A
-- timestamp can be set by accident; a populated table cannot.

create or replace function public.can_send(p_location_id text)
returns table(allowed boolean, reason text)
language sql
stable
as $function$
  select
    case
      when c.location_id is null then false
      when c.paused then false
      when c.address_backfill_completed_at is null then false
      when not exists (
        select 1 from client_addresses ca where ca.location_id = c.location_id
      ) then false
      else true
    end,
    case
      when c.location_id is null then 'no config row for location'
      when c.paused then 'client is paused'
      when c.address_backfill_completed_at is null
        then 'customer address backfill has not completed - refusing to send'
      when not exists (
        select 1 from client_addresses ca where ca.location_id = c.location_id
      ) then 'backfill is marked complete but the customer address cache is empty - refusing to send'
      else 'ok'
    end
  from (select p_location_id as lid) q
  left join config c on c.location_id = q.lid;
$function$;

comment on function public.can_send(text) is
  'Fail-closed send gate. Requires a config row, not paused, a completed backfill AND a non-empty client_addresses cache - the timestamp alone is a claim, not evidence.';

-- Clear the flag that was set by hand for testing. It will be set again, for
-- real, when the backfill actually runs.
update config
   set address_backfill_completed_at = null
 where address_backfill_completed_at is not null
   and not exists (
     select 1 from client_addresses ca where ca.location_id = config.location_id
   );;
