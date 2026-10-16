# FieldRoutes → Matrix workflow → Ripple Mailing Schedule

## Implemented
- Supabase Edge Function: `ripple-matrix-appointment` (separate authenticated webhook receiver).
- Map incoming `officeID` to exactly one existing `public.config.fieldroutes_office_id`. Unknown/ambiguous offices are rejected, never mapped by client-provided location IDs.
- Scheduled/rescheduled events upsert `jobs` and `send_queue` using immutable key `fr:appt:<appointmentID>`. A scheduled event sets no completion timestamp.
- Completion event stamps completion; cancellation skips an unsent queue row; technician information is copied to `assigned_technicians`.
- `send_queue_due` and `send-postcards` now require service completion for jobs with `fr:appt:` prefix. No lookup or postcard spend occurs from mere scheduling.
- Audit table: `public.ripple_appointment_sync_events` (internal only; RLS enabled).
- Existing Matrix contact-creation and updates are unchanged.

## Setup required before activating
1. Ask the FieldRoutes admin for the exact `officeID` of the Ripple location. The Boggs location is `0mlZlQJf3q9VUxb5z0hM`; as of deployment its `fieldroutes_office_id` is **not configured**. Populate that field only after confirming ownership/mapping. Each office ID must be unique across locations.
2. In Supabase project `dhizayohljxioxxzkhty`, add a strong independent Edge Function secret named `RIPPLE_MATRIX_FORWARD_SECRET`. Do not reuse `RIPPLE_CALLER_SECRET` because that credential authorizes postcard sending. Store the secret in a password manager, not in this repo.
3. In the **existing Matrix inbound FieldRoutes appointment workflow**, add a Custom Webhook after the shared **Note** step, which both Contact Found and Contact Not Found paths reach. Keep the Find, Update, Create, Note and Go To actions unchanged.
4. Set action to **CUSTOM → POST**, Content-Type `application/json`, URL `https://dhizayohljxioxxzkhty.supabase.co/functions/v1/ripple-matrix-appointment`. Choose **No authentication** and add header `x-ripple-secret` with the newly configured independent secret.
5. Use the dynamic value picker to map the inbound webhook fields shown below; DO NOT paste unresolved placeholder syntax unless verified in the HighLevel workflow preview. `event` is a static value representing the event type this workflow actually receives.

## Example outbound body, replace VALUE_FROM_INBOUND with HighLevel's dynamic picker outputs
```json
{
  "event": "appointment_scheduled",
  "officeID": "VALUE_FROM_INBOUND_officeID",
  "appointmentID": "VALUE_FROM_INBOUND_appointmentID",
  "customerID": "VALUE_FROM_INBOUND_customerID",
  "address": "VALUE_FROM_INBOUND_address",
  "city": "VALUE_FROM_INBOUND_city",
  "state": "VALUE_FROM_INBOUND_state",
  "zip": "VALUE_FROM_INBOUND_zip",
  "serviceDate": "VALUE_FROM_INBOUND_serviceDate",
  "serviceStartTime": "VALUE_FROM_INBOUND_serviceStartTime",
  "serviceEndTime": "VALUE_FROM_INBOUND_serviceEndTime",
  "techName": "VALUE_FROM_INBOUND_techName",
  "servicedBy": "VALUE_FROM_INBOUND_servicedBy",
  "techEmail": "VALUE_FROM_INBOUND_techEmail"
}
```
**Important:** The provided FieldRoutes sample has NO event-type field. Do not map all incoming events to `appointment_scheduled`. Use separate workflows/branches or an actual event/status field for `appointment_rescheduled`, `appointment_cancelled`, and `service_completed` events.

## Functional validation (no real postcards)
- Set a future-dated test appointment and check the Custom Webhook action response. Expected JSON includes `ok:true`, `event:"scheduled"`, `locationId`, `jobId`, `serviceDate`, `mailingEligible:false`.
- Verify one row in `jobs` and `send_queue` with matching `fr:appt:` job key; both `completed_at` fields must be NULL.
- Refresh the Ripple Dashboard and open the Day/Week/Month covering the service date. Technician filter displays `techName`.
- Reschedule before approval: original queue is updated, not duplicated. Cancel: it becomes skipped and never sends. Post-approval reschedules require manual review.
- Only after a verified `service_completed` event should both completion timestamps be present; this allows (but does not force) mailing under existing review, cap and authorization gates.
- The receiver logs ingestion status to `ripple_appointment_sync_events`; it must not be used to replay private customer addresses blindly.
- Unmapped office returns HTTP 422; missing/incorrect `x-ripple-secret` returns 401 (missing server secret returns 503).

## Operational caveats
- GitHub changes do not configure the Matrix workflow automatically. HighLevel workflow needs a human to add/authorize/publish the custom outbound action.
- Merely enabling the FieldRoutes → Matrix inbound webhook does not enable outbound forwarding.
- Previously created appointments require a separately reviewed historical backfill.
- Server-side deployment and configuration inventory have been verified, but no authenticated live end-to-end booking test has yet been executed.
