
create table if not exists public.ripple_manual_campaign_review_lookups (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.ripple_manual_campaign_drafts(id),
  location_id text not null references public.config(location_id),
  street_key text not null,
  anchor_address text not null,
  postal_code text not null,
  requested_records integer not null check(requested_records=10),
  status text not null default 'reserved'
    check(status in ('reserved','initiating','purchased','populated','error_requires_review')),
  mailing_list_id bigint,
  radius_candidate_count integer,
  same_street_count integer,
  eligible_count integer,
  exclusion_count integer,
  error_message text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(campaign_id,street_key)
);
create table if not exists public.ripple_manual_campaign_review_recipients (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.ripple_manual_campaign_drafts(id),
  lookup_id bigint not null references public.ripple_manual_campaign_review_lookups(id),
  addr_hash text not null,
  address text not null,
  city text,
  province text,
  postal_code text,
  eligibility text not null
     check(eligibility in ('eligible','existing_customer','suppressed','out_of_street','duplicate')),
  reason text,
  created_at timestamptz not null default now(),
  unique(campaign_id,addr_hash)
);
alter table public.ripple_manual_campaign_review_lookups enable row level security;
alter table public.ripple_manual_campaign_review_recipients enable row level security;
revoke all on public.ripple_manual_campaign_review_lookups from anon,authenticated;
revoke all on public.ripple_manual_campaign_review_recipients from anon,authenticated;
