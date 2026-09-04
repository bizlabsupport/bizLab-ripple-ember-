-- 0034_prize_visits_crm_error.sql
--
-- The claim handler's HighLevel write is best-effort by design: a CRM failure
-- must not lose a claim the customer already completed. But the REASON was
-- only returned in the HTTP response and written to console.error, so two
-- claims (4 Aug and 11 Aug) failed with no record anywhere. Both leads sat in
-- prize_visits with a null ghl_contact_id and nobody could tell why.
--
-- Best-effort is fine. Silent is not.

alter table prize_visits
  add column if not exists crm_error        text,
  add column if not exists crm_attempted_at timestamptz;

comment on column prize_visits.crm_error is
  'Why the HighLevel contact write failed, null when it succeeded or was never attempted. Paired with crm_attempted_at so "never tried" is distinguishable from "tried and worked".';

-- The работа queue: claims that never reached the CRM. An owner acting on
-- these by hand is the fallback that makes best-effort acceptable.
create index if not exists prize_visits_crm_failed_idx
  on prize_visits (location_id, claimed_at desc)
  where claimed_at is not null and ghl_contact_id is null;;
