
alter table public.config add column if not exists billing_ghl_contact_id text;
alter table public.config add column if not exists billing_payment_page_url text;
alter table public.config add column if not exists beta_billing_enabled boolean not null default false;
alter table public.config add column if not exists low_balance_alert_cents integer not null default 5000;
create table if not exists public.ripple_wallet_topup_requests (
 id uuid primary key default gen_random_uuid(),
 location_id text not null references public.config(location_id),
 initiated_by uuid not null references auth.users(id),
 amount_cents integer not null check(amount_cents between 1000 and 500000),
 currency text not null default 'USD' check(currency='USD'),
 billing_ghl_contact_id text not null,
 status text not null default 'pending_checkout' check(status in ('pending_checkout','awaiting_payment','paid','cancelled','failed','expired')),
 payment_source text not null default 'highlevel_hosted',
 payment_reference text unique,
 ghl_invoice_id text unique,
 ghl_transaction_id text unique,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 paid_at timestamptz,
 constraint paid_requires_transaction check(status <> 'paid' or (ghl_transaction_id is not null and paid_at is not null))
);
alter table public.ripple_wallet_topup_requests enable row level security;
revoke all on public.ripple_wallet_topup_requests from anon,authenticated;
create index if not exists ripple_wallet_topups_location_created_idx on public.ripple_wallet_topup_requests(location_id,created_at desc);
