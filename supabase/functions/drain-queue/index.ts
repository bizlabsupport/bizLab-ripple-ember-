// drain-queue — the step that turns a decided batch into mail.
//
// Deploy:  supabase functions deploy drain-queue --no-verify-jwt
// Auth:    x-ripple-secret, checked against RIPPLE_CALLER_SECRET — the SAME
//          secret that guards send-postcards, because this function spends
//          money the same way. Deliberately NOT RIPPLE_INTAKE_SECRET, which
//          ships inside the client snapshot and is semi-public.
//
// Schedule: once an hour is plenty. Deadlines land at config.review_hour in
// each client's timezone, so an hourly tick catches every zone without the
// cron needing to know about any of them.
//
// The lifecycle it completes:
//   enqueue_completed_job  ->  pending
//   owner decides, or the deadline passes  ->  approved   (decide_send)
//   THIS FUNCTION          ->  sending -> sent | failed
//
// What it deliberately does NOT do:
//   - It never writes 'expired'. Decision on record: no staleness ceiling.
//     A late card still mails; lateness is reported, not enforced.
//   - It never mails a batch whose service date has not passed. That is
//     already true by construction: review_deadline is service_date + 1 day at
//     review_hour, and send_queue_due filters on review_deadline <= now().

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CALLER_SECRET = Deno.env.get("RIPPLE_CALLER_SECRET")!;

// Same project, so this is a loopback call rather than a network hop.
const SEND_URL = `${SUPABASE_URL}/functions/v1/send-postcards`;

/** Cards mailed more than this many days after the service date get flagged. */
const LATE_AFTER_DAYS = 5;

/** Ceiling on batches per run, so one tick cannot empty a backlog at once. */
const MAX_BATCHES_PER_RUN = 25;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const log = (...a: unknown[]) => console.log("[drain]", ...a);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function secretOk(given: string | null): boolean {
  if (!given || given.length !== CALLER_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ CALLER_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

interface DueRow {
  id: number;
  location_id: string;
  job_id: number;
  batch_id: string;
  service_address: string | null;
  service_date: string | null;
  completed_at: string | null;
  proposed_cards: number | null;
  approved_cards: number | null;
  status: string;
  auto_approve_sends: boolean;
  daily_card_cap: number | null;
  running_cards: number | null;
  explicitly_approved: boolean;
  auto_approved: boolean;
}

/** Whole days between the service date and now. Negative is impossible here. */
function daysLate(row: DueRow): number | null {
  const anchor = row.service_date ?? row.completed_at;
  if (!anchor) return null;
  const then = new Date(anchor).getTime();
  if (isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86400000);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!secretOk(req.headers.get("x-ripple-secret"))) {
    return json({ error: "unauthorized" }, 401);
  }

  // dryRun lists what would mail and touches nothing. Worth having: the first
  // real run of this function spends postage that cannot be recalled.
  let dryRun = false;
  let onlyLocation: string | null = null;
  try {
    const body = await req.json();
    dryRun = body?.dryRun === true;
    onlyLocation = body?.locationId ?? null;
  } catch {
    // no body is fine — a cron will send none
  }

  const results: Array<Record<string, unknown>> = [];

  try {
    let q = db
      .from("send_queue_due")
      .select("*")
      .order("review_deadline", { ascending: true })
      .limit(MAX_BATCHES_PER_RUN);
    if (onlyLocation) q = q.eq("location_id", onlyLocation);

    const { data, error } = await q;
    if (error) throw new Error(`due query failed: ${error.message}`);
    const due = (data ?? []) as DueRow[];

    if (!due.length) return json({ ok: true, considered: 0, sent: 0, results });

    for (const row of due) {
      const late = daysLate(row);
      const base = {
        batchId: row.batch_id,
        locationId: row.location_id,
        serviceDate: row.service_date,
        daysLate: late,
        // No ceiling by decision — lateness is surfaced, never enforced.
        late: late !== null && late > LATE_AFTER_DAYS,
      };

      // -- 1. Decide, if nobody has ------------------------------------------
      // A pending row that reached its deadline with auto-approve on is the
      // silence-means-send path. p_user null is the audit trail for "machine
      // decided", which is exactly what decide_send's null default is for.
      let cards = row.approved_cards ?? 0;
      if (!row.explicitly_approved) {
        if (!row.auto_approved) {
          // Deadline passed, auto-approve off (or the daily cap is already
          // spent). Leave it pending — this is the owner's to decide, and a
          // row nobody decided is not a failure.
          results.push({ ...base, action: "left_pending", reason: "awaiting owner decision" });
          continue;
        }
        const { data: decided, error: dErr } = await db.rpc("decide_send", {
          p_batch_id: row.batch_id,
          p_cards: row.proposed_cards ?? 0,
          p_user: null,
        });
        if (dErr) {
          results.push({ ...base, action: "decide_failed", error: dErr.message });
          continue;
        }
        const d = (Array.isArray(decided) ? decided[0] : decided) as Record<string, unknown>;
        cards = Number(d?.approved_cards ?? 0);
        if (cards <= 0) {
          results.push({ ...base, action: "skipped", reason: "approved zero cards" });
          continue;
        }
      }

      // -- 2. Claim the row --------------------------------------------------
      // The lease. Guarded by `.eq('status','approved')`, so of two overlapping
      // cron ticks only the one that actually changed the row proceeds. A
      // status flip, NOT an advisory lock: session-scoped Postgres features do
      // not survive the transaction pooler (v12, migration 0017).
      const claim = await db
        .from("send_queue")
        .update({ status: "sending" })
        .eq("batch_id", row.batch_id)
        .eq("status", "approved")
        .select("id");
      if (claim.error) {
        results.push({ ...base, action: "claim_failed", error: claim.error.message });
        continue;
      }
      if (!claim.data?.length) {
        // Another tick got there first. Not an error.
        results.push({ ...base, action: "already_claimed" });
        continue;
      }

      // -- 3. Everything send-postcards needs --------------------------------
      // It keys jobs on ghl_job_id, not the bigint, so resolve it here.
      const jobRes = await db
        .from("jobs")
        .select("ghl_job_id, ghl_contact_id, service_address, city, region, postal_code")
        .eq("id", row.job_id)
        .single();
      if (jobRes.error || !jobRes.data) {
        await settle(row.batch_id, "failed", `job lookup failed: ${jobRes.error?.message ?? "no row"}`);
        results.push({ ...base, action: "failed", error: "job lookup failed" });
        continue;
      }
      const job = jobRes.data;

      if (!job.postal_code || !job.service_address) {
        await settle(row.batch_id, "failed", "job has no service address or postal code");
        results.push({ ...base, action: "failed", error: "incomplete job address" });
        continue;
      }

      if (dryRun) {
        // Put the row back exactly as it was: a dry run must not consume the
        // lease it just took.
        await db.from("send_queue").update({ status: "approved" }).eq("batch_id", row.batch_id);
        results.push({ ...base, action: "would_send", cards });
        continue;
      }

      // -- 4. Send -----------------------------------------------------------
      try {
        const res = await fetch(SEND_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-ripple-secret": CALLER_SECRET,
          },
          body: JSON.stringify({
            locationId: row.location_id,
            ghlJobId: job.ghl_job_id,
            // Both of these are why the six patches happened. batchId is what
            // the QR signs and what recipient_context resolves a scan by;
            // cardCount caps the radius PURCHASE, not just the send.
            batchId: row.batch_id,
            cardCount: cards,
            ghlContactId: job.ghl_contact_id ?? undefined,
            serviceAddress: job.service_address,
            city: job.city ?? undefined,
            region: job.region ?? undefined,
            postalCode: job.postal_code,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          await settle(row.batch_id, "failed", String(payload?.error ?? `http ${res.status}`));
          results.push({ ...base, action: "failed", error: payload?.error ?? `http ${res.status}` });
          continue;
        }

        // A 200 with `skipped` is send-postcards declining for a stated reason
        // — the can_send gate, the daily throttle, or every candidate
        // suppressed. That is a decision, not a failure, so the batch goes to
        // 'skipped' and keeps the reason rather than being retried forever.
        if (payload?.skipped || payload?.mailed === 0) {
          await settle(row.batch_id, "skipped", String(payload?.reason ?? "nothing to mail"));
          results.push({ ...base, action: "skipped", reason: payload?.reason ?? "nothing to mail" });
          continue;
        }

        const sent = await db
          .from("send_queue")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("batch_id", row.batch_id)
          .select("id");
        if (sent.error) {
          // The mail is gone regardless. Say so loudly rather than pretending
          // it failed, or the next tick will mail the street twice.
          log("CRITICAL: cards mailed but the queue row could not be settled", {
            batchId: row.batch_id, orderId: payload?.orderId, error: sent.error.message,
          });
        }

        results.push({
          ...base,
          action: "sent",
          cards,
          mailed: payload?.mailed ?? null,
          dropped: payload?.dropped ?? null,
          orderId: payload?.orderId ?? null,
        });

        if (base.late) {
          log("late batch mailed", { batchId: row.batch_id, daysLate: late });
        }
      } catch (e) {
        // A network failure leaves the batch in 'sending' if we cannot settle
        // it. Deliberate: an unknown outcome must not be retried automatically,
        // because thanks.io may already have the order. A stuck 'sending' row
        // is a visible problem; a double mailing is an invisible one.
        const msg = e instanceof Error ? e.message : String(e);
        log("send threw — leaving the row in 'sending' for a human", {
          batchId: row.batch_id, error: msg,
        });
        results.push({ ...base, action: "unknown", error: msg });
      }
    }

    const sentCount = results.filter((r) => r.action === "sent").length;
    log("run complete", { considered: due.length, sent: sentCount, dryRun });
    return json({ ok: true, dryRun, considered: due.length, sent: sentCount, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("run failed", msg);
    return json({ ok: false, error: msg, results }, 500);
  }
});

async function settle(batchId: string, status: string, reason: string) {
  const { error } = await db
    .from("send_queue")
    .update({ status, skip_reason: reason.slice(0, 500) })
    .eq("batch_id", batchId);
  if (error) log("settle failed", { batchId, status, error: error.message });
}
