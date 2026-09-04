-- Ember foundation: FieldRoutes webhook intake and Control Center settings.
-- Additive only. This migration does not alter any Ripple object.

create schema if not exists ember;

create table if not exists ember.settings (
  location_id text primary key references public.config(location_id) on delete cascade,
  enabled boolean not null default false,
  warm_enabled boolean not null default true,
  cool_enabled boolean not null default true,
  cold_enabled boolean not null default false,
  sms_enabled boolean not null default true,
  email_enabled boolean not null default true,
  postcard_enabled boolean not null default false,
  postcard_min_ltv numeric(12,2) not null default 250 check (postcard_min_ltv >= 0),
  quiet_start_hour smallint not null default 9 check (quiet_start_hour between 0 and 23),
  quiet_end_hour smallint not null default 19 check (quiet_end_hour between 0 and 23),
  daily_message_cap integer not null default 100 check (daily_message_cap > 0),
  global_cap_days integer not null default 10 check (global_cap_days > 0),
  season_start_date date,
  season_lead_weeks smallint not null default 3 check (season_lead_weeks between 0 and 52),
  postcard_min_services integer not null default 4 check (postcard_min_services >= 0),
  auto_approve_sends boolean not null default false,
  backfill_completed_at timestamptz,
  wake_override_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ember_settings_quiet_window_check check (quiet_start_hour <> quiet_end_hour)
);

create table if not exists ember.office_map (
  fieldroutes_office_id text primary key,
  location_id text not null references public.config(location_id) on delete cascade,
  office_name text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ember_office_map_location_idx
  on ember.office_map (location_id);

create table if not exists ember.field_map (
  location_id text primary key references public.config(location_id) on delete cascade,
  customer_id_field text not null default 'Eblg4vN8uRk8fOztdwyJ',
  office_id_field text not null default 'B2OAr7TtE5lsh1rp1SMN',
  status_field text not null default 'hph8AOhPu6sLXuEAcSjs',
  commercial_account_field text default '8FibfumoH6YH9fs2hwo5',
  subscriptions_field text default 'bcNbqjuCN6u35BCKijmL',
  field_ids jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ember_field_map_field_ids_object_check
    check (jsonb_typeof(field_ids) = 'object')
);

create table if not exists ember.webhook_event (
  id bigint generated always as identity primary key,
  source text not null default 'fieldroutes' check (source = 'fieldroutes'),
  event_type text not null check (
    event_type in (
      'appointment_scheduled',
      'appointment_rescheduled',
      'appointment_cancelled',
      'service_completed'
    )
  ),
  fieldroutes_office_id text not null,
  customer_id text not null,
  appointment_id text not null,
  subscription_id text,
  external_id text not null,
  payload jsonb not null,
  status text not null default 'received' check (
    status in ('received', 'processing', 'processed', 'duplicate', 'failed', 'ignored')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  error text,
  received_at timestamptz not null default now(),
  processing_started_at timestamptz,
  processed_at timestamptz,
  constraint ember_webhook_event_payload_object_check
    check (jsonb_typeof(payload) = 'object'),
  constraint ember_webhook_event_external_id_unique unique (external_id)
);

create index if not exists ember_webhook_event_received_idx
  on ember.webhook_event (received_at desc);

create index if not exists ember_webhook_event_unprocessed_idx
  on ember.webhook_event (received_at)
  where status in ('received', 'failed');

create index if not exists ember_webhook_event_customer_idx
  on ember.webhook_event (fieldroutes_office_id, customer_id, received_at desc);

create table if not exists ember.activity_event (
  id bigint generated always as identity primary key,
  webhook_event_id bigint not null unique
    references ember.webhook_event(id) on delete restrict,
  location_id text not null references public.config(location_id) on delete cascade,
  person_id bigint references ember.person(id) on delete set null,
  event_type text not null check (
    event_type in (
      'appointment_scheduled',
      'appointment_rescheduled',
      'appointment_cancelled',
      'service_completed'
    )
  ),
  fieldroutes_office_id text not null,
  customer_id text not null,
  appointment_id text not null,
  subscription_id text,
  service_type_id text,
  service_description text,
  service_date date not null,
  service_start_time text,
  service_end_time text,
  service_address text,
  city text,
  state text,
  postal_code text,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ember_activity_event_identity_unique
    unique (location_id, event_type, appointment_id)
);

create index if not exists ember_activity_event_person_idx
  on ember.activity_event (person_id, service_date desc)
  where person_id is not null;

create index if not exists ember_activity_event_location_date_idx
  on ember.activity_event (location_id, service_date desc);

create index if not exists ember_activity_event_customer_idx
  on ember.activity_event (fieldroutes_office_id, customer_id, service_date desc);

-- Keep new Ember objects closed by default. Server-side ingestion uses service_role.
revoke all on table ember.settings from public, anon;
revoke all on table ember.office_map from public, anon;
revoke all on table ember.field_map from public, anon;
revoke all on table ember.webhook_event from public, anon;
revoke all on table ember.activity_event from public, anon;

grant usage on schema ember to authenticated, service_role;
grant select on table ember.settings, ember.office_map, ember.field_map,
  ember.webhook_event, ember.activity_event to authenticated;
grant select, insert, update, delete on table ember.settings, ember.office_map,
  ember.field_map, ember.webhook_event, ember.activity_event to service_role;
grant usage, select on all sequences in schema ember to service_role;

alter table ember.settings enable row level security;
alter table ember.office_map enable row level security;
alter table ember.field_map enable row level security;
alter table ember.webhook_event enable row level security;
alter table ember.activity_event enable row level security;

create policy ember_settings_tenant_read on ember.settings
  for select to authenticated
  using (
    location_id in (
      select ml.location_id from public.my_locations() as ml
    )
  );

create policy ember_office_map_tenant_read on ember.office_map
  for select to authenticated
  using (
    location_id in (
      select ml.location_id from public.my_locations() as ml
    )
  );

create policy ember_field_map_tenant_read on ember.field_map
  for select to authenticated
  using (
    location_id in (
      select ml.location_id from public.my_locations() as ml
    )
  );

create policy ember_webhook_event_tenant_read on ember.webhook_event
  for select to authenticated
  using (
    exists (
      select 1
      from ember.office_map om
      where om.fieldroutes_office_id = webhook_event.fieldroutes_office_id
        and om.location_id in (
          select ml.location_id from public.my_locations() as ml
        )
    )
  );

create policy ember_activity_event_tenant_read on ember.activity_event
  for select to authenticated
  using (
    location_id in (
      select ml.location_id from public.my_locations() as ml
    )
  );

comment on table ember.settings is
  'Ember-only Control Center settings. Separate from Ripple configuration.';
comment on table ember.office_map is
  'Maps FieldRoutes office IDs to existing application tenant location IDs.';
comment on table ember.field_map is
  'Per-location HighLevel custom-field IDs used by the FieldRoutes two-way sync.';
comment on table ember.webhook_event is
  'Immutable intake/audit record for authenticated FieldRoutes-derived webhook payloads.';
comment on table ember.activity_event is
  'Normalized appointment and service events derived from Ember webhook intake.';
