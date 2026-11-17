create table public.business_niches (
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(trim(name)) between 1 and 100),
 landing_url text not null check(landing_url ~ '^https://[^[:space:]]+$'),
 booking_page_url text not null check(booking_page_url ~ '^https://[^[:space:]]+$'),
 active boolean not null default true,
 updated_at timestamptz not null default now()
);
create unique index business_niches_name_unique on public.business_niches(lower(name));
alter table public.business_niches enable row level security;
revoke all on public.business_niches from public,anon,authenticated;
grant all on public.business_niches to service_role;
alter table public.config add column business_niche_id uuid references public.business_niches(id);
create index config_business_niche_idx on public.config(business_niche_id);
insert into public.business_niches(name,landing_url,booking_page_url) values
 ('Mosquito & Pest Control','https://ripple.bizlabsolutions.ai/scratch-card','https://ripple.bizlabsolutions.ai/booking-now'),
 ('Lawn Care','https://ripple.bizlabsolutions.ai/lawn-care/scratch-card','https://ripple.bizlabsolutions.ai/lawn-care/booking-now');
create or replace function public.resolve_landing_base(p_location_id text) returns text
language sql stable security definer set search_path=public as $$
 select coalesce(nullif(trim(c.landing_url),''),case when n.active then nullif(trim(n.landing_url),'') end,nullif(trim(ps.value),''))
 from (select 1) x left join config c on c.location_id=p_location_id
 left join business_niches n on n.id=c.business_niche_id
 left join platform_settings ps on ps.key='landing_base_url';
$$;
create or replace function public.resolve_booking_page(p_location_id text) returns text
language sql stable security definer set search_path=public as $$
 select coalesce(nullif(trim(c.booking_page_url),''),case when n.active then nullif(trim(n.booking_page_url),'') end,nullif(trim(ps.value),''))
 from (select 1) x left join config c on c.location_id=p_location_id
 left join business_niches n on n.id=c.business_niche_id
 left join platform_settings ps on ps.key='booking_base_url';
$$;
