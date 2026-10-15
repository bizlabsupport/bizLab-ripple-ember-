
create table if not exists public.ripple_payment_webhook_events (
 id bigint generated always as identity primary key,
 received_at timestamptz not null default now(),
 source text not null default 'highlevel_form',
 transaction_id text,
 topup_request_id uuid,
 billing_contact_id text,
 claimed_location_id text,
 status text not null default 'awaiting_verification' check (status in ('awaiting_verification','missing_reference','duplicate','rejected','verified','credited','test_verified')),
 payload jsonb not null default '{}'::jsonb,
 rejection_reason text
);
create index if not exists ripple_payment_events_transaction_idx on public.ripple_payment_webhook_events(transaction_id);
create index if not exists ripple_payment_events_topup_idx on public.ripple_payment_webhook_events(topup_request_id);
alter table public.ripple_payment_webhook_events enable row level security;
revoke all on public.ripple_payment_webhook_events from anon,authenticated;
alter table public.ripple_wallet_topup_requests add column if not exists checkout_started_at timestamptz;
alter table public.ripple_wallet_topup_requests add column if not exists payment_environment text check (payment_environment in ('test','live'));
