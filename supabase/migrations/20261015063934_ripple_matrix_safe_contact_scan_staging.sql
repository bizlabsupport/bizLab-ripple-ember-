
create table if not exists public.ripple_matrix_contact_scan_runs (
 id uuid primary key default gen_random_uuid(),
 location_id text not null references public.config(location_id),
 campaign_id uuid not null references public.ripple_manual_campaign_drafts(id),
 status text not null default 'running' check(status in ('running','complete','failed')),
 page integer not null default 1 check(page >= 1),
 scanned_contacts integer not null default 0,
 addressed_contacts integer not null default 0,
 matched_addresses integer not null default 0,
 total_contacts integer,
 last_error text,
 started_at timestamptz not null default now(),
 completed_at timestamptz,
 updated_at timestamptz not null default now(),
 unique(location_id,campaign_id)
);
create table if not exists public.ripple_matrix_scan_matches (
 scan_id uuid not null references public.ripple_matrix_contact_scan_runs(id),
 addr_hash text not null,
 contact_id text,
 contact_type text,
 contact_status text,
 created_at timestamptz not null default now(),
 primary key(scan_id,addr_hash)
);
alter table public.ripple_matrix_contact_scan_runs enable row level security;
alter table public.ripple_matrix_scan_matches enable row level security;
revoke all on public.ripple_matrix_contact_scan_runs from anon,authenticated;
revoke all on public.ripple_matrix_scan_matches from anon,authenticated;
