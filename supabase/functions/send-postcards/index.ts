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

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
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
  cardCount?: number;
  batchId?: string;
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
    // This gate applies to every caller, including direct sends and legacy jobs.
    // Re-check immediately before each paid provider operation as permissions may change mid-run.
    const checkPermission = async () => {
      const {data,error}=await db.rpc('ripple_mailing_permission',{p_location_id:locationId,p_ghl_job_id:ghlJobId});
      if(error)throw new Error('Could not verify Ripple mailing permission');
      return data?.[0];
    };
    const permission=await checkPermission();
    if(!permission?.allowed)return json({skipped:true,held:true,reason:permission?.reason||'mailing_permission_unknown'},200);

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
    // Fail BEFORE a paid address lookup if the mailing design is not configured.
    const creativeId = cfg.postcard_creative_id ? Number(cfg.postcard_creative_id) : undefined;
    const imageId = cfg.postcard_image_template_id ? Number(cfg.postcard_image_template_id) : (cfg.thanksio_template_id ? Number(cfg.thanksio_template_id) : undefined);
    if(!creativeId && !imageId) return json({skipped:true,held:true,reason:'postcard_design_missing'},200);

    const quotaRes = await db.rpc('remaining_daily_quota', { p_location_id: locationId });
    const quota = quotaRes.data ?? 0;
    if (quota <= 0) {
      return json({ skipped: true, reason: 'daily throttle reached' }, 200);
    }

    // -- 3. Resolve existing completed appointment (never rewrite completion) --
    // The previous upsert replaced the verified service timestamp with the
    // mailing runtime and could trigger service_date_mismatch / accidental hold.
    const svcHash = await addressHash(serviceAddress, postalCode);
    const jobResult = await db.from('jobs')
      .select('id,completed_at,service_date,fieldroutes_appointment_id,postal_code')
      .eq('location_id',locationId).eq('ghl_job_id',ghlJobId).maybeSingle();
    if(jobResult.error)throw new Error('Job lookup failed: '+jobResult.error.message);
    if(!jobResult.data?.id||!jobResult.data.completed_at)
      return json({skipped:true,held:true,reason:'completed_job_not_found'},200);
    if(locationId==='Vf9NhVwLyR5P5uzA7ki4' &&
       (!jobResult.data.fieldroutes_appointment_id || !jobResult.data.service_date ||
        new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'})
         .format(new Date(jobResult.data.completed_at))!==jobResult.data.service_date))
      return json({skipped:true,held:true,reason:'fieldroutes_service_not_verified'},200);
    const jobId=jobResult.data.id;

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
    const beforeLookup=await checkPermission();
    if(!beforeLookup?.allowed)return json({skipped:true,held:true,reason:beforeLookup?.reason||'mailing_permission_changed'},200);
    const requestedCount=body.cardCount==null?beforeLookup.approved_cards:Number(body.cardCount);
    if(!Number.isSafeInteger(requestedCount)||requestedCount<1)return json({error:'Invalid card count'},400);
    const recordCount = Math.min(cfg.radius_count ?? 25, quota, beforeLookup.approved_cards, requestedCount);
    // Paid-radius retry checkpoint. For known failed postcard submissions,
    // reuse the purchased Thanks.io list rather than buying the same neighbors.
    const {data:recovery,error:recoveryError}=await db.from('ripple_radius_recovery')
      .select('mailing_list_id,status,order_id')
      .eq('location_id',locationId).eq('batch_id',permission.batch_id).maybeSingle();
    if(recoveryError)throw new Error('Could not read radius recovery checkpoint');
    if(recovery?.status==='used') return json({skipped:true,reason:'recovered_batch_already_sent',orderId:recovery.order_id},200);
    let mailingListId:number;
    if(recovery?.status==='ready'){
      mailingListId=Number(recovery.mailing_list_id);
      if(!Number.isSafeInteger(mailingListId)||mailingListId<=0)throw new Error('Invalid saved radius list ID');
    }else{
      const search=await radiusSearch(thanksToken,{
        address:serviceAddress,postalCode,recordCount,
        includeCondos:false,includeSearchAddress:false,
        subAccount:cfg.thanksio_subaccount_id?Number(cfg.thanksio_subaccount_id):undefined
      });
      if(search.failure)throw new Error(`radius search failed: ${search.message}`);
      mailingListId=search.mailingListId;
      // Persist the paid provider list before any further work, so retries
      // never buy the same neighbors a second time.
      const {error:checkpointError}=await db.from('ripple_radius_recovery')
        .insert({location_id:locationId,batch_id:permission.batch_id,
          mailing_list_id:mailingListId,status:'ready'});
      if(checkpointError)throw new Error('Radius list purchased but recovery checkpoint could not be saved. Stop and reconcile before retry.');
    }
    // Allow asynchronous radius searches to finish populating the list.
    const candidates=await getRecipientsWithRetry(thanksToken,mailingListId);
    if(!body.preview){
      const {error:recordError}=await db.rpc('record_radius_lookup',{
        p_location_id:locationId,p_job_id:String(jobId),p_returned:candidates.length
      });
      if(recordError)throw new Error('Radius purchase billing record failed: '+recordError.message);
      const {error:billingError}=await db.rpc('ripple_bill_batch_usage',{
        p_location_id:locationId,p_batch_id:permission.batch_id,p_kind:'radius'
      });
      if(billingError)throw new Error('Radius purchase wallet deduction failed: '+billingError.message);
    }
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
    const batch = permission.batch_id;
    const weights = (cfg.prize_weights ?? []) as Array<{ idx: number; w: number }>;
    const sendRecipients = [];
    const mailedRows = [];
    for (const m of mailable.slice(0, recordCount)) {
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
        location_id: locationId, job_id: jobId, batch_id: batch, addr_hash: m.addr_hash,
        address: m.address, city: m.city ?? null, region: m.province ?? null,
        postal_code: m.postal_code ?? null, prize_idx: prize,
        status: 'pending',
      });
    }

    // Resolve the per-location override, assigned niche default, then platform URL.
    const { data: landingBase, error: landingError } = await db.rpc('resolve_landing_base', { p_location_id: locationId });
    if (landingError) throw new Error('Could not resolve the scratch-card URL');
    const landingUrl = new URL(landingBase || LANDING_BASE_ENV);
    if (landingUrl.protocol !== 'https:') throw new Error('Scratch-card URL must use HTTPS');
    landingUrl.hash = '';
    landingUrl.searchParams.set('d', '~CUSTOM1~');
    const qrTemplate = landingUrl.href.replace(/%7E/gi, '~');

    // -- 8. Send (one call, per-recipient dynamic QR) -------------------------
    const beforePostcard=await checkPermission();
    if(!beforePostcard?.allowed)return json({skipped:true,held:true,lookupPurchased:true,reason:beforePostcard?.reason||'mailing_permission_changed'},200);
    const send = await sendPostcard(thanksToken, {
      recipients: sendRecipients,
      message: cfg.message_template ?? 'Hi %FIRST_NAME%, we were just working on your street!',
      size: '6x9',
      creativeId: creativeId,
      imageTemplateId: !creativeId ? imageId : undefined,
      postageClass: 'first_class',
      handwritingRealism: true,
      qrcodeUrl: qrTemplate,
      subAccount: cfg.thanksio_subaccount_id ? Number(cfg.thanksio_subaccount_id) : undefined,
      preview: body.preview ?? false,
    });

    // Record provider acceptance before attempting to write local postcard rows.
    // If database recording fails, the checkpoint blocks an automatic resend.
    if(send.orderId && !body.preview){
      const {error:checkpointError}=await db.from('ripple_radius_recovery')
        .update({status:'used',order_id:String(send.orderId),used_at:new Date().toISOString()})
        .eq('location_id',locationId).eq('batch_id',permission.batch_id).eq('status','ready');
      if(checkpointError)throw new Error('Provider accepted order but recovery checkpoint failed. Investigate provider order before retry.');
    }

    // -- 9. Record mailed rows (idempotent) -----------------------------------
    // Persist batch identity and provider acceptance on every newly sent record.
    const submittedAt = new Date().toISOString();
    for (const row of mailedRows) {
      (row as any).thanksio_order_id = send.orderId ? String(send.orderId) : null;
      (row as any).batch_id = batch;
      (row as any).sent_at = submittedAt;
      (row as any).status = 'sent';
    }
    const ins = await db.from('mailed').upsert(mailedRows, {
      onConflict: 'location_id,job_id,addr_hash', ignoreDuplicates: true,
    });
    if (ins.error) throw new Error(`mailed insert failed: ${ins.error.message}`);

    // Postcard wallet accounting runs AFTER the provider has accepted the
    // order and after sent rows are written. Billing is idempotent by batch.
    // Never turn a real paid provider order into a failed mailing on billing
    // errors: report the issue for reconciliation instead of resending.
    let billingWarning:string|null=null;
    if(!body.preview){
      const {error:cardBillError}=await db.rpc('ripple_bill_batch_usage',{
        p_location_id:locationId,p_batch_id:permission.batch_id,p_kind:'cards'
      });
      if(cardBillError){
        billingWarning='Card wallet deduction requires reconciliation';
        console.error('[billing] Postcard charge failed',permission.batch_id,cardBillError.message);
      }
    }

    return json({
      jobId,
      preview: send.preview,
      previewUrl: send.previewUrl,
      candidates: hashed.length,
      dropped,
      mailed: mailedRows.length,
      orderId: send.orderId,
      billingWarning,
    }, 200);
  } catch (err) {
    const e = err as ThanksIoError;
    return json({
      error: e.message,
      retryable: e.retryable ?? false,
    }, e.status && e.status < 500 ? 400 : 500);
  }
});

