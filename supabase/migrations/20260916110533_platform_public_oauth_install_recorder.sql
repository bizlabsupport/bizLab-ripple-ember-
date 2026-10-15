create table if not exists platform.oauth_install_audit (
  id bigint generated always as identity primary key,
  marketplace_app_id uuid references platform.marketplace_apps(id) on delete set null,
  organization_id uuid references platform.organizations(id) on delete set null,
  installation_id uuid references platform.app_installations(id) on delete set null,
  event text not null,
  user_type text,
  company_id text,
  location_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table platform.oauth_install_audit enable row level security;
revoke all on platform.oauth_install_audit from public, anon, authenticated;
grant select, insert, update, delete on platform.oauth_install_audit to service_role;
grant usage, select on sequence platform.oauth_install_audit_id_seq to service_role;

create or replace function public.platform_record_public_install(
  p_user_type text,
  p_company_id text,
  p_location_id text,
  p_user_id text,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz,
  p_scopes text,
  p_plan_id text default null,
  p_location_name text default null,
  p_company_name text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, platform, vault, extensions
as $$
declare
  v_app platform.marketplace_apps%rowtype;
  v_org_id uuid;
  v_agency_id uuid;
  v_location_uuid uuid;
  v_install_id uuid;
  v_access_secret uuid;
  v_refresh_secret uuid;
  v_org_name text;
  v_slug text;
  v_existing_org uuid;
begin
  if p_user_type not in ('Company','Location') then
    raise exception 'invalid user type';
  end if;
  if p_company_id is null or btrim(p_company_id) = '' then
    raise exception 'company id required';
  end if;
  if p_user_type = 'Location' and (p_location_id is null or btrim(p_location_id) = '') then
    raise exception 'location id required';
  end if;
  if p_access_token is null or btrim(p_access_token) = '' then
    raise exception 'access token required';
  end if;

  select * into v_app
  from platform.marketplace_apps
  where app_key = 'ripple_public'
  limit 1;
  if v_app.id is null then
    raise exception 'ripple_public app is not registered';
  end if;

  select organization_id into v_existing_org
  from platform.highlevel_agencies
  where company_id = p_company_id
  order by created_at asc
  limit 1;

  if v_existing_org is not null then
    v_org_id := v_existing_org;
  else
    v_org_name := coalesce(nullif(btrim(p_company_name), ''), 'HighLevel Agency ' || left(p_company_id, 8));
    v_slug := 'ghl-' || lower(regexp_replace(p_company_id, '[^a-zA-Z0-9]+', '-', 'g'));
    insert into platform.organizations(name, slug, organization_type, status, metadata)
    values (v_org_name, v_slug, 'customer', 'active', jsonb_build_object('source','highlevel_marketplace'))
    on conflict (slug) do update set updated_at = now()
    returning id into v_org_id;
  end if;

  insert into platform.highlevel_agencies(
    organization_id, company_id, company_name, status, metadata
  ) values (
    v_org_id, p_company_id, nullif(btrim(p_company_name), ''), 'active',
    jsonb_build_object('source','highlevel_marketplace')
  )
  on conflict (organization_id, company_id) do update
    set company_name = coalesce(excluded.company_name, platform.highlevel_agencies.company_name),
        status = 'active', updated_at = now()
  returning id into v_agency_id;

  if p_user_type = 'Location' then
    insert into platform.locations(
      organization_id, agency_id, ghl_location_id, display_name, status, metadata
    ) values (
      v_org_id, v_agency_id, p_location_id,
      coalesce(nullif(btrim(p_location_name), ''), 'HighLevel Location ' || left(p_location_id, 8)),
      'active', jsonb_build_object('source','highlevel_marketplace')
    )
    on conflict (ghl_location_id) do update
      set organization_id = excluded.organization_id,
          agency_id = excluded.agency_id,
          display_name = case when excluded.display_name like 'HighLevel Location %'
                              then platform.locations.display_name else excluded.display_name end,
          status = 'active', updated_at = now()
    returning id into v_location_uuid;
  end if;

  if p_user_type = 'Location' then
    select id into v_install_id
    from platform.app_installations
    where marketplace_app_id = v_app.id
      and highlevel_location_id = p_location_id
      and status <> 'uninstalled'
    order by created_at desc limit 1;
  else
    select id into v_install_id
    from platform.app_installations
    where marketplace_app_id = v_app.id
      and highlevel_company_id = p_company_id
      and highlevel_location_id is null
      and status <> 'uninstalled'
    order by created_at desc limit 1;
  end if;

  if v_install_id is null then
    insert into platform.app_installations(
      marketplace_app_id, organization_id, agency_id, location_id,
      install_type, highlevel_company_id, highlevel_location_id,
      highlevel_user_id, status, metadata
    ) values (
      v_app.id, v_org_id, v_agency_id, v_location_uuid,
      p_user_type, p_company_id, case when p_user_type='Location' then p_location_id else null end,
      p_user_id, 'active', coalesce(p_metadata,'{}'::jsonb) || jsonb_build_object('planId',p_plan_id)
    ) returning id into v_install_id;
  else
    update platform.app_installations
       set organization_id = v_org_id,
           agency_id = v_agency_id,
           location_id = coalesce(v_location_uuid, location_id),
           highlevel_user_id = coalesce(p_user_id, highlevel_user_id),
           status = 'active', uninstalled_at = null, last_seen_at = now(),
           metadata = metadata || coalesce(p_metadata,'{}'::jsonb) || jsonb_build_object('planId',p_plan_id),
           updated_at = now()
     where id = v_install_id;
  end if;

  select public.store_oauth_secret(
    (select access_token_secret_id from platform.oauth_installations where installation_id=v_install_id),
    p_access_token,
    'ripple-public-access-' || v_install_id::text
  ) into v_access_secret;

  if p_refresh_token is not null and btrim(p_refresh_token) <> '' then
    select public.store_oauth_secret(
      (select refresh_token_secret_id from platform.oauth_installations where installation_id=v_install_id),
      p_refresh_token,
      'ripple-public-refresh-' || v_install_id::text
    ) into v_refresh_secret;
  else
    select refresh_token_secret_id into v_refresh_secret
    from platform.oauth_installations where installation_id=v_install_id;
  end if;

  insert into platform.oauth_installations(
    installation_id, user_type, access_token_secret_id, refresh_token_secret_id,
    expires_at, scopes, refresh_failures, last_refreshed_at, updated_at
  ) values (
    v_install_id, p_user_type, v_access_secret, v_refresh_secret,
    p_expires_at, p_scopes, 0, now(), now()
  )
  on conflict (installation_id) do update
    set user_type=excluded.user_type,
        access_token_secret_id=excluded.access_token_secret_id,
        refresh_token_secret_id=coalesce(excluded.refresh_token_secret_id, platform.oauth_installations.refresh_token_secret_id),
        expires_at=excluded.expires_at,
        scopes=excluded.scopes,
        refresh_failures=0,
        last_refresh_error=null,
        last_refreshed_at=now(),
        updated_at=now();

  insert into platform.oauth_install_audit(
    marketplace_app_id, organization_id, installation_id, event,
    user_type, company_id, location_id, detail
  ) values (
    v_app.id, v_org_id, v_install_id, 'oauth_connected',
    p_user_type, p_company_id, p_location_id,
    jsonb_build_object('planId',p_plan_id,'scopes',p_scopes)
  );

  return jsonb_build_object(
    'organization_id', v_org_id,
    'agency_id', v_agency_id,
    'location_uuid', v_location_uuid,
    'installation_id', v_install_id,
    'user_type', p_user_type,
    'company_id', p_company_id,
    'location_id', p_location_id
  );
end;
$$;

revoke all on function public.platform_record_public_install(text,text,text,text,text,text,timestamptz,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.platform_record_public_install(text,text,text,text,text,text,timestamptz,text,text,text,text,jsonb) to service_role;