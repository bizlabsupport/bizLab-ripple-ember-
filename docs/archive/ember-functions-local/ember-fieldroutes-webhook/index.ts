import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type JsonRecord = Record<string, unknown>;

const encoder = new TextEncoder();
const SUPPORTED = new Set([
  "appointment_scheduled",
  "appointment_rescheduled",
  "appointment_cancelled",
  "service_completed",
]);

function json(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function safeEqual(received: string | null, expected: string | undefined) {
  if (!received || !expected) return false;
  const a = encoder.encode(received);
  const b = encoder.encode(expected);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

function value(body: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const candidate = body[key];
    if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }
  return "";
}

function normaliseEvent(raw: string) {
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases: Record<string, string> = {
    appointment_booked: "appointment_scheduled",
    appointment_schedule: "appointment_scheduled",
    scheduled: "appointment_scheduled",
    appointment_reschedule: "appointment_rescheduled",
    rescheduled: "appointment_rescheduled",
    appointment_canceled: "appointment_cancelled",
    appointment_cancel: "appointment_cancelled",
    canceled: "appointment_cancelled",
    cancelled: "appointment_cancelled",
    service_complete: "service_completed",
    job_complete: "service_completed",
    completed: "service_completed",
  };
  return aliases[key] ?? key;
}

async function sha256(input: string) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json(200, { ok: true, service: "ember-fieldroutes-webhook" });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const secret = Deno.env.get("EMBER_WEBHOOK_SECRET");
  if (!secret) {
    console.error("EMBER_WEBHOOK_SECRET is not configured");
    return json(503, { ok: false, error: "receiver_not_configured" });
  }
  if (!safeEqual(req.headers.get("x-ember-secret"), secret)) {
    return json(401, { ok: false, error: "invalid_secret" });
  }

  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 262144) {
    return json(413, { ok: false, error: "payload_too_large" });
  }

  let payload: JsonRecord;
  try {
    const raw = await req.text();
    if (encoder.encode(raw).length > 262144) return json(413, { ok: false, error: "payload_too_large" });
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("not_object");
    payload = parsed as JsonRecord;
  } catch {
    return json(400, { ok: false, error: "invalid_json_object" });
  }

  const eventType = normaliseEvent(value(payload, "event", "eventType", "event_type"));
  const officeId = value(payload, "officeID", "officeId", "office_id");
  const customerId = value(payload, "customerID", "customerId", "customer_id");
  const appointmentId = value(payload, "appointmentID", "appointmentId", "appointment_id");

  if (!SUPPORTED.has(eventType)) {
    return json(422, { ok: false, error: "unsupported_event", supported_events: Array.from(SUPPORTED) });
  }
  const missing = [
    !officeId && "officeID",
    !customerId && "customerID",
    !appointmentId && "appointmentID",
  ].filter(Boolean);
  if (missing.length) return json(422, { ok: false, error: "missing_required_fields", fields: missing });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRole) return json(503, { ok: false, error: "database_not_configured" });

  const db = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const serviceDate = value(payload, "serviceDate", "service_date");
  const eventTimestamp = value(payload, "eventTimestamp", "event_timestamp", "timestamp", "updatedAt");
  const externalId = await sha256([eventType, officeId, customerId, appointmentId, serviceDate, eventTimestamp].join("|"));

  const { data, error } = await db.rpc("ember_store_webhook_event", {
    p_event_type: eventType,
    p_fieldroutes_office_id: officeId,
    p_customer_id: customerId,
    p_appointment_id: appointmentId,
    p_subscription_id: value(payload, "subscriptionID", "subscriptionId", "subscription_id") || null,
    p_external_id: externalId,
    p_payload: payload,
  });

  if (error) {
    console.error("webhook store failed", error.code, error.message);
    return json(500, { ok: false, error: "event_store_failed" });
  }
  if (!data?.ok && data?.error === "unknown_or_disabled_office") {
    console.warn("unmapped FieldRoutes office rejected", { officeId, eventType });
    return json(422, data);
  }
  if (!data?.duplicate) {
    const { data: processing, error: processError } = await db.rpc("ember_process_webhook_events", { p_limit: 10 });
    if (processError) {
      console.error("webhook processing failed to start", processError.code, processError.message);
      return json(202, { ...(data as JsonRecord), processing: "deferred" });
    }
    return json(202, { ...(data as JsonRecord), processing });
  }
  return json(200, data as JsonRecord);
});
