-- 0028_set_prize_weights.sql
--
-- Why this exists: config carries only a SELECT policy (config_tenant_read),
-- so no browser session can update prize_weights directly, and
-- admin-operations.setPrizeWeights sits behind is_super_admin() - a franchise
-- owner gets a 403 from it. The owner portal needs a write path of its own.
--
-- Shape follows decide_send(): a security-definer RPC the browser calls with
-- the user's JWT. Unlike decide_send, this one checks who is asking.

create or replace function public.set_prize_weights(
  p_location_id text,
  p_weights     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member boolean;
  v_item   jsonb;
  v_idx    int;
  v_seen   int[] := '{}';
  v_total  numeric := 0;
begin
  -- ── Authorisation ───────────────────────────────────────────────────────
  select exists (
    select 1 from tenant_users tu
     where tu.user_id     = auth.uid()
       and tu.location_id = p_location_id
       and tu.role in ('owner', 'admin')
  ) into v_member;

  if not (v_member or is_super_admin()) then
    raise exception 'not authorised for location %', p_location_id
      using errcode = '42501';
  end if;

  -- ── Shape ───────────────────────────────────────────────────────────────
  if p_weights is null or jsonb_typeof(p_weights) <> 'array' then
    raise exception 'prize_weights must be a JSON array';
  end if;
  if jsonb_array_length(p_weights) > 12 then
    raise exception 'at most 12 prizes';
  end if;

  for v_item in select * from jsonb_array_elements(p_weights) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'each prize must be an object';
    end if;
    if coalesce(v_item ->> 'label', '') = '' then
      raise exception 'every prize needs a label';
    end if;
    if (v_item ->> 'idx') is null then
      raise exception 'every prize needs an idx';
    end if;

    v_idx := (v_item ->> 'idx')::int;
    if v_idx < 0 then
      raise exception 'idx must be zero or more';
    end if;

    -- idx is the prize's identity for the life of the client: prize_visits
    -- rows point at it and caps are counted by it. Reusing a number silently
    -- reassigns what a past claimant won, which is why this is enforced in the
    -- database rather than left to whichever editor happens to be calling.
    if v_idx = any (v_seen) then
      raise exception 'duplicate prize idx %', v_idx;
    end if;
    v_seen := v_seen || v_idx;

    if (v_item ->> 'w') is null or (v_item ->> 'w')::numeric < 0 then
      raise exception 'weight must be zero or more';
    end if;
    v_total := v_total + (v_item ->> 'w')::numeric;

    if (v_item ->> 'cap') is not null and (v_item ->> 'cap')::int < 1 then
      raise exception 'cap must be 1 or more, or null for no cap';
    end if;
  end loop;

  if jsonb_array_length(p_weights) > 0 and v_total <= 0 then
    raise exception 'at least one prize needs a weight above zero';
  end if;

  -- ── Write ───────────────────────────────────────────────────────────────
  update config
     set prize_weights = p_weights
   where location_id = p_location_id;

  if not found then
    raise exception 'unknown location %', p_location_id;
  end if;

  return p_weights;
end $$;

revoke all     on function public.set_prize_weights(text, jsonb) from public, anon;
grant  execute on function public.set_prize_weights(text, jsonb) to authenticated;

comment on function public.set_prize_weights(text, jsonb) is
  'Owner-portal write path for config.prize_weights. Checks tenant_users membership (owner|admin) or is_super_admin, validates shape, and rejects duplicate idx.';
