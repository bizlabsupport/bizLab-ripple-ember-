/**
 * send-postcards — the core Ripple send pipeline (Stage 4 / WF1).
 *
 * Called once per completed job (by n8n, which just forwards the trigger).
 * All the high-volume work happens here as code, so one job = one n8n
 * execution regardless of how many neighbours get mailed.
 *
 * Pipeline:
 *   1. can_send() gate            — fail closed
 *   2. daily throttle check
 *   3. insert job (idempotent)
 *   4. radius search              — nearest neighbours
 *   5. hash every candidate
 *   6. check_suppression()        — the four checks
 *   7. roll prizes, sign QR payloads
 *   8. sendPostcard()             — one call, per-recipient dynamic QR
 *   9. insert mailed rows         — idempotent
 *
 * Auth: expects a shared secret header so only n8n (or an authorised caller)
 * can invoke it.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { radiusSearch, getRecipientsWithRetry, sendPostcard, ThanksIoError } from '../_shared/thanksio.ts';
import { addressHash } from '../_shared/address.ts';
import { buildQrPayload } from '../_shared/qrsign.ts';

interface JobRequest {
  locationId: string;
  ghlJobId: string;
  ghlContactId?: string;
  serviceAddress: string;
  city?: string;
  region?: string;
  postalCode: string;
  jobValue?: number;
  preview?: boolean;         // true = render proofs, spend nothing
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CALLER_SECRET = Deno.env.get('RIPPLE_CALLER_SECRET')!;
const LANDING_BASE_ENV = Deno.env.get('RIPPLE_LANDING_BASE') ?? 'https://ripple.example/r';

const db = createClient(SUPABASE_URL, SERVICE_ROLE);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Weighted prize roll from config.prize_weights: [{idx, w}, ...]. */
function rollPrize(weights: Array<{ idx: number; w: number }>): number {
  if (!weights?.length) return 0;
  const total = weights.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const x of weights) {
    r -= x.w;
    if (r <= 0) return x.idx;
  }
  return weights[weights.length - 1].idx;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (req.headers.get('x-ripple-secret') !== CALLER_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: JobRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const { locationId, ghlJobId, serviceAddress, postalCode } = body;
  if (!locationId || !ghlJobId || !serviceAddress || !postalCode) {
    return json({ error: 'missing required fields' }, 400);
  }

  try {
    // FieldRoutes-sourced schedule entries are not evidence of completed service.
    // Fail closed before any lookup or postcard charge, even if an external caller
    // invokes the send endpoint directly rather than through drain-queue.
    if (ghlJobId.startsWith('fr:appt:') && !body.preview) {
      const { data: completedJob, error: completedErr } = await db
        .from('jobs').select('id,completed_at')
        .eq('location_id', locationId).eq('ghl_job_id', ghlJobId).maybeSingle();
      if (completedErr) throw new Error('Could not verify service completion');
      if (!completedJob?.completed_at) {
        return json({ skipped: true, reason: 'service_not_completed' }, 200);
      }
      const { data: eligibleQueue, error: queueErr } = await db
        .from('send_queue').select('id,completed_at,status')
        .eq('location_id',locationId).eq('job_id',completedJob.id).maybeSingle();
      if (queueErr) throw new Error('Could not verify mailing eligibility');
      if (!eligibleQueue?.completed_at || !['approved','sending'].includes(eligibleQueue.status)) {
        return json({ skipped: true, reason: 'mailing_not_approved_or_completed' }, 200);
      }
    }

    // -- 1. Gate: fail closed -------------------------------------------------
    const gate = await db.rpc('can_send', { p_location_id: locationId });
    if (gate.error) throw new Error(`can_send failed: ${gate.error.message}`);
    const allowed = gate.data?.[0];
    if (!allowed?.allowed) {
      return json({ skipped: true, reason: allowed?.reason ?? 'not allowed' }, 200);
    }

    // -- 2. Config + throttle -------------------------------------------------
    const cfgRes = await db.from('config').select('*').eq('location_id', locationId).single();
    if (cfgRes.error) throw new Error(`config read failed: ${cfgRes.error.message}`);
    const cfg = cfgRes.data;

    const quotaRes = await db.rpc('remaining_daily_quota', { p_location_id: locationId });
    const quota = quotaRes.data ?? 0;
    if (quota <= 0) {
      return json({ skipped: true, reason: 'daily throttle reached' }, 200);
    }

    // -- 3. Insert job (idempotent on location_id, ghl_job_id) ---------------
    const svcHash = await addressHash(serviceAddress, postalCode);
    const jobIns = await db.from('jobs').upsert({
      location_id: locationId,
      ghl_job_id: ghlJobId,
      ghl_contact_id: body.ghlContactId ?? null,
      service_address: serviceAddress,
      city: body.city ?? null,
      region: body.region ?? null,
      postal_code: postalCode,
      addr_hash: svcHash,
      job_value: body.jobValue ?? null,
      completed_at: new Date().toISOString(),
    }, { onConflict: 'location_id,ghl_job_id' }).select('id').single();
    if (jobIns.error) throw new Error(`job insert failed: ${jobIns.error.message}`);
    const jobId = jobIns.data.id;

    // The service address itself is a customer address — cache it for future
    // suppression, so we never mail this household for another client's job.
    if (svcHash) {
      await db.from('client_addresses').upsert({
        location_id: locationId, addr_hash: svcHash,
        ghl_contact_id: body.ghlContactId ?? null, source: 'job',
        last_job_at: new Date().toISOString(),
      }, { onConflict: 'location_id,addr_hash' });
    }

    // -- Thanks.io token ------------------------------------------------------
    const tok = await db.rpc('read_thanksio_token');  // helper added in migration
    const thanksToken = tok.data;
    if (!thanksToken) throw new Error('no thanks.io token configured');

    // -- 4. Radius search -----------------------------------------------------
    const recordCount = Math.min(cfg.radius_count ?? 25, quota);
    const search = await radiusSearch(thanksToken, {
      address: serviceAddress,
      postalCode,
      recordCount,
      includeCondos: false,          // apartments excluded — target homeowners
      includeSearchAddress: false,   // don't mail the customer we just served
      subAccount: cfg.thanksio_subaccount_id ? Number(cfg.thanksio_subaccount_id) : undefined,
    });
    if (search.failure) throw new Error(`radius search failed: ${search.message}`);

    // Radius search populates the list asynchronously; poll until it fills.
    const candidates = await getRecipientsWithRetry(thanksToken, search.mailingListId);
    if (!candidates.length) {
      return json({ jobId, mailed: 0, reason: 'no neighbours returned' }, 200);
    }

    // -- 5. Hash candidates ---------------------------------------------------
    const hashed = [];
    for (const c of candidates) {
      const h = await addressHash(c.address, c.postal_code);
      if (h) hashed.push({ ...c, addr_hash: h });
    }

    // -- 6. Suppression -------------------------------------------------------
    const hashes = hashed.map((h) => h.addr_hash);
    const supp = await db.rpc('check_suppression', {
      p_location_id: locationId, p_addr_hashes: hashes,
    });
    if (supp.error) throw new Error(`suppression failed: ${supp.error.message}`);
    const verdict = new Map<string, string>();
    for (const row of supp.data ?? []) verdict.set(row.addr_hash, row.reason);

    const mailable = hashed.filter((h) => verdict.get(h.addr_hash) === 'ok');
    const dropped = hashed.length - mailable.length;

    if (!mailable.length) {
      return json({ jobId, mailed: 0, dropped, reason: 'all candidates suppressed' }, 200);
    }

    // -- 7. Roll prizes + sign QR payloads ------------------------------------
    const batch = `${jobId}`;
    const weights = (cfg.prize_weights ?? []) as Array<{ idx: number; w: number }>;
    const sendRecipients = [];
    const mailedRows = [];
    for (const m of mailable.slice(0, quota)) {
      const prize = rollPrize(weights);
      const payload = await buildQrPayload(cfg.hmac_secret, {
        batch, addr: m.addr_hash, prize,
      });
      sendRecipients.push({
        name: m.name ?? 'Neighbor',
        address: m.address,
        city: m.city,
        province: m.province,
        postal_code: m.postal_code,
        custom1: payload,          // read by the dynamic qrcode_url template
      });
      mailedRows.push({
        location_id: locationId, job_id: jobId, addr_hash: m.addr_hash,
        address: m.address, city: m.city ?? null, region: m.province ?? null,
        postal_code: m.postal_code ?? null, prize_idx: prize,
        status: 'pending',
      });
    }

    // -- 8. Send (one call, per-recipient dynamic QR) -------------------------
    const send = await sendPostcard(thanksToken, {
      recipients: sendRecipients,
      message: cfg.message_template ?? 'Hi %FIRST_NAME%, we were just working on your street!',
      size: '4x6',
      imageTemplateId: cfg.thanksio_template_id ? Number(cfg.thanksio_template_id) : undefined,
      handwritingRealism: true,
      qrcodeUrl: `${(cfg.landing_base_url || LANDING_BASE_ENV)}?~CUSTOM1~`,
      subAccount: cfg.thanksio_subaccount_id ? Number(cfg.thanksio_subaccount_id) : undefined,
      preview: body.preview ?? false,
    });

    // -- 9. Record mailed rows (idempotent) -----------------------------------
    // Stamp the order id so webhooks can match back.
    for (const row of mailedRows) {
      (row as any).thanksio_order_id = send.orderId ? String(send.orderId) : null;
    }
    const ins = await db.from('mailed').upsert(mailedRows, {
      onConflict: 'location_id,job_id,addr_hash', ignoreDuplicates: true,
    });
    if (ins.error) throw new Error(`mailed insert failed: ${ins.error.message}`);

    return json({
      jobId,
      preview: send.preview,
      previewUrl: send.previewUrl,
      candidates: hashed.length,
      dropped,
      mailed: mailedRows.length,
      orderId: send.orderId,
    }, 200);
  } catch (err) {
    const e = err as ThanksIoError;
    return json({
      error: e.message,
      retryable: e.retryable ?? false,
    }, e.status && e.status < 500 ? 400 : 500);
  }
});
