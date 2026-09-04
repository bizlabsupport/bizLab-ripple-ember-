// ghl-intake — single entry point for all HighLevel workflow webhooks.
//
// Deploy:  supabase functions deploy ghl-intake --no-verify-jwt
// Auth:    x-ripple-secret header, checked against RIPPLE_INTAKE_SECRET.
//          Deliberately a DIFFERENT secret from RIPPLE_CALLER_SECRET, which
//          guards send-postcards. This one ships inside the client snapshot
//          and is therefore semi-public; that one is not.
//
// Routing: body.customData.event  ->  appointment_scheduled
//                                     | appointment_rescheduled
//                                     | appointment_cancelled
//                                     | job_complete | contact_sync | booked
//                                     | win | opt_out
//
// Payload shape is taken from a live capture (2026-08-07), NOT from
// assumption. The three things that surprised us:
//   - location id is nested at  body.location.id   (not locationId)
//   - custom data is nested at  body.customData.*  (not top level)
//   - tags arrive as a comma-joined LOWERCASE string, not an array
//   - a TAG-triggered webhook carries no appointment id at all (see makeJobKey).
//     An APPOINTMENT-triggered one does, and it must be mapped into
//     customData as appointment_id - see resolveJobKey for why that is not
//     optional under the scheduled model.
//
// Schema verified against information_schema on 2026-08-07:
//   jobs: UNIQUE (location_id, ghl_job_id) already exists - no migration.
//   enqueue_completed_job(text, bigint, text, text, timestamptz, date) - ONE
//     oid, no overload, upserts send_queue on (location_id, job_id).
//     Migration 0032 appended p_service_date; when given it anchors both the
//     batch id and the review deadline, and a reschedule moves the deadline
//     with it while the batch is still pending.
//   cancel_queued_batch(text, text, text) - pulls a queued batch by
//     (location_id, ghl_job_id). Idempotent; refuses once cards are printing.
//   jobs.service_date / send_queue.service_date exist as of 0032.
//   config carries timezone + review_hour (absent from Appendix B).

import { createClient } from "jsr:@supabase/supabase-js@2";

// TODO: confirm the exported name in _shared/address.ts before deploying.
// The canonical hasher exists only in TS/JS - there is no SQL equivalent -
// so every addr_hash written here MUST come from this function or
// suppression silently stops working.
import { addressHash } from "../_shared/address.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTAKE_SECRET = Deno.env.get("RIPPLE_INTAKE_SECRET")!;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const log = (...a: unknown[]) => console.log("[ghl-intake]", ...a);

/** Constant-time-ish compare so the secret check can't be timed. */
function secretOk(given: string | null): boolean {
  if (!given || given.length !== INTAKE_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ INTAKE_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Tags arrive as "service completed,ripple_neighbor" - lowercased by
 * HighLevel. Split and trim; never substring-match, or one tag name
 * containing another silently matches the wrong thing.
 */
function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim().toLowerCase());
  if (typeof raw !== "string") return [];
  return raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * There is no appointment id in a tag-triggered webhook, so we synthesize a
 * stable natural key and store it in jobs.ghl_job_id, which already carries
 * UNIQUE (location_id, ghl_job_id).
 *
 * Why this matters: enqueue_completed_job upserts on (location_id, job_id)
 * and is therefore safely idempotent - but only if jobs.id is stable. A
 * re-fired tag that mints a NEW jobs row produces a new job_id, a new
 * send_queue row, a new batch, and a doubled mailing. The whole idempotency
 * chain hangs off this key.
 *
 * Same contact tagged twice today -> same key -> one job.
 * Genuine re-service next month -> new key -> new job, and the rolling
 * suppression window is what stops those neighbours being re-mailed.
 *
 * NOT body.date_created - that is the CONTACT's creation date, not the
 * completion. Intake time is the closest honest proxy available.
 *
 * NOTE: the date is taken in UTC. A job completed at 8pm Eastern falls on
 * the next UTC day, so an evening tag followed by a morning re-tag would
 * produce two keys. Switch to config.timezone if that proves real.
 */
function makeJobKey(contactId: string): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return `ghl:${contactId}:${day}`;
}

/**
 * The key every idempotency guarantee hangs off.
 *
 * Under the scheduled model the synthesized key is actively unsafe, for two
 * reasons that both end in a doubled mailing:
 *
 *   1. RESCHEDULE. A date-derived key changes when the date changes, so
 *      moving an appointment mints a new jobs row, a new send_queue row, a
 *      new batch - and the original batch is orphaned rather than moved.
 *   2. THE SAME JOB SEEN TWICE. The appointment is scheduled (one webhook)
 *      and later completed (another). Keyed on contact+date those are two
 *      different jobs, so the street gets queued twice.
 *
 * The appointment id fixes both: it is stable across reschedules and it is
 * the same value on the scheduled and completed webhooks, so enqueue's upsert
 * on (location_id, job_id) collapses them into one batch.
 *
 * The synthesized key stays as the fallback so completion-triggered installs
 * keep working untouched - but any workflow that fires on an appointment MUST
 * map {{appointment.id}} into customData.appointment_id.
 */
function resolveJobKey(c: Ctx): string {
  return c.appointmentId ? `ghl:appt:${c.appointmentId}` : makeJobKey(c.contactId);
}

/**
 * HighLevel date merge fields are not consistent: a date-type custom field
 * renders YYYY-MM-DD, an appointment start time renders a full ISO timestamp,
 * and a text field holding a date is whatever the office typed. Parse
 * defensively and return null rather than guess - a wrong service date sets
 * the wrong mailing day, which is worse than refusing to queue.
 *
 * A bare YYYY-MM-DD is taken as-is. It is already a local calendar date, and
 * running it through a timezone conversion is what turns the 14th into the
 * 13th.
 */
function parseServiceDate(raw: unknown, tz: string): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  const us = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const parsed = new Date(v);
  if (isNaN(parsed.getTime())) return null;

  // An instant has to be read in the client's timezone: 2026-08-14T01:00Z is
  // still the 13th in New York, and the 13th is the day the crew shows up.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(parsed);
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
}

type Json = Record<string, unknown>;

function ok(body: Json = {}) {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A deliberate no-op. Returns 200 so HighLevel does NOT retry - "we chose
 * not to act" is a success, not a failure. Only genuine errors get 5xx.
 */
function skip(reason: string, extra: Json = {}) {
  log("skip:", reason, extra);
  return ok({ skipped: reason, ...extra });
}

function fail(status: number, reason: string) {
  log("fail:", status, reason);
  return new Response(JSON.stringify({ ok: false, error: reason }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// normalised view of the payload
// ---------------------------------------------------------------------------

interface Ctx {
  event: string;
  generation: number;
  locationId: string;
  contactId: string;
  /** {{appointment.id}}, mapped into customData by the workflow. */
  appointmentId: string;
  /** Raw service date as HighLevel rendered it; parsed per-location. */
  serviceDateRaw: string;
  /** The contact's Status in HighLevel, mapped in by the sync workflow. */
  status: string;
  tags: string[];
  address1: string;
  city: string;
  region: string; // two-letter. body.state, NOT location.state
  postalCode: string;
  jobValue: number | null;
  raw: Json;
}

function normalise(body: Json): Ctx | null {
  const location = (body.location ?? {}) as Json;
  const custom = (body.customData ?? {}) as Json;

  const locationId = String(location.id ?? "");
  const contactId = String(body.contact_id ?? "");
  if (!locationId || !contactId) return null;

  // A merge field for a custom field that does not exist on the sub-account
  // resolves to "" rather than erroring. Default rather than throw.
  const genRaw = String(custom.generation ?? "").trim();
  const generation = genRaw === "" ? 0 : Number(genRaw);

  const valRaw = String(custom.job_value ?? "").trim();
  const jobValue = valRaw === "" ? null : Number(valRaw);

  // Accept the aliases a workflow might plausibly be built with, rather than
  // failing silently on a name mismatch nobody can see from the outside.
  const appointmentId = String(
    custom.appointment_id ?? custom.appointmentId ?? "",
  ).trim();
  const serviceDateRaw = String(
    custom.current_service_date ?? custom.service_date ??
      custom.appointment_date ?? custom.start_time ?? "",
  ).trim();

  // Whatever the workflow mapped the HighLevel Status field to. Taken from
  // customData first so contact_sync never has to call the API for it.
  const status = String(custom.status ?? custom.contact_status ?? body.status ?? "").trim();

  return {
    event: String(custom.event ?? "").trim(),
    generation: Number.isFinite(generation) ? generation : 0,
    locationId,
    contactId,
    appointmentId,
    serviceDateRaw,
    status,
    tags: parseTags(body.tags),
    address1: String(body.address1 ?? "").trim(),
    city: String(body.city ?? "").trim(),
    region: String(body.state ?? "").trim(),
    postalCode: String(body.postal_code ?? "").trim(),
    jobValue: Number.isFinite(jobValue as number) ? jobValue : null,
    raw: body,
  };
}

/** Load the tenant row and apply the gates that GHL cannot check itself. */
async function loadConfig(locationId: string) {
  const { data, error } = await db
    .from("config")
    .select(
      "location_id, client_name, paused, address_backfill_completed_at, " +
        "suppress_customers_active_within_days, timezone, review_hour",
    )
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// 1. job_complete  -> queue the ripple
// ---------------------------------------------------------------------------

async function handleJobComplete(c: Ctx) {
  // Re-check the tag filters server-side. The GHL-side filter should already
  // have caught these, but a misconfigured snapshot spends real postage.
  if (c.tags.includes("ripple_paused")) return skip("contact_paused");
  if (c.tags.includes("ripple_neighbor")) {
    return skip("has_ripple_neighbor_use_win_event");
  }

  const cfg = await loadConfig(c.locationId);
  if (!cfg) return skip("no_config_row", { locationId: c.locationId });

  // Location-level pause. NOTE the known reinstall gap: uninstall sets
  // paused=true and reinstall does not clear it.
  if (cfg.paused) return skip("location_paused");

  // Fail closed. An empty suppression cache must refuse to send, never
  // mail the whole radius.
  if (!cfg.address_backfill_completed_at) {
    return skip("backfill_incomplete");
  }

  if (!c.address1 || !c.postalCode) {
    return skip("no_service_address", { contactId: c.contactId });
  }

  const completedAt = new Date().toISOString();
  // Same key the scheduled webhook used, when the workflow maps the
  // appointment id - so completing a job that was already queued updates that
  // batch instead of creating a second one for the same street.
  const ghlJobId = resolveJobKey(c);
  const serviceDate = parseServiceDate(c.serviceDateRaw, cfg.timezone || "America/New_York");
  const addrHash = await addressHash(c.address1, c.postalCode); if (!addrHash) return skip("address_unhashable", { contactId: c.contactId });

  // Upsert on the existing UNIQUE (location_id, ghl_job_id).
  // lat/lng are deliberately left null - enqueue_completed_job copies them
  // onto the queue row but nothing downstream is known to read them, and
  // thanks.io radius search takes address + postal directly. Confirm what
  // reads send_queue.lat before building a geocoder that is not needed.
  const { data: job, error: jobErr } = await db
    .from("jobs")
    .upsert(
      {
        location_id: c.locationId,
        ghl_job_id: ghlJobId,
        ghl_contact_id: c.contactId,
        service_address: c.address1,
        city: c.city,
        region: c.region,
        postal_code: c.postalCode,
        addr_hash: addrHash,
        job_value: c.jobValue,
        completed_at: completedAt,
        ...(serviceDate ? { service_date: serviceDate } : {}),
      },
      { onConflict: "location_id,ghl_job_id" },
    )
    .select("id")
    .single();

  if (jobErr) throw jobErr;

  // The service address is itself a customer address. Free cache upkeep,
  // and self-healing over time (population route 3).
  const { error: cacheErr } = await db.from("client_addresses").upsert(
    {
      location_id: c.locationId,
      addr_hash: addrHash,
      ghl_contact_id: c.contactId,
      source: "job",
      last_job_at: completedAt,
      last_seen_at: completedAt,
    },
    { onConflict: "location_id,addr_hash" },
  );
  // Non-fatal: a stale cache is bad, but failing the whole job for it is worse.
  if (cacheErr) log("cache upsert failed (non-fatal)", cacheErr.message);

  // p_neighborhood is a LOCALITY label, not a street - the function falls
  // back to jobs.neighborhood then jobs.city. Passing city matches that.
  const { data: queued, error: qErr } = await db.rpc("enqueue_completed_job", {
    p_location_id: c.locationId,
    p_job_id: job.id,
    p_address: c.address1,
    p_neighborhood: c.city || null,
    p_completed_at: completedAt,
    // Null is fine: the function falls back to jobs.service_date, then to the
    // completion date, so a completion-triggered install is unchanged.
    p_service_date: serviceDate,
  });
  if (qErr) throw qErr;

  // The RPC does NOT send. It writes a send_queue row with proposed_cards
  // and a review_deadline (day after completion at config.review_hour in
  // config.timezone). Auto-send is opt-out: silence means send. Do not
  // invoke send-postcards from here.
  const q = (Array.isArray(queued) ? queued[0] : queued) as Json | null;

  log("queued", {
    locationId: c.locationId,
    jobId: job.id,
    ghlJobId,
    batchId: q?.batch_id,
    reviewDeadline: q?.review_deadline,
  });

  return ok({
    jobId: job.id,
    ghlJobId,
    addrHash,
    batchId: q?.batch_id ?? null,
    proposedCards: q?.proposed_cards ?? null,
    reviewDeadline: q?.review_deadline ?? null,
  });
}

// ---------------------------------------------------------------------------
// 1b. appointment_scheduled / appointment_rescheduled -> queue ahead of time
//
// Queueing happens when the appointment is booked; MAILING still happens only
// after the service date has passed, because enqueue anchors the review
// deadline on service_date + 1 day at config.review_hour. That is what gives
// the owner a week and a month of visibility without ever promising a
// neighbour a treatment that has not happened yet.
// ---------------------------------------------------------------------------

async function handleAppointmentScheduled(c: Ctx) {
  if (c.tags.includes("ripple_paused")) return skip("contact_paused");
  if (c.tags.includes("ripple_neighbor")) {
    return skip("has_ripple_neighbor_use_win_event");
  }

  const cfg = await loadConfig(c.locationId);
  if (!cfg) return skip("no_config_row", { locationId: c.locationId });
  if (cfg.paused) return skip("location_paused");

  // NOTE: the backfill gate is deliberately NOT applied here. Queueing is not
  // sending - send-postcards re-checks can_send() at step 1 and fails closed
  // there. Blocking at schedule time would hide the whole week ahead from an
  // owner whose backfill simply has not finished yet.

  if (!c.address1 || !c.postalCode) {
    return skip("no_service_address", { contactId: c.contactId });
  }

  const tz = cfg.timezone || "America/New_York";
  const serviceDate = parseServiceDate(c.serviceDateRaw, tz);
  if (!serviceDate) {
    // Without a date there is nothing to anchor the deadline on, and
    // defaulting to today would mail tomorrow for a job three weeks out.
    return skip("no_service_date", { raw: c.serviceDateRaw });
  }

  if (!c.appointmentId) {
    // Allowed, but say so loudly: without it a reschedule cannot find this
    // batch and will queue a second one for the same street.
    log("WARNING: appointment event with no appointment_id - reschedules and " +
      "cancellations for this batch cannot be matched", { contactId: c.contactId });
  }

  const ghlJobId = resolveJobKey(c);
  const addrHash = await addressHash(c.address1, c.postalCode);
  if (!addrHash) return skip("address_unhashable", { contactId: c.contactId });

  const { data: job, error: jobErr } = await db
    .from("jobs")
    .upsert(
      {
        location_id: c.locationId,
        ghl_job_id: ghlJobId,
        ghl_contact_id: c.contactId,
        service_address: c.address1,
        city: c.city,
        region: c.region,
        postal_code: c.postalCode,
        addr_hash: addrHash,
        job_value: c.jobValue,
        service_date: serviceDate,
        // completed_at is deliberately left alone: this job has not happened
        // yet, and stamping it now would make an unserviced address look
        // serviced to anything reading jobs.
      },
      { onConflict: "location_id,ghl_job_id" },
    )
    .select("id")
    .single();
  if (jobErr) throw jobErr;

  // The customer's own address is a customer address whether or not the job
  // has run yet - it must never receive a new-customer offer. last_job_at is
  // NOT set here; nothing has been serviced.
  const { error: cacheErr } = await db.from("client_addresses").upsert(
    {
      location_id: c.locationId,
      addr_hash: addrHash,
      ghl_contact_id: c.contactId,
      source: "job",
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "location_id,addr_hash" },
  );
  if (cacheErr) log("cache upsert failed (non-fatal)", cacheErr.message);

  const { data: queued, error: qErr } = await db.rpc("enqueue_completed_job", {
    p_location_id: c.locationId,
    p_job_id: job.id,
    p_address: c.address1,
    p_neighborhood: c.city || null,
    p_completed_at: new Date().toISOString(),
    p_service_date: serviceDate,
  });
  if (qErr) throw qErr;

  const q = (Array.isArray(queued) ? queued[0] : queued) as Json | null;

  log("scheduled", {
    locationId: c.locationId,
    jobId: job.id,
    ghlJobId,
    serviceDate,
    batchId: q?.batch_id,
    reviewDeadline: q?.review_deadline,
  });

  return ok({
    jobId: job.id,
    ghlJobId,
    addrHash,
    serviceDate,
    batchId: q?.batch_id ?? null,
    proposedCards: q?.proposed_cards ?? null,
    reviewDeadline: q?.review_deadline ?? null,
    // A reschedule is the same call: enqueue upserts on (location_id, job_id)
    // and moves the deadline while the batch is still pending.
    rescheduled: c.event === "appointment_rescheduled",
  });
}

// ---------------------------------------------------------------------------
// 1c. appointment_cancelled -> pull the batch before it mails
// ---------------------------------------------------------------------------

async function handleAppointmentCancelled(c: Ctx) {
  if (!c.appointmentId) {
    // Nothing to match on. Cancelling by contact could pull the wrong batch
    // for a customer with two appointments, which is worse than not pulling.
    return skip("no_appointment_id");
  }

  const ghlJobId = resolveJobKey(c);
  const { data, error } = await db.rpc("cancel_queued_batch", {
    p_location_id: c.locationId,
    p_ghl_job_id: ghlJobId,
    p_reason: String((c.raw.customData as Json)?.reason ?? "appointment cancelled"),
  });
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as Json | null;

  // Never queued, or already pulled: both are fine on replay.
  if (!row) return ok({ cancelled: false, reason: "nothing_queued", ghlJobId });

  // The one case a human needs to hear about: the cards are already at print.
  if (row.status === "sending" || row.status === "sent") {
    log("WARNING: appointment cancelled after the batch went to print", {
      batchId: row.batch_id, status: row.status,
    });
    return ok({
      cancelled: false,
      alreadyMailed: true,
      batchId: row.batch_id,
      status: row.status,
    });
  }

  log("cancelled", { batchId: row.batch_id, ghlJobId });
  return ok({ cancelled: true, batchId: row.batch_id, status: row.status });
}

// ---------------------------------------------------------------------------
// 2. contact_sync -> suppression cache
// ---------------------------------------------------------------------------

async function handleContactSync(c: Ctx) {
  if (!c.address1 || !c.postalCode) return skip("no_address_to_hash");

  // Must go through the shared hasher. If this ever diverges from the send
  // path's hash, suppression stops working and nothing announces it.
  const addrHash = await addressHash(c.address1, c.postalCode); if (!addrHash) return skip("address_unhashable", { contactId: c.contactId });

  // RESOLVED (was an open question): status lives in its own column, and
  // check_suppression reads it against config.never_mail_statuses. This is the
  // write side of that, and it is not optional - the check is status-aware, so
  // a synced contact with a null status reads as a LEAD and is not suppressed.
  // Leaving it unwritten means mailing current customers a new-customer offer.
  //
  // last_job_at is deliberately NOT set here. It records that work was done,
  // which only the job path knows; a status of "Active" is a separate signal
  // and the check honours either. Two notions of "is a customer" is exactly
  // what this avoids - one column each, one meaning each.
  const now = new Date().toISOString();
  const row: Json = {
    location_id: c.locationId,
    addr_hash: addrHash,
    ghl_contact_id: c.contactId,
    source: "webhook",
    last_seen_at: now,
  };

  // Only write status when the workflow actually sent one. An unmapped merge
  // field arrives as "", and blanking a known status on every sync would
  // un-suppress a customer nobody meant to un-suppress.
  if (c.status) {
    row.status = c.status;
    row.status_synced_at = now;
  }

  const { error } = await db.from("client_addresses").upsert(row, {
    onConflict: "location_id,addr_hash",
  });
  if (error) throw error;

  if (!c.status) {
    log("WARNING: contact_sync with no status - this address will NOT be " +
      "suppressed as a customer. Map the Status field into customData.status.",
      { contactId: c.contactId });
  }

  return ok({ addrHash, status: c.status || null, suppressing: !!c.status });
}

// ---------------------------------------------------------------------------
// 6. opt_out
// ---------------------------------------------------------------------------

async function handleOptOut(c: Ctx) {
  if (!c.address1 || !c.postalCode) return skip("no_address_to_hash");
  const addrHash = await addressHash(c.address1, c.postalCode); if (!addrHash) return skip("address_unhashable", { contactId: c.contactId });

  const { error } = await db.from("opt_outs").upsert(
    {
      location_id: c.locationId,
      addr_hash: addrHash,
      reason: String((c.raw.customData as Json)?.reason ?? "ghl_tag"),
    },
    { onConflict: "location_id,addr_hash" },
  );
  if (error) throw error;

  return ok({ addrHash, permanent: true });
}

// ---------------------------------------------------------------------------
// 3/4. booked and win - stubs
// ---------------------------------------------------------------------------

async function handleBooked(c: Ctx) {
  // The claim already wrote the contact, tags, note and custom fields.
  // What is missing is the opportunity, the owner notification and the
  // appointment built from ripple_preferred_date + ripple_preferred_time.
  //
  // Those are HighLevel WRITES, so they need an OAuth token read via
  // read_oauth_secret(p_secret_id) - not a straight table select.
  //
  // Watch: HighLevel DATE custom fields may reject bare YYYY-MM-DD and want
  // a full ISO timestamp. This is where that conversion lands, and the first
  // live claim is what will tell you.
  log("booked received (not yet implemented)", { contactId: c.contactId });
  return ok({ received: true, implemented: false });
}

async function handleWin(c: Ctx) {
  if (!c.tags.includes("ripple_neighbor")) {
    return skip("not_a_ripple_neighbor");
  }
  // Record the win. Re-ripple stays OFF until the generation cap and the
  // per-client spend cap exist - a won neighbour spawning a new ripple with
  // no brake is how one job mails a whole town.
  const { error } = await db.from("wins").insert({
    location_id: c.locationId,
    contact_id: c.contactId,
    revenue: c.jobValue,
  });
  if (error) throw error;

  return ok({ recorded: true, reRippled: false });
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "method_not_allowed");
  if (!secretOk(req.headers.get("x-ripple-secret"))) {
    return fail(401, "bad_secret");
  }

  let body: Json;
  try {
    body = await req.json();
  } catch {
    return fail(400, "invalid_json");
  }

  const c = normalise(body);
  if (!c) return fail(400, "missing_location_or_contact_id");

  log("in", {
    event: c.event,
    locationId: c.locationId,
    contactId: c.contactId,
    appointmentId: c.appointmentId || null,
    generation: c.generation,
  });

  try {
    switch (c.event) {
      case "appointment_scheduled":
      case "appointment_rescheduled":
        return await handleAppointmentScheduled(c);
      case "appointment_cancelled":
        return await handleAppointmentCancelled(c);
      case "job_complete":
        return await handleJobComplete(c);
      case "contact_sync":
        return await handleContactSync(c);
      case "booked":
        return await handleBooked(c);
      case "win":
        return await handleWin(c);
      case "opt_out":
        return await handleOptOut(c);
      default:
        return fail(400, `unknown_event:${c.event || "(empty)"}`);
    }
  } catch (e) {
    // 5xx so HighLevel retries. Handlers are written to be safe on replay:
    // jobs upserts on its natural key, the cache and opt_outs upsert on
    // (location_id, addr_hash).
    log("error", c.event, e instanceof Error ? e.message : String(e));
    return fail(500, "handler_error");
  }
});
