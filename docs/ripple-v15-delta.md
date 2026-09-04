# Ripple — v15 Delta: Scheduled Appointments, the Drain & Six Silent Failures

**Session:** 11–12 August 2026 · sits on top of runbook **v12** + **v13 delta**
**Scope:** the trigger moves from *job completed* to *appointment scheduled*; the
send queue finally drains; and six things that were recorded as working turned
out not to be.

> Every fact below was verified against the live database or a live HTTP
> response, not read from the runbook. **The runbook's built/unbuilt marks are
> now as untrustworthy as Appendix B.** Treat both as claims to be checked.

---

## 0. The headline — "built" did not mean built

v13 recorded the scheduled-appointment model as decided and the Control Center
as showing it. The schema said otherwise: no `service_date` column existed
anywhere, and `enqueue_completed_job` had no scheduled sibling. The dashboard
copy still read *"Today's route — yesterday's completed jobs"* because that was
all the data could support.

Six items in this class were found in two days:

| Recorded as | Actually |
|---|---|
| Scheduled-appointment queueing built | No `service_date` column; completion-triggered only |
| `cancel_queued_batch` exists | Did not exist |
| A4 backfill complete | Flag set by hand; `client_addresses` empty |
| `decide_send` safe to call from the browser | No authorisation check at all |
| `tenants` view scoped by RLS | `security_invoker=off`, no filter, all tenants visible |
| Claim writes the contact to HighLevel | Had never once succeeded |

**Standing practice, extended:** verify against the live schema before building,
*and* verify a feature works before recording it as built. A passing unit test
is not a working feature; a deployed function is not a proven one.

---

## 1. Scheduled appointments (migration 0032)

### Schema

```sql
alter table jobs       add column service_date date;
alter table send_queue add column service_date date;
create index send_queue_service_date_idx on send_queue (location_id, service_date);
```

`service_date` is a **DATE, not a timestamptz**, deliberately. The appointment
has a clock time but everything downstream cares about the local calendar day —
the review deadline is the morning after in `config.timezone`. A timestamptz
reintroduces the drift already seen in the job key, where an 8pm Eastern job
files under tomorrow's UTC date.

### `enqueue_completed_job` — new signature

```
enqueue_completed_job(
  p_location_id  text,
  p_job_id       bigint,
  p_address      text        default null,
  p_neighborhood text        default null,
  p_completed_at timestamptz default now(),
  p_service_date date        default null      -- NEW
) returns send_queue
```

Dropped and recreated, **not overloaded** — one oid, checked explicitly, given
the v8 `store_location_token` keystone bug.

- `p_service_date` wins when given; falls back to `jobs.service_date`, then the
  completion date. A completion-triggered install is unchanged.
- Both `batch_id` and `review_deadline` anchor on that date.
- **Reschedule bug fixed.** The old version never updated `completed_at` or
  `review_deadline` on conflict, so a job pushed a week out would still have
  mailed on the original morning. Both now move — but **only while the batch is
  still `pending`**. Once approved or sent, the date is history.
- **`batch_id` is never rewritten.** It is the scan key printed on the card.

### `cancel_queued_batch` — new

```
cancel_queued_batch(p_location_id text, p_ghl_job_id text, p_reason text) returns send_queue
```

Trusting a schedule means a card can be queued for a job that is then cancelled.

- Returns `null` when nothing was queued, and returns the row **untouched** when
  it is already `sending`/`sent` — the caller sees the status and can tell
  somebody, rather than getting a silent success implying the mail was pulled.
- Idempotent and safe to replay: HighLevel retries.
- Membership-checked (owner/admin) or service-role.

### Verified end to end

| Probe | Result |
|---|---|
| Queue for a service date +3d | `B20260814-30`, deadline 15 Aug 10:00 EDT |
| Does a future batch appear in `send_queue_due`? | No — invisible until the date passes |
| Reschedule to +10d | Date and deadline both moved |
| `batch_id` after reschedule | Frozen |
| Cancel | `skipped` |
| Cancel replayed / cancel unqueued job | Idempotent, `null` no-op |
| Cancel after print | Returns `sent`, unchanged |

---

## 2. `ghl-intake` — three appointment events

Routed on `body.customData.event` as before:
`appointment_scheduled | appointment_rescheduled | appointment_cancelled`.

### The job key changed, and it matters

`jobs.ghl_job_id` is now `ghl:appt:<appointment_id>` when the workflow supplies
one, falling back to the synthesized `ghl:<contact_id>:<date>`.

The synthesized key is **unsafe under scheduling**, two ways, both ending in a
doubled mailing:

1. **Reschedule** — a date-derived key changes when the date changes, minting a
   new job, a new batch, and orphaning the original.
2. **The same job seen twice** — scheduled (one webhook) and later completed
   (another). Keyed on contact+date those are two different jobs.

The appointment id is stable across both, so `enqueue`'s upsert on
`(location_id, job_id)` collapses them into one batch.

**Every appointment workflow MUST map `{{appointment.id}}` into
`customData.appointment_id`.** Without it the batch still queues, but
reschedules and cancellations cannot find it — the function logs a warning.

### Date parsing

`parseServiceDate()` accepts `YYYY-MM-DD` as-is, US `M/D/YYYY`, and full ISO
timestamps converted **in the client's timezone**. Junk returns null and the
handler skips rather than defaulting to today and mailing tomorrow for a job
three weeks out. 12 cases tested: `2026-08-14T01:00:00Z` correctly resolves to
the **13th** in New York and the **14th** in Manila.

### Judgement calls worth preserving

- **The backfill gate is NOT applied at scheduling.** Queueing is not sending;
  `send-postcards` re-checks `can_send()` and fails closed. Blocking here would
  hide the whole week ahead from an owner whose backfill has not finished.
- **`completed_at` stays null on a scheduled job.** Stamping it would make an
  unserviced address look serviced to anything reading `jobs`.
- **The address still enters `client_addresses`, without `last_job_at`.** They
  are a customer the moment they book; nothing has been serviced yet.
- **Cancelling without an appointment id skips rather than guesses** — matching
  on contact could pull the wrong batch for a customer with two appointments.

---

## 3. `drain-queue` — the loop finally closes (NEW function)

`supabase functions deploy drain-queue --no-verify-jwt`.
Guarded by **`RIPPLE_CALLER_SECRET`** (it spends money), not the intake secret.
Hourly cron is enough — deadlines land at `config.review_hour` in each client's
timezone, so an hourly tick catches every zone.

```
pending → (owner decides, or deadline passes) → approved → sending → sent | failed
```

- **Auto-approve** via `decide_send(batch, cards, null)`. Null `p_user` is the
  audit trail for "machine decided".
- **The lease is a status flip**, `.eq('status','approved')`, so of two
  overlapping ticks only the one that changed the row proceeds. **Not** an
  advisory lock — session-scoped Postgres features do not survive the pooler.
- **`dryRun: true`** lists what would mail and restores the lease it took. Use it
  before every first run against a new client.

### Two decisions encoded

- **`expired` has no writer, deliberately.** Decision on record: **no staleness
  ceiling**. A late card still mails. Lateness is computed from `service_date`,
  flagged past 5 days in the run log, and never enforced. `expired` is dead
  status, not an unbuilt feature.
- **A thrown send leaves the row in `sending`.** thanks.io may already hold the
  order, so an unknown outcome is not retried. A stuck row is a visible problem;
  a double mailing is an invisible one.

---

## 4. Security — three holes, all live, all closed

### 0029 — three views leaked every tenant

`tenants`, `billing_balances` and `send_queue_due` all ran
`security_invoker = off` with **no tenancy filter**, and all three are exposed
through PostgREST. Changing `?loc=` in the dashboard URL returned any client's
config; `billing_balances` handed out every client's billing mode, card-on-file
status and balance.

Fixed at the **view**, not the caller — the anon key is printed in every portal
page, so anyone can query these directly regardless of what the page does. One
shared predicate:

```sql
caller_can_see_location(p_location_id text) returns boolean
```

Service role and direct DB connections pass; a user session must be a member or
super admin. Measured: franchise admin sees **1** tenant, super admin **3**,
anon key alone **0**. The `company:%` filter from 0012, which had been lost from
`tenants`, is restored.

### 0030 — `decide_send` had no authorisation

SECURITY DEFINER, called from the browser, keyed only on `batch_id`. Any
signed-in user who knew or guessed a batch id could approve, cancel or resize
another franchise's mailing, and `decided_by` was written from an unvalidated
argument so the audit trail could be forged.

Now requires owner/admin membership, super admin, or service role. `p_user` is
**ignored for user sessions** and taken from `auth.uid()`. Added the spend
backstop v13 asked for: the ceiling is `config.radius_count` or
`proposed_cards`, whichever is larger. The error message for another tenant's
batch is identical to one that does not exist, so the API cannot enumerate
batch ids.

**Still open:** `send_queue` carries an UPDATE policy letting an owner write the
table directly from the browser, bypassing that ceiling. Their own money, but it
is a hole in a guard we deliberately built.

### 0033 — `can_send` trusted a timestamp

The gate checked `address_backfill_completed_at is not null`. A4 had it set by
hand during testing while `client_addresses` held **zero rows** — so the gate
said go while suppression had nothing to compare against. Proven, not inferred:
a row inserted the old way returns verdict `ok` from `check_suppression`.

`can_send` now requires the cache to contain rows. The phantom flag was cleared;
all three locations correctly refuse to send.

---

## 5. Suppression — the write side was missing

`check_suppression` is **status-aware** (verified): presence alone does not
suppress; it needs a status in `config.never_mail_statuses` or a `last_job_at`
inside the lapse window. That resolved the WF2 blocker v13 recorded.

But nothing wrote `status`. A synced contact arrived with null status and null
`last_job_at`, which reads as a **lead** — so nothing was suppressed at all.
The mirror-image failure, and the worse direction.

- `handleContactSync` now writes `status` + `status_synced_at`.
- **`last_job_at` is deliberately untouched.** It records that work was done,
  which only the job path knows. One column, one meaning — which is what keeps
  two competing notions of "is a customer" out of the suppression logic.
- **A blank status never overwrites a known one.** An unmapped merge field
  arrives as `""`; writing it would silently un-suppress a customer.
- Response returns `suppressing: true/false` so the first test call shows
  whether the mapping took.

Verified live: `Active` → `existing_customer`, `Lead` → `ok`, and re-syncing the
same address with a changed status **flips the verdict** — the churn/convert
transition works.

### `never_mail_statuses` is `["Active","active"]` for all three locations

Nothing has confirmed this matches any client's actual HighLevel vocabulary.
**Run the backfill dry run and read `status_values_found` before trusting it.**

---

## 6. Address backfill workflow — rewritten (v2)

The old `Store Address` node wrote `location_id, addr_hash, ghl_contact_id,
source, last_seen_at` — **no status**. Post-0033 that is worse than useless: it
creates thousands of rows, satisfies the row-count gate, opens `can_send`, and
suppresses nobody.

Changes:

- **Status captured and written**, from `status`/`contactStatus`/`type`/
  `contactType`, then any custom field with "status" in the key.
- **Dry run** (`dryRun: "true"`) reports what it would write and touches
  nothing. Pinned input is A4 + dry run, so an accidental manual run is safe.
- **Dedup keeps the row that has a status.** Two contacts at one address was
  last-write-wins; a blank duplicate would un-suppress the household.
- **Bulk insert, 500 rows per statement.** The old node ran one query per
  contact. It also passed values through `queryReplacement`, which **splits on
  commas** — a status like `Bob's, Active` would corrupt the parameter list
  (the WF0 bug). Values are now validated to a strict charset and escaped as
  literals; no parameters involved.
- **The gate only opens if rows exist**, independently of 0033.

### A4's dry run: 5 contacts, 0 with addresses, 5 skipped

Existing-customer suppression has **nothing to work with** for this client. The
cache will be built almost entirely by workflows 2a/2b and route 3 (every
completed job adds its own service address) going forward. That reframes 2a/2b
from "nice incremental sync" to **the primary mechanism**.

---

## 7. The claim → HighLevel write had never worked

Two claims, 4 and 11 August, both with `ghl_contact_id` null. The log:

```
400 "This location does not allow duplicated contacts"
meta: { contactId: "ag0ZCx4Sfncc8jMSj7EX", matchingField: "phone" }
```

**Matched on phone, not email.** The code read only `cbody.contact.id` and
`cbody.id`, saw no id, and called it a failure.

**This will be common in production, not rare.** A neighbour who once called for
a quote, or is in the database from a previous season, hits this path — and
those are among the most likely converters.

Fixed in `landing/index.ts`:

- Falls back to `meta.contactId`.
- Applies custom fields via `PUT /contacts/{id}` and tags via
  `POST /contacts/{id}/tags` — **separately**, because PUT replaces the tag
  array and would strip whatever the client already had.
- Returns `matchedExisting` in the response.

### Migration 0034 — `crm_error` + `crm_attempted_at` on `prize_visits`

The reason a sync failed existed only in the HTTP response and `console.error`.
Best-effort is fine; **silent is not**. Plus a partial index over
claimed-but-unsynced rows — the work queue that makes best-effort acceptable.

---

## 8. Front end

### Super Admin — one Manage panel

Seven-item kebab replaced by **Open** + **Manage**. Eight sections behind one
Save: General, HighLevel, Landing page, Prizes, Look and feel, Mail and billing,
Users and roles, Danger zone. Panes stay in the DOM so a draft survives section
switching; validation pulls the offending section forward.

Three things removed rather than carried over:

- **The fake HighLevel modal** let you type a location id and locally pretend it
  linked. A location only exists via OAuth; it is now read-only status plus a
  real `startInstall` button.
- **Delete** only filtered the local array behind a `TODO`. Gone; Danger zone
  explains that a location leaves by uninstalling the app.
- **The zeroed usage strip** replaced by a readiness checklist built from real
  columns, each row clicking through to the section that fixes it.

### Owner dashboard — prize editor + schedule views

- **Edit Prize Pool was a dead `<a href="#">`.** Wiring it up was not enough:
  `config` has only a SELECT policy and `admin-operations.setPrizeWeights` is
  super-admin gated, so an owner had **no write path**. Migration **0028**
  `set_prize_weights()` is that path — membership-checked, validates shape,
  and **rejects duplicate `idx`**, closing the v12 sharp edge where renumbering
  silently reassigns what a past claimant won. Both editors now preserve idx.
- **"Today's route" → "Mailing schedule"** with Day / Week / Month over
  `service_date`. Defaults to **tomorrow**, and jumps forward to the next day
  with work rather than opening on an empty screen. Sent batches render locked.
  Rows with no `service_date` appear in a "No service date" group so they cannot
  mail off-screen.

### Booking page — dates and a host-containment bug

- **Two days' lead time, weekdays only**, in one `whyNotBookable()` used by the
  chips, the native picker and the submit check. If the lead lands on a weekend
  it rolls to Monday. Saturday had never been excluded (only Sunday), the native
  picker was unguarded, and `min`/`max` used `toISOString()` — UTC — so after
  8pm Eastern the floor silently slipped a day.
- **The code block contained a whole HTML document.** `<!DOCTYPE html><html>
  <head><body>` nested inside GHL's page. The parser discards the inner tags but
  **keeps the `<style>`**, so `body { display:flex; align-items:center }` was
  restyling the entire host page, along with leaking `html`, `form`, `input` and
  `:root` rules. That was the real cause of the mobile overflow.

> **House rule, now explicit: GHL custom code takes a FRAGMENT, not a document.**
> The landing page and the portal pages are likely built the same way. Check
> them.

Rebuilt as `#ripple-booking` with all 72 selectors scoped, host containment via
`.c-column:has(#ripple-booking)` (precise — only the containers holding this
widget), and the scroll row capped against the **viewport**
(`min(100%, calc(100vw - 40px))`) because a percentage resolves against a
shrink-to-fit parent's max-content and never triggers the scroll.

---

## 9. Secrets — the operational lesson

Three separate breakages in one day from the same cause. State it plainly:

| Secret | Guards | Who holds a copy |
|---|---|---|
| `RIPPLE_INTAKE_SECRET` | `ghl-intake` | **Every GHL workflow webhook header** |
| `RIPPLE_CALLER_SECRET` | `send-postcards`, `drain-queue` | Nothing outside Supabase |

- Supabase **never displays a secret value**, only a digest. Compare by hashing
  a candidate, or just fire a probe request — the function's answer is the only
  authoritative one.
- Rotating the intake secret breaks **every** workflow whose header is not
  updated in the same sitting. HighLevel logs the 401 and moves on; the event is
  **lost, and does not replay** when the secret is fixed.
- Keep a written list of every place the intake secret is pasted. That list is
  the rotation checklist. Without it, rotation is archaeology.
- The two values must never converge. The intake secret ships inside the client
  snapshot; the caller secret spends postage.

---

## 10. Migrations added (0028–0034)

| File | What it does |
|---|---|
| 0028_set_prize_weights | Owner-portal write path for `config.prize_weights`; rejects duplicate idx |
| 0029_scope_tenant_views | `caller_can_see_location()`; scopes `tenants`, `billing_balances`, `send_queue_due` |
| 0030_decide_send_authorisation | Membership check, `decided_by` from session, spend ceiling |
| 0031_send_queue_notified_at | `notified_at` + partial index (notifier still unbuilt) |
| 0032_scheduled_service_date | `service_date` on `jobs`/`send_queue`; enqueue gains `p_service_date`; `cancel_queued_batch` |
| 0033_can_send_requires_populated_cache | Gate requires rows, not a timestamp; clears phantom flags |
| 0034_prize_visits_crm_error | `crm_error` + `crm_attempted_at`; work-queue index |

## Edge Functions

| Function | Status |
|---|---|
| `ghl-intake` | REDEPLOYED — appointment events, appointment-id job key, contact_sync status |
| `landing` | REDEPLOYED — duplicate-contact fallback, crm outcome persisted |
| `drain-queue` | **NEW** — deployed, dry run clean |
| `send-postcards` | Redeployed for the caller-secret rotation; code unchanged |
| `admin-operations` | Unchanged |

---

## 11. Open items

**Blocking the first real postcard — the single critical path**

`client_addresses` is empty platform-wide, so `can_send` refuses for all three
locations and nothing can mail. A4's contacts carry no usable addresses, so the
backfill will not populate it either. **Workflow 2a is therefore not an
incremental nicety — it is the only realistic route to a populated cache**, with
route 3 (each completed job contributes its own service address) filling in over
time.

2a needs three things, and one is genuinely unknown:

1. Webhook to `ghl-intake`, `customData.event = contact_sync`, current
   `x-ripple-secret`.
2. `customData.status` carrying a value that matches
   `config.never_mail_statuses` (currently `["Active","active"]` for all three).
   **A4's dry run returned an empty `status_values_found`, so nobody knows what
   their Status field actually contains.** Answer that before building.
3. An exclusion filter for Ripple-created contacts — Source "Ripple neighbour
   postcard" plus the `ripple_neighbor` tag — or a claim creates a contact,
   which fires 2a, which feeds back into Ripple.

**Known holes**

- `send_queue` UPDATE policy bypasses the `decide_send` ceiling.
- Nothing writes `notified_at`; auto-approve is silent. Acceptable while Mike
  watches every batch, not acceptable for a franchise owner.
- Client-side only: `claim_prize` accepts any `booking_date`, including a
  weekend or same-day. Enforce in the function if it matters.
- No UI anywhere lists claimed leads. `prize_visits` is visible only in Supabase.
  A "Recent claims" card — name, address, prize, requested date, CRM-sync flag —
  is the smallest fix.

**Manual, outstanding**

- HighLevel contact `ag0ZCx4Sfncc8jMSj7EX` (Lindsay Adcock) needs
  `ripple_neighbor`, `ripple_booked`, `ripple_morning`, `sms_consent` added by
  hand. Without `ripple_neighbor` her completed job will not register as a won
  ripple.
- The intake secret needs pasting into every remaining `ghl-intake` webhook.

**Hygiene**

- The repo's `landing/index.ts` was **eight versions behind production** (6,552
  bytes on disk vs 21,828 deployed) and a deploy briefly rolled it back. Pull
  all five functions down from Supabase and commit them.
- Regenerate Appendix B from `information_schema`. Now ~17 wrong facts across
  three sessions.
