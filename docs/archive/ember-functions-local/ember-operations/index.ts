import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type Json = Record<string, unknown>;
const ALLOWED_ORIGINS = new Set([
  "https://app.bizlabsolutions.ai",
  "https://ripple.bizlabsolutions.ai",
]);

function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "access-control-allow-origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://app.bizlabsolutions.ai",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "Origin",
  };
}

function respond(req: Request, status: number, body: Json) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function cleanId(value: unknown) {
  return String(value ?? "").trim();
}

function integer(value: unknown, min: number, max: number, field: string) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${field} must be ${min}-${max}`);
  return n;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return respond(req, 405, { ok: false, error: "method_not_allowed" });

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) return respond(req, 503, { ok: false, error: "service_not_configured" });

  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return respond(req, 401, { ok: false, error: "missing_authorization" });
  const token = authHeader.slice(7).trim();

  const authClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData.user) return respond(req, 401, { ok: false, error: "invalid_session" });

  let body: Json;
  try {
    const parsed = await req.json();
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    body = parsed as Json;
  } catch {
    return respond(req, 400, { ok: false, error: "invalid_json_object" });
  }

  const action = cleanId(body.action);
  const locationId = cleanId(body.locationId ?? body.location_id);
  if (!action) return respond(req, 400, { ok: false, error: "action_required" });
  if (action !== "listLocations" && !locationId) return respond(req, 400, { ok: false, error: "location_required" });

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const userId = userData.user.id;

  try {
    if (action === "listLocations") {
      const { data, error } = await admin.rpc("ember_list_locations_for_user", { p_user_id: userId });
      if (error) throw error;
      return respond(req, 200, (data || { ok: true, platform: false, locations: [] }) as Json);
    }

    let payload: Json = {};
    if (action === "updateSettings") {
      const incoming = body.updates;
      if (!incoming || Array.isArray(incoming) || typeof incoming !== "object") return respond(req, 400, { ok: false, error: "updates_required" });
      const source = incoming as Json;
      const allowed = new Set(["enabled", "warm_enabled", "cool_enabled", "cold_enabled", "sms_enabled", "email_enabled", "postcard_enabled", "season_start_date", "season_lead_weeks", "auto_approve_sends", "wake_override_at"]);
      const unknown = Object.keys(source).filter((k) => !allowed.has(k));
      if (unknown.length) return respond(req, 400, { ok: false, error: "unsupported_setting", fields: unknown });
      const updates: Json = { updated_at: new Date().toISOString() };
      for (const key of ["enabled", "warm_enabled", "cool_enabled", "cold_enabled", "sms_enabled", "email_enabled", "postcard_enabled", "auto_approve_sends"]) {
        if (key in source) updates[key] = source[key] === true;
      }
      if ("season_lead_weeks" in source) updates.season_lead_weeks = integer(source.season_lead_weeks, 0, 52, "season_lead_weeks");
      if ("season_start_date" in source) {
        const date = cleanId(source.season_start_date);
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return respond(req, 400, { ok: false, error: "invalid_season_start_date" });
        updates.season_start_date = date || null;
      }
      if ("wake_override_at" in source) updates.wake_override_at = source.wake_override_at ? new Date(String(source.wake_override_at)).toISOString() : null;

      payload = { updates };
    }

    if (action === "updateTemplate") {
      const templateKey = cleanId(body.templateKey ?? body.template_key).toLowerCase();
      const channel = cleanId(body.channel || "sms").toLowerCase();
      const text = String(body.body ?? "").trim();
      if (!templateKey || !["warm", "cool", "cold"].includes(templateKey)) return respond(req, 400, { ok: false, error: "invalid_template_key" });
      if (!["sms", "email", "postcard"].includes(channel)) return respond(req, 400, { ok: false, error: "invalid_channel" });
      if (!text || text.length > 5000) return respond(req, 400, { ok: false, error: "template_body_required_or_too_long" });
      payload = { templateKey, channel, subject: cleanId(body.subject), body: text };
    }

    if (action === "updateQueue") {
      const queueId = Number(body.queueId ?? body.queue_id);
      const decision = cleanId(body.decision).toLowerCase();
      if (!Number.isSafeInteger(queueId) || queueId < 1) return respond(req, 400, { ok: false, error: "invalid_queue_id" });
      if (!["approved", "skipped", "never"].includes(decision)) return respond(req, 400, { ok: false, error: "invalid_queue_decision" });
      payload = { queueId, decision };
    }

    if (!["getDashboard", "updateSettings", "updateTemplate", "updateQueue"].includes(action)) {
      return respond(req, 400, { ok: false, error: "unknown_action" });
    }

    const { data, error } = await admin.rpc("ember_operation", {
      p_action: action,
      p_location_id: locationId,
      p_user_id: userId,
      p_payload: payload,
    });
    if (error) {
      if (error.code === "P0002") return respond(req, 404, { ok: false, error: "queue_item_not_found" });
      if (error.code === "55000") return respond(req, 409, { ok: false, error: "queue_item_not_pending" });
      throw error;
    }
    const result = (data || {}) as Json;
    if (result.ok === false) {
      const code = cleanId(result.error);
      const status = code === "ember_location_access_denied" || code.endsWith("_required") ? 403
        : code === "ember_location_not_found" || code === "ember_settings_not_found" ? 404
        : code === "activation_gates_not_met" ? 409 : 400;
      return respond(req, status, result);
    }
    return respond(req, 200, result);
  } catch (error) {
    console.error("ember-operations", action, error);
    return respond(req, 500, { ok: false, error: "ember_operation_failed", message: error instanceof Error ? error.message : "Unknown error" });
  }
});
