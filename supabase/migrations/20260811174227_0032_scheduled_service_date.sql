-- 0032_scheduled_service_date.sql
--
-- v14 moved the trigger from "job completed" to "appointment scheduled, mail
-- once the service date has passed". The decision was recorded but the schema
-- never followed: jobs and send_queue carry only completed_at, so there is no
-- forward-looking date to plan a week or a month against.
--
-- service_date is a DATE, deliberately. The appointment has a clock time, but
-- everything downstream cares about the local calendar day: the review
-- deadline is the morning after, in config.timezone. Storing a timestamptz
-- would reintroduce the drift already seen in the job key, where an 8pm
-- Eastern job files under tomorrow's UTC date.

alter table jobs       add column if not exists service_date date;
alter table send_queue add column if not exists service_date date;

comment on column send_queue.service_date is
  'Local calendar date the service is scheduled for. Null on rows created before 0032 - fall back to completed_at. The review deadline and the batch id are anchored on this when present.';

-- The week and month views read this.
create index if not exists send_queue_service_date_idx
  on send_queue (location_id, service_date);

-- ── enqueue: anchor on the service date when there is one ──────────────────
-- Dropped and recreated rather than adding an overload: a surviving second
-- signature is the v8 store_location_token bug, where Postgres could not
-- choose and token storage silently broke.
drop function if exists public.enqueue_completed_job(text, bigint, text, text, timestamptz);

create function public.enqueue_completed_job(
  p_location_id  text,
  p_job_id       bigint,
  p_address      text        default null,
  p_neighborhood text        default null,
  p_completed_at timestamptz default now(),
  p_service_date date        default null
)
returns send_queue
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row      send_queue;
  v_tz       text;
  v_hour     int;
  v_cards    int;
  v_anchor   date;
  v_deadline timestamptz;
  v_batch    text;
  v_job      jobs;
begin
  select coalesce(timezone, 'America/New_York'),
         coalesce(review_hour, 10),
         coalesce(radius_count, 20)
    into v_tz, v_hour, v_cards
    from config where location_id = p_location_id;

  if v_tz is null then
    raise exception 'no config row for location %', p_location_id;
  end if;

  select * into v_job from jobs where id = p_job_id;

  -- The scheduled date wins when given; completion is the fallback, so a
  -- completion-triggered install keeps working unchanged.
  v_anchor := coalesce(p_service_date, v_job.service_date,
                       (p_completed_at at time zone v_tz)::date);

  v_deadline := ((v_anchor + 1)::timestamp + make_interval(hours => v_hour)) at time zone v_tz;
  v_batch    := 'B' || to_char(v_anchor, 'YYYYMMDD') || '-' || p_job_id;

  insert into send_queue (location_id, job_id, batch_id, neighborhood, service_address,
                          completed_at, service_date, proposed_cards, review_deadline, lat, lng)
  values (p_location_id, p_job_id, v_batch,
          coalesce(p_neighborhood, v_job.neighborhood, v_job.city),
          coalesce(p_address, v_job.service_address),
          p_completed_at, v_anchor, v_cards, v_deadline, v_job.lat, v_job.lng)
  on conflict (location_id, job_id) do update
    set service_address = coalesce(excluded.service_address, send_queue.service_address),
        neighborhood    = coalesce(excluded.neighborhood, send_queue.neighborhood),
        lat             = coalesce(excluded.lat, send_queue.lat),
        lng             = coalesce(excluded.lng, send_queue.lng),
        -- A reschedule must move the deadline with it. The old function left
        -- both untouched, so a job pushed a week out would still have mailed
        -- on the original morning. Only while the batch is still undecided:
        -- once it is approved, sending or sent, the date is history.
        service_date    = case when send_queue.status = 'pending'
                               then coalesce(excluded.service_date, send_queue.service_date)
                               else send_queue.service_date end,
        completed_at    = case when send_queue.status = 'pending'
                               then excluded.completed_at else send_queue.completed_at end,
        review_deadline = case when send_queue.status = 'pending'
                               then excluded.review_deadline else send_queue.review_deadline end
  returning * into v_row;

  return v_row;
end $function$;

comment on function public.enqueue_completed_job(text, bigint, text, text, timestamptz, date) is
  'Queue a batch for a job. Anchors the batch id and review deadline on p_service_date when given, else the completion date. Idempotent on (location_id, job_id); a reschedule moves the deadline only while the batch is still pending. batch_id is never rewritten - it is the scan key printed on the card.';

-- ── cancelling a queued batch ──────────────────────────────────────────────
-- Trusting a schedule means a card can be queued for a job that then gets
-- cancelled. Without this, twenty neighbours hear about a treatment that never
-- happened.
create or replace function public.cancel_queued_batch(
  p_location_id text,
  p_ghl_job_id  text,
  p_reason      text default 'appointment cancelled'
)
returns send_queue
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row    send_queue;
  v_claims jsonb;
  v_system boolean;
  v_uid    uuid := auth.uid();
begin
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_system := v_claims is null or (v_claims ->> 'role') = 'service_role';

  if not v_system then
    if v_uid is null or not (
      is_super_admin()
      or exists (select 1 from tenant_users tu
                  where tu.user_id = v_uid
                    and tu.location_id = p_location_id
                    and tu.role in ('owner', 'admin'))
    ) then
      raise exception 'not authorised for location %', p_location_id using errcode = '42501';
    end if;
  end if;

  select q.* into v_row
    from send_queue q
    join jobs j on j.id = q.job_id
   where q.location_id = p_location_id
     and j.ghl_job_id  = p_ghl_job_id;

  -- Cancelling something that was never queued, or cancelling twice, is not an
  -- error: HighLevel retries, and the caller should be able to replay safely.
  if not found then
    return null;
  end if;

  -- Postage is irreversible. Return the row unchanged so the caller can see
  -- status = 'sending' or 'sent' and tell somebody, rather than pretending.
  if v_row.status in ('sending', 'sent') then
    return v_row;
  end if;

  if v_row.status = 'skipped' then
    return v_row;
  end if;

  update send_queue
     set status         = 'skipped',
         approved_cards = 0,
         skip_reason    = p_reason,
         decided_at     = now(),
         decided_by     = case when v_system then decided_by else v_uid end
   where id = v_row.id
  returning * into v_row;

  return v_row;
end $function$;

comment on function public.cancel_queued_batch(text, text, text) is
  'Pull a queued batch when its appointment is cancelled. Idempotent and safe to replay: returns null if nothing was queued, and returns the row untouched if it has already gone to print.';

revoke all     on function public.cancel_queued_batch(text, text, text) from public, anon;
grant  execute on function public.cancel_queued_batch(text, text, text) to authenticated, service_role;;
