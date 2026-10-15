import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CLIENT_ID = Deno.env.get('RIPPLE_PUBLIC_CLIENT_ID') || '';
const CLIENT_SECRET = Deno.env.get('RIPPLE_PUBLIC_CLIENT_SECRET') || '';
const REDIRECT_URI = Deno.env.get('RIPPLE_PUBLIC_REDIRECT_URI') ||
  'https://dhizayohljxioxxzkhty.supabase.co/functions/v1/ripple-public-oauth-callback';
const SUCCESS_URL = Deno.env.get('RIPPLE_PUBLIC_SUCCESS_URL') ||
  'https://ripple.bizlabsolutions.ai/locations';

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function text(message: string, status = 200) {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function redirect(url: string) {
  return new Response('Redirecting to Ripple…', {
    status: 302,
    headers: { Location: url, 'content-type': 'text/plain; charset=utf-8' },
  });
}

async function exchangeCode(code: string, userType: 'Location' | 'Company') {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    user_type: userType,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch('https://services.leadconnectorhq.com/oauth/token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Version: 'v3',
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && !!json?.access_token, status: res.status, json };
}

async function exchangeLocationToken(companyToken: string, companyId: string, locationId: string) {
  const body = new URLSearchParams({ companyId, locationId });
  const res = await fetch('https://services.leadconnectorhq.com/oauth/location-token', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${companyToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Version: 'v3',
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && !!json?.access_token, status: res.status, json };
}

async function fetchLocationName(token: string, locationId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/locations/${encodeURIComponent(locationId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        Version: '2021-07-28',
      },
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    const loc = json?.location || json;
    return String(loc?.name || loc?.businessName || '').trim() || null;
  } catch {
    return null;
  }
}

async function recordInstall(token: any, locationName: string | null = null) {
  const expiresAt = new Date(Date.now() + Number(token?.expires_in || 86400) * 1000).toISOString();
  const { data, error } = await db.rpc('platform_record_public_install', {
    p_user_type: token.userType,
    p_company_id: token.companyId,
    p_location_id: token.locationId || null,
    p_user_id: token.userId || null,
    p_access_token: token.access_token,
    p_refresh_token: token.refresh_token || null,
    p_expires_at: expiresAt,
    p_scopes: token.scope || '',
    p_plan_id: token.planId || null,
    p_location_name: locationName,
    p_company_name: null,
    p_metadata: {
      isBulkInstallation: !!token.isBulkInstallation,
      installToFutureLocations: token.installToFutureLocations ?? null,
      approveAllLocations: token.approveAllLocations ?? null,
      approvedLocations: Array.isArray(token.approvedLocations) ? token.approvedLocations : [],
    },
  });
  if (error) throw new Error(`record install failed: ${error.message}`);
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') return text('GET only', 405);

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');

  if (oauthError) return text(`Ripple connection was cancelled or denied: ${oauthError}`, 400);
  if (!code) return text('Missing OAuth authorization code.', 400);
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('[ripple-public-oauth] missing RIPPLE_PUBLIC_CLIENT_ID or RIPPLE_PUBLIC_CLIENT_SECRET');
    return text('Ripple Marketplace OAuth is not fully configured yet.', 503);
  }

  try {
    // Target user is Sub-account. Direct installs normally exchange as Location.
    // Agency bulk installs need Company. A failed type attempt does not yield a token,
    // so we retry once with the other valid HighLevel user type.
    let exchanged = await exchangeCode(code, 'Location');
    if (!exchanged.ok) exchanged = await exchangeCode(code, 'Company');
    if (!exchanged.ok) {
      console.error('[ripple-public-oauth] token exchange failed', exchanged.status, exchanged.json);
      return text('Ripple could not complete the HighLevel connection. Please reinstall the app.', 400);
    }

    const token = exchanged.json;
    const userType = token?.userType;
    if (userType !== 'Location' && userType !== 'Company') {
      console.error('[ripple-public-oauth] unexpected token type', userType);
      return text('HighLevel returned an unsupported installation type.', 400);
    }

    if (userType === 'Location') {
      const locationName = token.locationId
        ? await fetchLocationName(token.access_token, token.locationId)
        : null;
      await recordInstall(token, locationName);
      const dest = new URL(SUCCESS_URL);
      if (token.locationId) dest.searchParams.set('loc', token.locationId);
      dest.searchParams.set('connected', '1');
      return redirect(dest.toString());
    }

    // Agency/bulk install: retain the Company token, then mint one Location token
    // for every location HighLevel says was approved during installation.
    await recordInstall(token, null);

    const approved = Array.isArray(token.approvedLocations)
      ? [...new Set(token.approvedLocations.map((x: unknown) => String(x)).filter(Boolean))]
      : [];

    let connected = 0;
    const failures: Array<{ locationId: string; status: number }> = [];
    for (const locationId of approved) {
      const loc = await exchangeLocationToken(token.access_token, token.companyId, locationId);
      if (!loc.ok) {
        failures.push({ locationId, status: loc.status });
        continue;
      }
      // Some endpoint versions omit companyId/userType; normalize them here.
      const locationToken = {
        ...loc.json,
        userType: 'Location',
        companyId: loc.json.companyId || token.companyId,
        locationId: loc.json.locationId || locationId,
        userId: loc.json.userId || token.userId || null,
      };
      const locationName = await fetchLocationName(locationToken.access_token, locationId);
      await recordInstall(locationToken, locationName);
      connected++;
    }

    if (failures.length) {
      console.warn('[ripple-public-oauth] location token failures', failures);
    }

    const dest = new URL(SUCCESS_URL);
    dest.searchParams.set('connected', '1');
    dest.searchParams.set('bulk', '1');
    dest.searchParams.set('locations', String(connected));
    return redirect(dest.toString());
  } catch (err) {
    console.error('[ripple-public-oauth] fatal', err instanceof Error ? err.message : String(err));
    return text('Ripple could not finish provisioning this installation. Please reinstall the app.', 500);
  }
});
