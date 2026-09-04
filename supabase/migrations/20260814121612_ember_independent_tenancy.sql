
create table ember.location (
  location_id text primary key,
  display_name text not null,
  ghl_location_id text unique,
  timezone text not null default 'UTC',
  onboarding_status text not null default 'draft'
    check (onboarding_status in ('draft', 'testing', 'active', 'paused', 'archived')),
  opted_in_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table ember.location is
  'Independent Ember tenant registry. A location can exist here without existing in Ripple public.config.';

create table ember.location_user (
  location_id text not null references ember.location(location_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer'
    check (role in ('owner', 'admin', 'operator', 'viewer')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (location_id, user_id)
);

comment on table ember.location_user is
  'Ember-only location membership. It does not change or depend on Ripple user access.';

create index location_user_user_active_idx
  on ember.location_user (user_id, location_id)
  where is_active;

create table ember.platform_user (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'super_admin'
    check (role = 'super_admin'),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table ember.platform_user is
  'Global Ember administrators for the Super Admin enrollment experience.';

alter table ember.location enable row level security;
alter table ember.location_user enable row level security;
alter table ember.platform_user enable row level security;

create policy ember_location_member_read
  on ember.location
  for select
  to authenticated
  using (
    exists (
      select 1
      from ember.location_user lu
      where lu.location_id = location.location_id
        and lu.user_id = (select auth.uid())
        and lu.is_active
    )
    or exists (
      select 1
      from ember.platform_user pu
      where pu.user_id = (select auth.uid())
        and pu.is_active
    )
  );

create policy ember_location_user_self_read
  on ember.location_user
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1
      from ember.platform_user pu
      where pu.user_id = (select auth.uid())
        and pu.is_active
    )
  );

create policy ember_platform_user_self_read
  on ember.platform_user
  for select
  to authenticated
  using (user_id = (select auth.uid()) and is_active);

revoke all on ember.location, ember.location_user, ember.platform_user from anon;
grant select on ember.location, ember.location_user, ember.platform_user to authenticated;
grant all on ember.location, ember.location_user, ember.platform_user to service_role;

alter table ember.person
  drop constraint person_location_id_fkey,
  add constraint person_location_id_fkey
    foreign key (location_id) references ember.location(location_id);

alter table ember.identity_map
  drop constraint identity_map_location_id_fkey,
  add constraint identity_map_location_id_fkey
    foreign key (location_id) references ember.location(location_id);

alter table ember.send_ledger
  drop constraint send_ledger_location_id_fkey,
  add constraint send_ledger_location_id_fkey
    foreign key (location_id) references ember.location(location_id);

alter table ember.suppression
  drop constraint suppression_location_id_fkey,
  add constraint suppression_location_id_fkey
    foreign key (location_id) references ember.location(location_id);

alter table ember.queue
  drop constraint queue_location_id_fkey,
  add constraint queue_location_id_fkey
    foreign key (location_id) references ember.location(location_id);

alter table ember.template
  drop constraint template_location_id_fkey,
  add constraint template_location_id_fkey
    foreign key (location_id) references ember.location(location_id);

alter table ember.settings
  drop constraint settings_location_id_fkey,
  add constraint settings_location_id_fkey
    foreign key (location_id) references ember.location(location_id) on delete cascade;

alter table ember.office_map
  drop constraint office_map_location_id_fkey,
  add constraint office_map_location_id_fkey
    foreign key (location_id) references ember.location(location_id) on delete cascade;

alter table ember.field_map
  drop constraint field_map_location_id_fkey,
  add constraint field_map_location_id_fkey
    foreign key (location_id) references ember.location(location_id) on delete cascade;

alter table ember.activity_event
  drop constraint activity_event_location_id_fkey,
  add constraint activity_event_location_id_fkey
    foreign key (location_id) references ember.location(location_id) on delete cascade;

drop policy if exists person_tenant_read on ember.person;
create policy person_tenant_read
  on ember.person for select to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = person.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists identity_map_tenant_read on ember.identity_map;
create policy identity_map_tenant_read
  on ember.identity_map for select to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = identity_map.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists send_ledger_tenant_read on ember.send_ledger;
create policy send_ledger_tenant_read
  on ember.send_ledger for select to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = send_ledger.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists suppression_tenant_read on ember.suppression;
create policy suppression_tenant_read
  on ember.suppression for select to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = suppression.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists queue_tenant_read on ember.queue;
create policy queue_tenant_read
  on ember.queue for select to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = queue.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists queue_tenant_update on ember.queue;
create policy queue_tenant_update
  on ember.queue for update to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = queue.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
        and lu.role in ('owner', 'admin', 'operator')
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  )
  with check (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = queue.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
        and lu.role in ('owner', 'admin', 'operator')
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists template_tenant_read on ember.template;
create policy template_tenant_read
  on ember.template for select to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = template.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists ember_settings_tenant_read on ember.settings;
create policy ember_settings_tenant_read
  on ember.settings for select to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = settings.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists ember_office_map_tenant_read on ember.office_map;
create policy ember_office_map_tenant_read
  on ember.office_map for select to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = office_map.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists ember_field_map_tenant_read on ember.field_map;
create policy ember_field_map_tenant_read
  on ember.field_map for select to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = field_map.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists ember_activity_event_tenant_read on ember.activity_event;
create policy ember_activity_event_tenant_read
  on ember.activity_event for select to authenticated
  using (
    exists (
      select 1 from ember.location_user lu
      where lu.location_id = activity_event.location_id
        and lu.user_id = (select auth.uid()) and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

drop policy if exists ember_webhook_event_tenant_read on ember.webhook_event;
create policy ember_webhook_event_tenant_read
  on ember.webhook_event for select to authenticated
  using (
    exists (
      select 1
      from ember.office_map om
      join ember.location_user lu on lu.location_id = om.location_id
      where om.fieldroutes_office_id = webhook_event.fieldroutes_office_id
        and lu.user_id = (select auth.uid())
        and lu.is_active
    )
    or exists (
      select 1 from ember.platform_user pu
      where pu.user_id = (select auth.uid()) and pu.is_active
    )
  );

create or replace view ember.eligibility
with (security_invoker = true)
as
select
  p.id as person_id,
  p.location_id,
  p.shelf,
  case
    when not coalesce(s.enabled, false) then 'gate01_master_switch'
    when p.is_commercial then 'gate02_commercial'
    when p.never_contact then 'gate03_never_contact'
    when p.subscription_status = 'active' then 'gate04_active_subscriber'
    when p.next_appointment_date is not null then 'gate05_future_appointment'
    when exists (
      select 1 from ember.suppression sp
      where sp.person_id = p.id
        and (sp.until is null or sp.until > now())
    ) then 'gate07_suppressed'
    when coalesce(p.phone, p.email) is null then 'gate08_uncontactable'
    when not exists (
      select 1 from ember.identity_map m
      where m.person_id = p.id and m.status = 'confirmed'
    ) then 'gate09_identity_unconfirmed'
    when p.shelf is null or p.shelf = 'none' then 'gate10_no_shelf'
    when exists (
      select 1 from ember.send_ledger l
      where l.person_id = p.id
        and l.sent_at > now() - make_interval(days => coalesce(s.global_cap_days, 10))
    ) then 'gate12_frequency_cap'
    when s.backfill_completed_at is null then 'gate00_backfill_incomplete'
    else null
  end as blocked_by_gate
from ember.person p
join ember.settings s on s.location_id = p.location_id;

comment on view ember.eligibility is
  'Ember-only eligibility gates. Uses ember.settings and no Ripple configuration.';
;
