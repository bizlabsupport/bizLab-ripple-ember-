
create table if not exists public.ripple_manual_campaign_drafts (
 id uuid primary key default gen_random_uuid(),
 location_id text not null references public.config(location_id),
 campaign_key text not null,
 label text not null,
 send_cap_per_service integer not null check (send_cap_per_service between 1 and 50),
 street_policy text not null default 'same_street_only' check(street_policy='same_street_only'),
 status text not null default 'draft' check(status in ('draft','reviewed','cancelled')),
 instructions text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(location_id,campaign_key)
);
create table if not exists public.ripple_manual_campaign_draft_services (
 id bigint generated always as identity primary key,
 campaign_id uuid not null references public.ripple_manual_campaign_drafts(id) on delete cascade,
 service_number integer not null check(service_number>0),
 customer_name text not null,
 service_address text not null,
 city text not null default 'Scottsdale',
 region text not null default 'AZ',
 postal_code text not null,
 proposed_cards integer not null check (proposed_cards between 1 and 50),
 status text not null default 'draft' check(status in ('draft','reviewed','cancelled')),
 created_at timestamptz not null default now(),
 unique(campaign_id,service_number)
);
alter table public.ripple_manual_campaign_drafts enable row level security;
alter table public.ripple_manual_campaign_draft_services enable row level security;
revoke all on public.ripple_manual_campaign_drafts from anon,authenticated;
revoke all on public.ripple_manual_campaign_draft_services from anon,authenticated;
