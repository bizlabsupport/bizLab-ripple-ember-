-- Reuse one paid Thanks.io radius result per Ripple location + normalized
-- street for 30 days. Only same-street candidates are retained.

create table if not exists public.street_radius_cache (
  location_id text not null references public.config(location_id) on delete cascade,
  street_key text not null,
  anchor_address text not null,
  postal_code text not null,
  mailing_list_id bigint,
  recipients jsonb not null default '[]'::jsonb,
  radius_candidate_count integer not null default 0 check (radius_candidate_count >= 0),
  street_candidate_count integer not null default 0 check (street_candidate_count >= 0),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (location_id, street_key),
  constraint street_radius_cache_recipients_array
    check (jsonb_typeof(recipients) = 'array')
);

create index if not exists street_radius_cache_expires_idx
  on public.street_radius_cache (expires_at);

alter table public.street_radius_cache enable row level security;

revoke all on table public.street_radius_cache from anon, authenticated;
grant select, insert, update, delete on table public.street_radius_cache to service_role;

comment on table public.street_radius_cache is
  'Service-role-only cache of same-street Thanks.io radius candidates. Prevents repeat paid lookups for another completed job on the same street.';