/**
 * provision-thanksio — create a thanks.io sub-account for a Ripple location.
 *
 * Trigger points (both end up here, so there is one implementation):
 *   1. Install — the n8n connect-callback calls this after the token store
 *      succeeds, using the x-ripple-secret header.
 *   2. Super Admin — the console calls it with the caller's JWT, for backfill
 *      or a retry when provisioning failed at install time.
 *
 * The sub-account title carries the location_id, e.g.
 *   "Mosquito Authority — Cary [WzwhUvsDxq3KOUJqAjmJ]"
 * That is the idempotency key: before creating anything this lists the agency's
 * sub-accounts and matches on the id in brackets. A reinstall, a webhook retry
 * and an admin click therefore cannot produce three sub-accounts — and three
 * sub-accounts would mean three lots of billing for one franchise.
 *
 * Auth: x-ripple-secret (machine callers) OR a super-admin Supabase JWT.
 * Deploy: supabase functions deploy provision-thanksio --no-verify-jwt
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const CALLER_SECRET = Deno.env.get('RIPPLE_CALLER_SECRET') || '';

const THANKSIO = 'https://api.thanks.io/api/v2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-ripple-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

/** The location_id embedded in a sub-account title, or null. */
function idFromTitle(title: string): string | null {
  const m = /\[([^\]]+)\]\s*$/.exec(String(title || ''));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// HighLevel: the sub-account's own name and address become the return address
// printed on every postcard, so it is worth fetching rather than guessing.
// Requires locations.readonly, which is already in the install scopes.
// ---------------------------------------------------------------------------
async function getLocationDetails(locationId: string, admin: any) {
  const { data: rows } = await admin
    .from('oauth_tokens')
    .select('provider, access_token_secret_id, status, expires_at')
    .eq('location_id', locationId)
    .order('updated_at', { ascending: false });

  const row = (rows || []).find((r: any) =>
    r.access_token_secret_id && String(r.provider || '').toLowerCase() !== 'thanksio');
  if (!row) return null;

  const { data: token } = await admin.rpc('read_oauth_secret', { p_secret_id: row.access_token_secret_id });
  if (!token) return null;

  const res = await fetch('https://services.leadconnectorhq.com/locations/' + encodeURIComponent(locationId), {
    headers: {
      Authorization: 'Bearer ' + token,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
  });
  if (!res.ok) return null;

  const body = await res.json().catch(() => ({}));
  const l = body?.location ?? body ?? {};
  return {
    name: l.name || l.businessName || null,
    address: l.address || l.address1 || null,
    city: l.city || null,
    state: l.state || null,
    postalCode: l.postalCode || l.postal_code || l.zip || null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // --- Auth: machine secret, or a super-admin session --------------------
  const secret = req.headers.get('x-ripple-secret') || '';
  let authorized = !!CALLER_SECRET && secret === CALLER_SECRET;

  if (!authorized) {
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    if (!token) return json({ error: 'missing auth' }, 401);
    const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: u } = await asCaller.auth.getUser();
    if (!u?.user) return json({ error: 'invalid session' }, 401);
    const { data: me } = await admin
      .from('app_users').select('is_super_admin').eq('id', u.user.id).single();
    if (!me?.is_super_admin) return json({ error: 'not a super admin' }, 403);
    authorized = true;
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const locationId = body.locationId || body.location_id;
  if (!locationId) return json({ error: 'locationId required' }, 400);

  try {
    // --- The config row must exist (OAuth creates it) -------------------
    const { data: cfg, error: cfgErr } = await admin
      .from('config')
      .select('location_id, client_name, thanksio_subaccount_id')
      .eq('location_id', locationId)
      .maybeSingle();
    if (cfgErr) throw cfgErr;
    if (!cfg) return json({ error: 'no config row for that location — has the install finished?' }, 404);

    // --- Already provisioned? -------------------------------------------
    if (cfg.thanksio_subaccount_id) {
      return json({
        ok: true,
        created: false,
        reason: 'already provisioned',
        subAccountId: cfg.thanksio_subaccount_id,
      });
    }

    const apiToken = await admin.rpc('read_thanksio_token').then((r: any) => r.data).catch(() => null);
    if (!apiToken) {
      return json({ error: 'thanks.io agency token is not configured (set_thanksio_token)' }, 500);
    }
    const thanksHeaders = {
      Authorization: 'Bearer ' + apiToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    // --- Idempotency: does one already exist for this location? ---------
    // Covers the case where a previous run created the sub-account but died
    // before writing the id back — otherwise every retry bills a new account.
    const listRes = await fetch(THANKSIO + '/sub-accounts/', { headers: thanksHeaders });
    if (listRes.ok) {
      const listBody = await listRes.json().catch(() => ({}));
      const existing = (listBody?.data ?? listBody?.sub_accounts ?? (Array.isArray(listBody) ? listBody : []))
        .find((s: any) => idFromTitle(s?.title) === locationId);
      if (existing?.id) {
        await admin.from('config')
          .update({ thanksio_subaccount_id: String(existing.id) })
          .eq('location_id', locationId);
        return json({
          ok: true,
          created: false,
          reason: 'adopted an existing sub-account with this location id',
          subAccountId: String(existing.id),
        });
      }
    }

    // --- Build the sub-account from the HighLevel location ---------------
    const details = await getLocationDetails(locationId, admin);
    const name = details?.name || cfg.client_name || locationId;

    const payload: Record<string, string> = {
      title: `${name} [${locationId}]`,
    };
    if (details?.name) payload.return_name = details.name;
    if (details?.address) payload.return_address = details.address;
    if (details?.city) payload.return_city = details.city;
    if (details?.state) payload.return_state = details.state;
    if (details?.postalCode) payload.return_postal_code = details.postalCode;

    const createRes = await fetch(THANKSIO + '/sub-accounts/', {
      method: 'POST',
      headers: thanksHeaders,
      body: JSON.stringify(payload),
    });
    const created = await createRes.json().catch(() => ({}));

    if (createRes.status === 403) {
      return json({
        error: 'thanks.io refused the request. Sub-accounts require the Business tier on the agency account.',
      }, 403);
    }
    if (!createRes.ok || !created?.id) {
      return json({
        error: 'thanks.io returned ' + createRes.status + ': ' + (created?.message || 'no sub-account id in response'),
      }, 502);
    }

    // --- Persist ---------------------------------------------------------
    const { error: upErr } = await admin
      .from('config')
      .update({ thanksio_subaccount_id: String(created.id) })
      .eq('location_id', locationId);
    if (upErr) {
      // The sub-account exists but the id did not save. Say so loudly: the
      // title carries the location id, so the next run will adopt it rather
      // than create a duplicate.
      return json({
        error: 'Created thanks.io sub-account ' + created.id + ' but failed to save it: ' + upErr.message,
        subAccountId: String(created.id),
      }, 500);
    }

    return json({
      ok: true,
      created: true,
      subAccountId: String(created.id),
      title: payload.title,
      // Null when the HighLevel lookup failed (expired token, missing scope).
      // The sub-account still works; the return address just needs filling in.
      returnAddress: details?.address ? {
        name: payload.return_name, address: payload.return_address,
        city: payload.return_city, state: payload.return_state,
        postal_code: payload.return_postal_code,
      } : null,
    });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
