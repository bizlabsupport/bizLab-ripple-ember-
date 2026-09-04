import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type Json = Record<string, unknown>;
type Config = {
  location_id: string;
  fieldroutes_office_id: string;
  customer_id_field?: string;
  office_id_field?: string;
  status_field?: string;
  commercial_account_field?: string;
  subscriptions_field?: string;
  field_ids?: Record<string, string>;
};

const encoder = new TextEncoder();

function respond(status: number, body: Json) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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

function text(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function first(record: Json, ...keys: string[]) {
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return "";
}

function validDate(value: unknown) {
  const date = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function customMap(record: Json) {
  const map = new Map<string, unknown>();
  const fields = Array.isArray(record.customFields) ? record.customFields : [];
  for (const item of fields) {
    if (!item || Array.isArray(item) || typeof item !== "object") continue;
    const field = item as Json;
    const id = text(field.id);
    if (id) map.set(id, field.fieldValue);
  }
  return map;
}

function customText(map: Map<string, unknown>, id?: string) {
  return id ? text(map.get(id)) : "";
}

function customValue(map: Map<string, unknown>, id?: string) {
  return id ? map.get(id) : undefined;
}

function booleanValue(value: unknown) {
  if (typeof value === "boolean") return value;
  return ["true", "yes", "1", "commercial", "active"].includes(text(value).toLowerCase());
}

function earliest(...dates: string[]) {
  return dates.filter(Boolean).sort()[0] || "";
}

function latest(...dates: string[]) {
  return dates.filter(Boolean).sort().at(-1) || "";
}

async function sha256(input: string) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function normalize(record: Json, config: Config) {
  const custom = customMap(record);
  const ids = config.field_ids || {};
  const services = Array.isArray(record.services)
    ? record.services.filter((x) => x && typeof x === "object" && !Array.isArray(x)) as Json[]
    : validDate(record.serviceDate ?? record.service_date)
      ? [record]
      : [];
  const serviceDates = services.map((s) => validDate(s.serviceDate ?? s.service_date ?? s.date)).filter(Boolean);
  const lastServiceDate = validDate(record.lastServiceDate ?? record.last_service_date) || latest(...serviceDates);
  const latestService = services.find((s) => validDate(s.serviceDate ?? s.service_date ?? s.date) === lastServiceDate);
  const subscriptions = customValue(custom, config.subscriptions_field);
  const sold1 = validDate(customValue(custom, ids.subscription_1_sold_date));
  const sold2 = validDate(customValue(custom, ids.subscription_2_sold_date));
  const customerId = first(record, "customerID", "customerId", "customer_id", "fieldroutesCustomerId") || customText(custom, config.customer_id_field);
  const officeId = first(record, "officeID", "officeId", "office_id", "fieldroutesOfficeId") || customText(custom, config.office_id_field);
  const status = first(record, "subscriptionStatus", "subscription_status", "status") || customText(custom, config.status_field);
  const commercialRaw = record.isCommercial ?? record.commercialAccount ?? customValue(custom, config.commercial_account_field);
  const serviceCountRaw = record.serviceCount ?? record.service_count;
  const serviceCount = serviceCountRaw === undefined || serviceCountRaw === null || text(serviceCountRaw) === ""
    ? services.length
    : Math.max(0, Number(serviceCountRaw) || 0);
  const normalized: Json = {
    customerId,
    officeId,
    firstName: first(record, "firstName", "fname", "first_name") || customText(custom, ids.billing_first_name),
    lastName: first(record, "lastName", "lname", "last_name") || customText(custom, ids.billing_last_name),
    companyName: first(record, "companyName", "company_name"),
    isCommercial: booleanValue(commercialRaw) || text(commercialRaw).toLowerCase() === "commercial",
    email: first(record, "email") || customText(custom, ids.billing_email),
    phone: first(record, "phone", "phone1") || customText(custom, ids.billing_phone),
    phoneAlt: first(record, "phone2", "phone_alt"),
    address1: first(record, "address1", "address") || customText(custom, ids.billing_address),
    city: first(record, "city") || customText(custom, ids.billing_city),
    state: first(record, "state") || customText(custom, ids.billing_state),
    postalCode: first(record, "postalCode", "zip") || customText(custom, ids.billing_postal_code),
    lastServiceDate,
    lastServiceTypeId: first(record, "lastServiceTypeId", "last_service_type_id") || first(latestService || {}, "serviceType", "serviceTypeID", "service_type_id"),
    lastServiceDescription: first(record, "lastServiceDescription", "last_service_description") || first(latestService || {}, "serviceDescription", "description"),
    serviceCount,
    customerSince: validDate(record.customerSince ?? record.customer_since) || earliest(sold1, sold2, ...serviceDates),
    subscriptionStatus: status,
    cancellationDate: validDate(record.cancellationDate ?? record.cancellation_date),
    cancellationReason: first(record, "cancellationReason", "cancellation_reason"),
    wasSubscriber: booleanValue(record.wasSubscriber ?? record.was_subscriber) || (Array.isArray(subscriptions) ? subscriptions.length > 0 : Boolean(text(subscriptions))),
    nextAppointmentDate: validDate(record.nextAppointmentDate ?? record.next_appointment_date),
    referenceDate: validDate(record.referenceDate ?? record.reference_date) || lastServiceDate || validDate(record.cancellationDate ?? record.cancellation_date),
    ltv: record.ltv ?? null,
  };
  normalized.recordHash = await sha256(JSON.stringify(normalized));
  return normalized;
}

Deno.serve(async (req) => {
  if (req.method === "GET") return respond(200, { ok: true, service: "ember-fieldroutes-backfill", max_records_per_request: 100 });
  if (req.method !== "POST") return respond(405, { ok: false, error: "method_not_allowed" });

  const secret = Deno.env.get("EMBER_WEBHOOK_SECRET");
  if (!secret) return respond(503, { ok: false, error: "receiver_not_configured" });
  if (!safeEqual(req.headers.get("x-ember-secret"), secret)) return respond(401, { ok: false, error: "invalid_secret" });

  const contentLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 2_000_000) return respond(413, { ok: false, error: "payload_too_large" });

  let body: Json;
  try {
    const raw = await req.text();
    if (encoder.encode(raw).length > 2_000_000) return respond(413, { ok: false, error: "payload_too_large" });
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    body = parsed as Json;
  } catch {
    return respond(400, { ok: false, error: "invalid_json_object" });
  }

  const locationId = first(body, "locationId", "location_id");
  const batchId = first(body, "batchId", "batch_id");
  const expectedRaw = body.expectedCount ?? body.expected_count;
  const expectedCount = expectedRaw === undefined || expectedRaw === null || text(expectedRaw) === "" ? null : Number(expectedRaw);
  const finalize = body.finalize === true;
  const recordsRaw = body.records ?? body.customers ?? [];
  if (!locationId || !batchId) return respond(422, { ok: false, error: "location_and_batch_required" });
  if (!Array.isArray(recordsRaw) || recordsRaw.length > 100) return respond(422, { ok: false, error: "records_must_be_array_max_100" });
  if (expectedCount !== null && (!Number.isInteger(expectedCount) || expectedCount < 1)) return respond(422, { ok: false, error: "invalid_expected_count" });
  if (finalize && expectedCount === null) return respond(422, { ok: false, error: "expected_count_required_to_finalize" });

  const url = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRole) return respond(503, { ok: false, error: "database_not_configured" });
  const db = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: configData, error: configError } = await db.rpc("ember_get_backfill_config", { p_location_id: locationId });
  if (configError) {
    console.error("backfill config failed", configError.code, configError.message);
    return respond(500, { ok: false, error: "backfill_config_failed" });
  }
  if (!configData) return respond(422, { ok: false, error: "unknown_or_disabled_location" });
  const config = configData as Config;
  const normalized = await Promise.all(recordsRaw.map((record) => normalize(record as Json, config)));
  const wrongOffice = normalized.find((record) => record.officeId && record.officeId !== config.fieldroutes_office_id);
  if (wrongOffice) return respond(422, { ok: false, error: "record_office_mismatch", expected_office_id: config.fieldroutes_office_id });

  const { data, error } = await db.rpc("ember_import_backfill_batch", {
    p_location_id: locationId,
    p_fieldroutes_office_id: config.fieldroutes_office_id,
    p_batch_id: batchId,
    p_expected_count: expectedCount,
    p_records: normalized,
    p_finalize: finalize,
  });
  if (error) {
    console.error("backfill import failed", error.code, error.message);
    return respond(error.code === "22023" ? 422 : 500, { ok: false, error: "backfill_import_failed", message: error.message });
  }
  return respond(data?.status === "failed" ? 409 : 200, data as Json);
});
