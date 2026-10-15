/**
 * admin-operations — privileged super-admin actions for the Ripple console.
 *
 * The browser holds only the anon key, which (correctly) can't create auth
 * users, set passwords, or bypass RLS. Those operations happen here, behind a
 * check that the CALLER is a verified super admin.
 *
 * Modeled on the Get A PRO admin-operations function, re-scoped to Ripple:
 *   tenant  = one HighLevel location (config.location_id)
 *   users   = app_users (+ auth.users), linked via tenant_users
 *
 * Actions:
 *   listLocations        - all franchises + team counts + delivery setup
 *   updateLocation       - edit config fields (name, plan/status, delivery setup)
 *   listTeam             - members of a location
 *   addTeamMember        - create auth user WITH password, link to location
 *   removeTeamMember     - unlink a user from a location
 *   resetPassword        - set a user's password directly (no email)
 *   setPrizeWeights      - write config.prize_weights for a location
 *   startInstall         - mint CSRF state + HighLevel authorize URL
 *   listCalendars        - v11: HighLevel calendars for the booking dropdown
 *   getPlatformSettings  - v11: platform defaults (landing_base_url)
 *   setPlatformSettings  - v11: write platform defaults
 *
 * Auth: caller must send their Supabase access token; we verify is_super_admin.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// HighLevel's public booking widget link, derived from the calendar id.
const BOOKING_BASE = 'https://api.leadconnectorhq.com/widget/booking/';
const isHttps = (v: unknown) => /^https:\/\/\S+$/i.test(String(v ?? '').trim());

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function randomPassword(len = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join('');
}

/** An error the console can attach to a specific input. */
class FieldError extends Error {
  field: string;
  status: number;
  constructor(message: string, field: string, status = 400) {
    super(message);
    this.field = field;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// HighLevel token accessor
// ---------------------------------------------------------------------------
// Tokens are NOT stored as text. oauth_tokens holds access_token_secret_id, a
// uuid pointing into Vault, and read_oauth_secret() decrypts it — the same path
// the n8n workflows use. Never select a token column directly; there isn't one.
async function readOauthSecret(secretId: string, admin: any): Promise<string> {
  // Signature confirmed: read_oauth_secret(p_secret_id uuid) returns the
  // decrypted token. Vault decryption stays server-side.
  const { data, error } = await admin.rpc('read_oauth_secret', { p_secret_id: secretId });
  if (error) throw new Error('read_oauth_secret failed: ' + error.message);
  if (!data) throw new Error('read_oauth_secret returned nothing for ' + secretId + ' — the Vault secret may have been rotated or deleted.');
  return typeof data === 'string' ? data : String(data);
}

async function getGhlToken(locationId: string, admin: any) {
  const { data: rows, error } = await admin
    .from('oauth_tokens')
    .select('provider, location_id, user_type, access_token_secret_id, expires_at, status, scopes, updated_at')
    .eq('location_id', locationId)
    .order('updated_at', { ascending: false });

  if (error) throw new Error('Could not read the HighLevel token: ' + error.message);

  // One location can carry more than one provider row; take the HighLevel one.
  const row = (rows || []).find((r: any) =>
    r.access_token_secret_id && String(r.provider || '').toLowerCase() !== 'thanksio');

  if (!row) {
    throw new Error('This location has no HighLevel token yet. Reinstall the Ripple app on that sub-account.');
  }
  if (row.status && !['active', 'ok', 'valid'].includes(String(row.status).toLowerCase())) {
    throw new Error('The HighLevel install for this location is ' + row.status + '. Reinstall to continue.');
  }

  // scopes records what this install actually granted. Catching a missing scope
  // here gives a precise answer instead of an opaque 401 from HighLevel.
  if (row.scopes && !String(row.scopes).includes('calendars.readonly')) {
    throw new Error(
      'This install was authorized without calendars.readonly. Enable the scope on the marketplace app, ' +
      'then reinstall Ripple on this sub-account to re-grant it.',
    );
  }

  const token = await readOauthSecret(row.access_token_secret_id, admin);
  const expired = row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false;
  return { token, expired, expiresAt: row.expires_at as string | null };
}

// ---------------------------------------------------------------------------
// thanks.io agency token — read_thanksio_token() is the helper that pairs with
// set_thanksio_token(). Returning null means "skip validation" rather than
// blocking setup; a bad sub-account id would surface on the first send anyway.
// ---------------------------------------------------------------------------
async function getThanksioToken(admin: any): Promise<string | null> {
  const { data, error } = await admin.rpc('read_thanksio_token');
  if (!error && data) {
    return typeof data === 'string' ? data : (data?.token ?? data?.thanksio_token ?? null);
  }
  return Deno.env.get('THANKSIO_TOKEN') || null;
}

// ---------------------------------------------------------------------------
// HighLevel: list the calendars in a location.
// Scope: calendars.readonly (already requested in startInstall — it must also
// be enabled on the marketplace app, and an install predating it needs reauth).
// ---------------------------------------------------------------------------
async function fetchCalendars(locationId: string, admin: any) {
  const { token, expired } = await getGhlToken(locationId, admin);

  const res = await fetch(
    'https://services.leadconnectorhq.com/calendars/?locationId=' + encodeURIComponent(locationId),
    {
      headers: {
        Authorization: 'Bearer ' + token,
        Version: '2021-04-15',
        Accept: 'application/json',
      },
    },
  );

  const body = await res.json().catch(() => ({}));

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      expired
        ? 'The HighLevel access token for this location has expired. The refresh cron (WF0) renews it — ' +
          'run that, then try again.'
        : 'HighLevel refused the request (' + res.status + '). The calendars.readonly scope is either not ' +
          'enabled on the marketplace app, or this install predates it and needs reauthorizing.',
    );
  }
  if (!res.ok) {
    throw new Error('HighLevel returned ' + res.status + ': ' + (body?.message || 'unknown error'));
  }

  const raw = body?.calendars ?? body?.data ?? (Array.isArray(body) ? body : []);
  return (raw as any[])
    .filter((c) => c && (c.id || c._id))
    .map((c) => ({
      id: c.id || c._id,
      name: c.name || c.calendarName || c.slug || (c.id || c._id),
      active: c.isActive !== false,
    }));
}

// ---------------------------------------------------------------------------
// Normalise + validate the four delivery-setup fields before they are written.
// ---------------------------------------------------------------------------
async function prepareDeliveryUpdates(locationId: string, updates: any, allowed: Record<string, unknown>, admin: any) {
  // -- landing_url ---------------------------------------------------------
  if ('landing_url' in updates) {
    const v = String(updates.landing_url ?? '').trim();
    if (v && !isHttps(v)) {
      throw new FieldError('The landing page must be a full https:// address', 'landing_url');
    }
    allowed.landing_url = v || null;
  }

  // -- ghl_calendar_id -----------------------------------------------------
  // The dropdown is a convenience, not the authorization check: confirm the
  // calendar really belongs to this location before pointing a claim flow at it.
  if ('ghl_calendar_id' in updates) {
    const calId = String(updates.ghl_calendar_id ?? '').trim();
    if (calId) {
      const calendars = await fetchCalendars(locationId, admin);
      if (!calendars.some((c) => c.id === calId)) {
        throw new FieldError('That calendar does not belong to this HighLevel location.', 'ghl_calendar_id');
      }
      allowed.ghl_calendar_id = calId;

      const derived = BOOKING_BASE + calId;
      const supplied = String(updates.booking_url ?? '').trim();
      if (supplied && !isHttps(supplied)) {
        throw new FieldError('The booking link must be a full https:// address', 'ghl_calendar_id');
      }
      allowed.booking_url = supplied && supplied !== derived ? supplied : derived;
    } else {
      allowed.ghl_calendar_id = null;
      const supplied = String(updates.booking_url ?? '').trim();
      allowed.booking_url = supplied || null;
    }
  }

  // -- thanksio_subaccount_id ---------------------------------------------
  if ('thanksio_subaccount_id' in updates) {
    const id = String(updates.thanksio_subaccount_id ?? '').trim();
    if (id) {
      const token = await getThanksioToken(admin);
      if (token) {
        const res = await fetch('https://api.thanks.io/api/v2/sub-accounts/' + encodeURIComponent(id), {
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        });
        if (res.status === 404) {
          throw new FieldError('No thanks.io sub-account with that ID.', 'thanksio_subaccount_id');
        }
        if (!res.ok) {
          throw new FieldError(
            'thanks.io could not confirm that sub-account (' + res.status + '). Check the ID and try again.',
            'thanksio_subaccount_id',
          );
        }
      }
      allowed.thanksio_subaccount_id = id;
    } else {
      allowed.thanksio_subaccount_id = null;
    }
  }

  // -- booking_page_url ----------------------------------------------------
  // Per-client override of the booking page, same precedence idea as
  // landing_url: null means "use the platform default".
  if ('booking_page_url' in updates) {
    const v = String(updates.booking_page_url ?? '').trim();
    if (v && !isHttps(v)) {
      throw new FieldError('The booking page must be a full https:// address', 'booking_page_url');
    }
    allowed.booking_page_url = v || null;
  }

  // -- ghl_fields ----------------------------------------------------------
  // HighLevel custom field IDs, keyed by Ripple's own field names. The claim
  // handler sends { id, value } pairs, so a wrong or empty id means the value
  // silently never lands on the contact - which is why blanks are dropped
  // rather than stored, and why the id charset is checked here.
  if ('ghl_fields' in updates) {
    const raw = updates.ghl_fields;
    if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
      throw new FieldError('Custom fields must be an object', 'ghl_fields');
    }
    const KEYS = ['source_job', 'prize_code', 'card_id', 'first_touch',
                  'preferred_date', 'preferred_time', 'prize'];
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw || {})) {
      if (!KEYS.includes(k)) {
        throw new FieldError('Unknown custom field: ' + k, 'ghl_fields');
      }
      const id = String(v ?? '').trim();
      if (!id) continue;                     // blank = not mapped, not an error
      // HighLevel ids are alphanumeric. Catching a pasted {{contact.x}} merge
      // KEY here is the whole point: it looks right and never matches.
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
        throw new FieldError(
          'That does not look like a HighLevel field ID (' + k + '). Paste the ID from the ' +
          'custom fields export, not the {{contact...}} key.',
          'ghl_fields',
        );
      }
      clean[k] = id;
    }
    allowed.ghl_fields = clean;
  }

  // -- theme ---------------------------------------------------------------
  // The theme can change how the pages LOOK; it can never change what they do.
  // Claim limits, prize caps and consent wording stay server-side, so this only
  // has to be safe to render.
  if ('theme' in updates) {
    const raw = updates.theme;
    if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
      throw new FieldError('Theme must be an object', 'theme');
    }
    const t = (raw || {}) as Record<string, any>;
    const out: Record<string, unknown> = {};

    if (t.colors && typeof t.colors === 'object') {
      const colors: Record<string, string> = {};
      for (const [k, v] of Object.entries(t.colors)) {
        const hex = String(v ?? '').trim();
        if (!hex) continue;
        if (!/^#[0-9a-fA-F]{3,8}$/.test(hex)) {
          throw new FieldError('Colours must be hex, like #3FA9F5', 'theme');
        }
        colors[k] = hex;
      }
      if (Object.keys(colors).length) out.colors = colors;
    }

    if (t.copy && typeof t.copy === 'object') {
      const copy: Record<string, string> = {};
      for (const [k, v] of Object.entries(t.copy)) {
        // Stripped of <>& and length-capped: client-authored copy is rendered
        // on a page BizLab is responsible for.
        const text = String(v ?? '').replace(/[<>&]/g, '').trim().slice(0, 160);
        if (text) copy[k] = text;
      }
      if (Object.keys(copy).length) out.copy = copy;
    }

    if (t.scratch && typeof t.scratch === 'object') {
      const bg = String(t.scratch.background ?? '').trim();
      if (bg && !['leaves', 'skin', 'grass'].includes(bg)) {
        throw new FieldError('Unknown scratch background', 'theme');
      }
      if (bg) out.scratch = { background: bg };
    }

    if (typeof t.logo === 'string' && t.logo.trim()) {
      if (!isHttps(t.logo.trim())) {
        throw new FieldError('The logo must be a full https:// address', 'theme');
      }
      out.logo = t.logo.trim();
    }

    allowed.theme = out;
  }

  // -- per-client rates ----------------------------------------------------
  // Null means "use the platform rate". The rate is stamped on each card as it
  // sends, so a change here never re-prices cards already in the ground.
  for (const key of ['price_per_card_cents', 'price_per_lookup_cents']) {
    if (key in updates) {
      const v = updates[key];
      if (v === null || v === '') { allowed[key] = null; continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        throw new FieldError('Prices must be a positive whole number of cents', key);
      }
      allowed[key] = n;
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // --- Verify the caller is a super admin -------------------------------
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return json({ error: 'missing auth' }, 401);

  // Client acting AS the caller (anon key + their token) to read their identity.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'invalid session' }, 401);

  // Service-role client for privileged work.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Confirm super admin via app_users (source of truth).
  const { data: me } = await admin
    .from('app_users')
    .select('is_super_admin')
    .eq('id', userData.user.id)
    .single();
  if (!me?.is_super_admin) return json({ error: 'not a super admin' }, 403);

  // --- Dispatch ----------------------------------------------------------
  let body: { action?: string; payload?: any };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const action = body.action;
  const p = body.payload || {};

  try {
    switch (action) {
      // ---- Ember enrollment --------------------------------------------
      // Kept behind the same verified super-admin gate as the Ripple admin
      // operations, but writes exclusively through an Ember-schema RPC.
      case 'createEmberLocation': {
        const locationId = String(p.locationId || '').trim();
        const displayName = String(p.displayName || '').trim();
        const fieldroutesOfficeId = String(p.fieldroutesOfficeId || '').trim();
        const timezone = String(p.timezone || 'America/New_York').trim();
        const ghlLocationId = String(p.ghlLocationId || '').trim() || null;

        if (!locationId || !displayName || !fieldroutesOfficeId) {
          return json({ error: 'Location ID, display name, and FieldRoutes office ID are required.' }, 400);
        }

        const { data, error } = await admin.rpc('ember_enroll_location', {
          p_location_id: locationId,
          p_display_name: displayName,
          p_fieldroutes_office_id: fieldroutesOfficeId,
          p_timezone: timezone,
          p_ghl_location_id: ghlLocationId,
        });
        if (error) {
          const status = error.code === '23505' ? 409 : 400;
          return json({ error: error.message, code: error.code }, status);
        }
        return json({ ok: true, location: data });
      }

      case 'listEmberLocations': {
        const { data, error } = await admin.rpc('ember_admin_list_locations');
        if (error) throw error;
        return json({ ok: true, locations: Array.isArray(data) ? data : [] });
      }

      // ---- Locations ----------------------------------------------------
      case 'listLocations': {
        const { data: locs, error } = await admin
          .from('config')
          .select('location_id, client_name, prize_weights, paused, ' +
                  'thanksio_subaccount_id, thanksio_template_id, ' +
                  'ghl_calendar_id, booking_url, landing_url, ' +
                  'booking_page_url, theme, landing_template, ghl_fields, ' +
                  'price_per_card_cents, price_per_lookup_cents, ' +
                  'billing_ghl_contact_id, beta_billing_enabled, low_balance_alert_cents, ' +
                  'postcard_mode, postcard_brand_key, postcard_creative_id, ' +
                  'postcard_image_template_id, postcard_message_template_id, ' +
                  'address_backfill_completed_at, created_at')
          .not('location_id', 'is', null)
          .neq('location_id', '')
          .not('location_id', 'like', 'company:%')
          .order('created_at', { ascending: true });
        if (error) throw error;

        // team counts per location
        const { data: tu } = await admin
          .from('tenant_users')
          .select('location_id, role');
        const counts: Record<string, { admin: number; viewer: number }> = {};
        for (const row of tu || []) {
          counts[row.location_id] ??= { admin: 0, viewer: 0 };
          if (row.role === 'admin') counts[row.location_id].admin++;
          else counts[row.location_id].viewer++;
        }

        // OAuth health per location, from oauth_tokens (there is no ghl_oauth
        // table — the runbook's Appendix B name never matched the schema).
        // "connected" means HighLevel is linked; it used to be derived from
        // thanksio_subaccount_id, which made every location without a mail
        // account look like a broken token.
        const { data: oauth } = await admin
          .from('oauth_tokens')
          .select('location_id, provider, status, expires_at, scopes')
          .not('location_id', 'is', null);
        const oauthBy: Record<string, any> = {};
        for (const row of oauth || []) {
          if (String(row.provider || '').toLowerCase() === 'thanksio') continue;
          oauthBy[row.location_id] = row;
        }

        const locations = (locs || []).map((l: any) => {
          const o = oauthBy[l.location_id];
          const live = !!o && ['active', 'ok', 'valid'].includes(String(o.status || '').toLowerCase());
          return {
            ...l,
            connected: live,
            tokenExpires: o?.expires_at || null,
            calendarScope: !!o?.scopes && String(o.scopes).includes('calendars.readonly'),
            mailReady: !!l.thanksio_subaccount_id,
            backfilled: !!l.address_backfill_completed_at,
            teamCounts: counts[l.location_id] || { admin: 0, viewer: 0 },
          };
        });
        return json({ locations });
      }

      case 'updateLocation': {
        const { locationId, updates } = p;
        if (!locationId) return json({ error: 'locationId required' }, 400);
        if (!updates || typeof updates !== 'object') {
          return json({ error: 'updates object required' }, 400);
        }

        const SIMPLE = ['client_name', 'paused', 'booking_url',
                        'radius_count', 'suppression_days', 'daily_throttle',
                        'report_emails'];
        // Handled by prepareDeliveryUpdates, which validates and normalises.
        const VALIDATED = ['landing_url', 'ghl_calendar_id', 'thanksio_subaccount_id',
                           'booking_page_url', 'ghl_fields', 'theme',
                           'price_per_card_cents', 'price_per_lookup_cents',
                           'billing_ghl_contact_id', 'beta_billing_enabled', 'low_balance_alert_cents',
                           'postcard_mode', 'postcard_brand_key', 'postcard_creative_id',
                           'postcard_image_template_id', 'postcard_message_template_id'];

        // Anything not recognised used to be dropped in silence, so the panel
        // reported a successful save and the value was simply gone on reload.
        // A save that discards half its payload is worse than one that fails.
        const unknown = Object.keys(updates).filter(
          (k) => !SIMPLE.includes(k) && !VALIDATED.includes(k));
        if (unknown.length) {
          return json({
            error: 'These fields cannot be saved here: ' + unknown.join(', '),
            field: unknown[0],
          }, 400);
        }

        const allowed: Record<string, unknown> = {};
        for (const k of SIMPLE) {
          if (k in updates) allowed[k] = updates[k];
        }

        // v11 delivery setup: validated + normalised, and it owns booking_url
        // whenever a calendar is supplied (so the derived link can't drift).
        await prepareDeliveryUpdates(locationId, updates, allowed, admin);

        // Beta wallet and saved postcard Creative are first-class location settings.
        if ('billing_ghl_contact_id' in updates) {
          const v=String(updates.billing_ghl_contact_id??'').trim();
          if(v&&!/^[A-Za-z0-9_-]{8,80}$/.test(v))throw new FieldError('Invalid HighLevel billing contact ID', 'billing_ghl_contact_id');
          allowed.billing_ghl_contact_id=v||null;
        }
        if ('beta_billing_enabled' in updates) {
          if(typeof updates.beta_billing_enabled!=='boolean')throw new FieldError('Wallet enabled must be true or false', 'beta_billing_enabled');
          allowed.beta_billing_enabled=updates.beta_billing_enabled;
        }
        if ('low_balance_alert_cents' in updates) {
          const n=Number(updates.low_balance_alert_cents);
          if(!Number.isInteger(n)||n<0||n>10000000)throw new FieldError('Invalid low balance alert amount', 'low_balance_alert_cents');
          allowed.low_balance_alert_cents=n;
        }
        if ('postcard_mode' in updates) {
          const v=String(updates.postcard_mode??'').trim();
          if(!['creative','legacy'].includes(v))throw new FieldError('Postcard mode must be creative or legacy', 'postcard_mode');
          allowed.postcard_mode=v;
        }
        if ('postcard_brand_key' in updates) {
          const v=String(updates.postcard_brand_key??'').trim();
          if(v&&!/^[a-z0-9_-]{1,70}$/.test(v))throw new FieldError('Invalid postcard brand key', 'postcard_brand_key');
          allowed.postcard_brand_key=v||null;
        }
        for(const k of ['postcard_creative_id','postcard_image_template_id','postcard_message_template_id']){
          if(k in updates){
            const v=String(updates[k]??'').trim();
            if(v&&!/^[1-9][0-9]{0,11}$/.test(v))throw new FieldError('Invalid postcard template or creative ID',k);
            allowed[k]=v?Number(v):null;
          }
        }
        if (!Object.keys(allowed).length) {
          return json({ error: 'nothing to update' }, 400);
        }

        const { error } = await admin.from('config')
          .update(allowed).eq('location_id', locationId);
        if (error) throw error;
        return json({ ok: true, updated: allowed });
      }

      // ---- v11: HighLevel calendars for the booking dropdown ------------
      case 'listCalendars': {
        const locationId = p.locationId || p.location_id;
        if (!locationId) return json({ error: 'locationId required' }, 400);
        const calendars = await fetchCalendars(locationId, admin);
        return json({ calendars });
      }

      // ---- v11: platform defaults ---------------------------------------
      // platform_settings has RLS on with no policies, so only this
      // service-role function can read or write it.
      case 'getPlatformSettings': {
        const { data, error } = await admin
          .from('platform_settings').select('key, value');
        if (error) throw error;

        const settings: Record<string, string> = {};
        for (const row of data || []) settings[row.key] = row.value;
        if (!settings.landing_base_url) {
          // Show what the send path would actually fall back to.
          settings.landing_base_url = Deno.env.get('RIPPLE_LANDING_BASE') || '';
        }
        return json({ settings });
      }

      case 'setPlatformSettings': {
        const ALLOWED_SETTINGS = ['landing_base_url', 'booking_base_url',
                                  'price_per_card_cents', 'price_per_lookup_cents'];
        const entries = Object.entries(p).filter(([k]) => ALLOWED_SETTINGS.includes(k));
        if (!entries.length) return json({ error: 'no recognised setting to save' }, 400);

        for (const [key, value] of entries) {
          const v = String(value ?? '').trim();
          if ((key === 'landing_base_url' || key === 'booking_base_url') && v && !isHttps(v)) {
            return json({ error: 'That must be a full https:// address', field: key }, 400);
          }
          // Prices are held in cents so nothing rounds on the way through.
          if (key.endsWith('_cents') && v) {
            const n = Number(v);
            if (!Number.isInteger(n) || n <= 0) {
              return json({ error: 'Prices must be a positive whole number of cents', field: key }, 400);
            }
          }
          const { error } = await admin.from('platform_settings')
            .upsert({ key, value: v }, { onConflict: 'key' });
          if (error) throw error;
        }

        const { data } = await admin.from('platform_settings').select('key, value');
        const settings: Record<string, string> = {};
        for (const row of data || []) settings[row.key] = row.value;
        return json({ ok: true, settings });
      }

      case 'setPrizeWeights': {
        const { locationId, prizeWeights } = p;
        if (!locationId) return json({ error: 'locationId required' }, 400);
        if (!Array.isArray(prizeWeights)) {
          return json({ error: 'prizeWeights must be an array' }, 400);
        }

        // Shape read by the landing page and by claim_prize():
        //   { idx, label, sub, code_prefix, w, cap }
        // label/sub are the scratch-card copy; code_prefix seeds the promo code
        // issued at claim; cap is the maximum number of CLAIMS (null = no limit).
        const clean: any[] = [];
        for (const w of prizeWeights) {
          if (typeof w.idx !== 'number' || typeof w.w !== 'number') {
            return json({ error: 'each prize needs numeric idx and w' }, 400);
          }
          if (w.w < 0) return json({ error: 'weights cannot be negative' }, 400);

          const label = String(w.label ?? '').trim();
          if (!label) return json({ error: 'every prize needs a name' }, 400);

          const prefix = String(w.code_prefix ?? '').trim().toUpperCase();
          if (prefix && !/^[A-Z0-9]{2,16}$/.test(prefix)) {
            return json({ error: 'code prefixes must be 2-16 letters or digits: ' + prefix }, 400);
          }

          let cap: number | null = null;
          if (w.cap !== null && w.cap !== undefined && w.cap !== '') {
            cap = Number(w.cap);
            if (!Number.isInteger(cap) || cap < 1) {
              return json({ error: 'caps must be whole numbers of 1 or more, or blank' }, 400);
            }
            // Lowering a cap below what has already gone out would make the
            // stored inventory a lie, so refuse rather than silently accept it.
            const { count } = await admin
              .from('prize_visits')
              .select('id', { count: 'exact', head: true })
              .eq('location_id', locationId)
              .eq('prize_idx', w.idx)
              .not('claimed_at', 'is', null);
            if (typeof count === 'number' && count > cap) {
              return json({
                error: `"${label}" has already been claimed ${count} times — its cap cannot be set below that`,
              }, 400);
            }
          }

          clean.push({
            idx: w.idx,
            label,
            sub: String(w.sub ?? '').trim().slice(0, 160),
            code_prefix: prefix,
            w: w.w,
            cap,
          });
        }

        if (clean.length && clean.reduce((s, x) => s + x.w, 0) <= 0) {
          return json({ error: 'at least one prize needs a weight above zero' }, 400);
        }

        const { error } = await admin.from('config')
          .update({ prize_weights: clean }).eq('location_id', locationId);
        if (error) throw error;
        return json({ ok: true, prizeWeights: clean });
      }

      // ---- Claim counts, so the editor can show what is left ------------
      case 'listPrizeStats': {
        const { locationId } = p;
        if (!locationId) return json({ error: 'locationId required' }, 400);

        const { data, error } = await admin
          .from('prize_visits')
          .select('prize_idx')
          .eq('location_id', locationId)
          .not('claimed_at', 'is', null);
        if (error) throw error;

        const claimed: Record<string, number> = {};
        for (const row of data || []) {
          claimed[row.prize_idx] = (claimed[row.prize_idx] || 0) + 1;
        }
        return json({ claimed });
      }

      // ---- Team ---------------------------------------------------------
      case 'listTeam': {
        const { locationId } = p;
        if (!locationId) return json({ error: 'locationId required' }, 400);
        const { data: links, error } = await admin
          .from('tenant_users')
          .select('user_id, role')
          .eq('location_id', locationId);
        if (error) throw error;
        const ids = (links || []).map((l: any) => l.user_id);
        let usersById: Record<string, any> = {};
        if (ids.length) {
          const { data: us } = await admin
            .from('app_users')
            .select('id, email, display_name')
            .in('id', ids);
          for (const u of us || []) usersById[u.id] = u;
        }
        const team = (links || []).map((l: any) => ({
          user_id: l.user_id,
          role: l.role,
          email: usersById[l.user_id]?.email || '',
          full_name: usersById[l.user_id]?.display_name || '',
        }));
        return json({ team });
      }

      case 'addTeamMember': {
        const { locationId, fullName, email, role, customPassword } = p;
        if (!locationId || !email) {
          return json({ error: 'locationId and email required' }, 400);
        }
        const useRole = role === 'admin' ? 'admin' : 'viewer';
        const password = (customPassword && customPassword.length >= 8)
          ? customPassword : randomPassword();
        const wasAutoGenerated = !(customPassword && customPassword.length >= 8);

        // Does an auth user already exist for this email?
        let userId: string | null = null;
        const { data: existing } = await admin
          .from('app_users').select('id').eq('email', email).maybeSingle();

        if (existing?.id) {
          userId = existing.id;
          // link only; don't reset their password
          const { error: linkErr } = await admin.from('tenant_users')
            .upsert({ user_id: userId, location_id: locationId, role: useRole },
                    { onConflict: 'user_id,location_id' });
          if (linkErr) throw linkErr;
          return json({ ok: true, linked: true, email, password: null });
        }

        // Create the auth user WITH the password, auto-confirmed (no email).
        const { data: created, error: cErr } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { display_name: fullName || '' },
        });
        if (cErr) throw cErr;
        userId = created.user.id;

        // app_users row (not a super admin)
        const { error: auErr } = await admin.from('app_users').insert({
          id: userId, email, display_name: fullName || '', is_super_admin: false,
        });
        if (auErr) throw auErr;

        // link to the location
        const { error: linkErr } = await admin.from('tenant_users')
          .insert({ user_id: userId, location_id: locationId, role: useRole });
        if (linkErr) throw linkErr;

        return json({ ok: true, email, password, wasAutoGenerated });
      }

      case 'removeTeamMember': {
        const { locationId, userId } = p;
        if (!locationId || !userId) {
          return json({ error: 'locationId and userId required' }, 400);
        }
        const { error } = await admin.from('tenant_users')
          .delete().eq('location_id', locationId).eq('user_id', userId);
        if (error) throw error;
        return json({ ok: true });
      }

      case 'resetPassword': {
        const { userId, newPassword } = p;
        if (!userId || !newPassword || newPassword.length < 8) {
          return json({ error: 'userId and newPassword (min 8) required' }, 400);
        }
        const { error } = await admin.auth.admin.updateUserById(userId, {
          password: newPassword,
        });
        if (error) throw error;
        return json({ ok: true });
      }

      // ---- Onboard a new location via HighLevel OAuth install ----------
      case 'startInstall': {
        // A Ripple location only exists because someone installed the app on a
        // HighLevel sub-account. So "add location" doesn't insert a row — it
        // mints a CSRF state and returns the authorize URL. The client
        // authorizes, and the existing connect-callback workflow creates the
        // config row + tokens automatically.
        const { data: secrets, error: sErr } = await admin
          .rpc('get_app_secrets');
        if (sErr) throw sErr;
        const s = Array.isArray(secrets) ? secrets[0] : secrets;
        if (!s?.client_id || !s?.redirect_uri) {
          return json({ error: 'app secrets not configured' }, 500);
        }

        // create a single-use state (CSRF), tagged as an admin-initiated install
        const stateBytes = new Uint8Array(32);
        crypto.getRandomValues(stateBytes);
        const state = btoa(String.fromCharCode(...stateBytes))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        const { error: stErr } = await admin.from('oauth_states').insert({
          state,
          meta: { source: 'admin_console', by: userData.user.email },
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        });
        if (stErr) throw stErr;

        const scopes = [
          'contacts.readonly', 'contacts.write',
          'locations.readonly', 'calendars.readonly',
          'calendars/events.readonly', 'oauth.readonly', 'oauth.write',
        ].join(' ');
        const params = new URLSearchParams({
          response_type: 'code',
          redirect_uri: s.redirect_uri,
          client_id: s.client_id,
          scope: scopes,
          state,
        });
        const url = 'https://marketplace.gohighlevel.com/oauth/chooselocation?'
          + params.toString();
        return json({ ok: true, url });
      }

      default:
        return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (err) {
    // FieldError carries the input to highlight in the console.
    const e = err as any;
    return json({ error: (err as Error).message, field: e?.field }, e?.status || 500);
  }
});
