/**
 * landing — public endpoints for the scratch-card page.
 *
 * The prototype rolled the prize in JavaScript, which meant ?prize=3 handed
 * out the top offer and nothing could enforce a cap. The roll now happens
 * here, once per visitor, and the browser is told only what it won.
 *
 * Endpoints (all public — deploy with --no-verify-jwt):
 *   POST /landing/arrive  { b, sig, token? } -> theme, street, prize, token
 *   POST /landing/reveal  { token }          -> stamps revealed_at
 *
 * The claim lives in the booking flow, not here: revealing must not consume
 * prize inventory, or a bounce visitor burns the one "first treatment free".
 *
 * NOTE ON SIGNING: the QR payload is verified with _shared/qrsign.ts, the same
 * module the send path uses to build it. If the export names differ from
 * `verifyPayload`, that import is the only line to change.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { verifyPayload } from '../_shared/qrsign.ts';
// The canonical address hasher. There is no SQL equivalent by design — the
// send path, n8n and this function must all produce the SAME hash, so there is
// one implementation and everything imports it.
import * as addressMod from '../_shared/address.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * Resolve the canonical hasher without hard-coding an export name.
 * If none of the usual names match, the error lists what the module DOES
 * export, so the right one can be wired in a single edit.
 */
function canonicalAddrHash(address: string): string {
  const names = ['addrHash', 'addressHash', 'canonicalAddressHash',
                 'hashAddress', 'canonicalHash', 'normalizeAndHash', 'default'];
  for (const n of names) {
    const fn = (addressMod as any)[n];
    if (typeof fn === 'function') return fn(address);
  }
  throw new Error(
    'No address hasher found in _shared/address.ts. Exports available: ' +
    Object.keys(addressMod).join(', '),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  try {
    // -----------------------------------------------------------------
    // /arrive — verify the QR, roll (or re-read) the prize, theme the page
    // -----------------------------------------------------------------
    if (route === 'arrive') {
      // Payload as built by buildQrPayload(): b=batch a=addrHash p=prizeIdx s=sig
      const batchId = String(body.b ?? body.batch ?? '');
      const addrHash = String(body.a ?? body.addr ?? '');
      const prizeIdx = Number(body.p ?? body.prize ?? 0);
      const sig = String(body.s ?? body.sig ?? '');

      if (!batchId || !addrHash || !sig) {
        return json({ error: 'This code is incomplete.' }, 400);
      }

      // The QR carries no location, so resolve the card first. This is a
      // lookup, not a trust decision — the signature below is what proves the
      // card is genuine.
      const { data: ctxRows, error: ctxErr } = await admin.rpc('recipient_context', {
        p_batch_id: batchId,
        p_addr_hash: addrHash,
      });
      if (ctxErr) throw ctxErr;
      const rc = Array.isArray(ctxRows) ? ctxRows[0] : ctxRows;
      if (!rc?.location_id) {
        return json({ error: 'This code could not be verified.' }, 403);
      }

      const { data: cfg, error: cfgErr } = await admin
        .from('config')
        .select('location_id, client_name, brand_logo_url, booking_url, ghl_calendar_id, ' +
                'prize_weights, paused, theme, landing_template, hmac_secret')
        .eq('location_id', rc.location_id)
        .maybeSingle();
      if (cfgErr) throw cfgErr;
      if (!cfg) return json({ error: 'This offer is no longer available.' }, 404);
      if (cfg.paused) return json({ error: 'This offer has ended.' }, 410);
      if (!cfg.hmac_secret) {
        return json({ error: 'This offer is not fully set up yet.' }, 500);
      }

      const ok = await verifyPayload(
        cfg.hmac_secret,
        { batch: batchId, addr: addrHash, prize: prizeIdx },
        sig,
      );
      if (!ok) return json({ error: 'This code could not be verified.' }, 403);

      const token = body.token && /^[0-9a-f-]{36}$/i.test(String(body.token))
        ? String(body.token) : null;

      // NOTE: prizeIdx from the QR is intentionally ignored. A prize fixed at
      // print time cannot respect a cap — 40 cards promising a prize capped at
      // 10 means 30 refusals. The roll happens here, once per household.
      const { data: visit, error: rollErr } = await admin.rpc('arrive_prize_visit', {
        p_location_id: rc.location_id,
        p_batch_id: batchId,
        p_job_id: rc.job_id ?? null,
        p_token: token,
        p_addr_hash: addrHash,
      });
      if (rollErr) {
        if (/exhausted|no prizes configured/i.test(rollErr.message)) {
          return json({ error: 'All the offers for your street have been claimed.' }, 409);
        }
        throw rollErr;
      }

      const v = Array.isArray(visit) ? visit[0] : visit;
      const prize = (cfg.prize_weights || []).find((x: any) => x.idx === v.prize_idx) || {};

      const { data: bookBase } = await admin.rpc('resolve_booking_page', {
        p_location_id: rc.location_id,
      });

      const theme = (cfg.theme && typeof cfg.theme === 'object') ? cfg.theme : {};

      return json({
        token: v.visit_token,
        street: rc.street || null,
        theme,
        template: cfg.landing_template || 'scratch',
        bookUrl: bookBase || null,
        brand: {
          name: cfg.client_name,
          logo: cfg.brand_logo_url || (theme as any).logo || null,
        },
        prize: {
          label: prize.label || 'A neighbour-only offer',
          sub: prize.sub || '',
        },
        claimed: !!v.claimed_at,
        promoCode: v.promo_code || null,
        revealed: !!v.revealed_at,
        canBook: !!(cfg.ghl_calendar_id || cfg.booking_url),
      });
    }

    // -----------------------------------------------------------------
    // /reveal — they scratched. Records the funnel step; costs no inventory.
    // -----------------------------------------------------------------
    if (route === 'reveal') {
      const token = String(body.token ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ error: 'bad token' }, 400);

      const { data: rows, error } = await admin
        .from('prize_visits')
        .update({ revealed_at: new Date().toISOString() })
        .eq('visit_token', token)
        .is('revealed_at', null)
        .select('location_id, batch_id, job_id, prize_idx');
      if (error) throw error;

      const v = (rows || [])[0];
      if (v) {
        await admin.from('events').insert({
          location_id: v.location_id,
          job_id: v.job_id,
          type: 'reveal',
          prize_code: String(v.prize_idx),
        });
      }
      return json({ ok: true });
    }

    // -----------------------------------------------------------------
    // /visit — context for the booking page. Token only; no signature,
    // because the token was already earned by a verified arrival.
    // -----------------------------------------------------------------
    if (route === 'visit') {
      const token = String(body.token ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ error: 'bad token' }, 400);

      const { data: v, error } = await admin
        .from('prize_visits')
        .select('visit_token, location_id, batch_id, addr_hash, prize_idx, claimed_at, ' +
                'promo_code, booking_window, booking_date')
        .eq('visit_token', token)
        .maybeSingle();
      if (error) throw error;
      if (!v) return json({ error: 'We could not find your offer.' }, 404);

      const { data: cfg } = await admin
        .from('config')
        .select('client_name, brand_logo_url, prize_weights, theme')
        .eq('location_id', v.location_id)
        .maybeSingle();

      const prize = ((cfg?.prize_weights) || []).find((x: any) => x.idx === v.prize_idx) || {};

      // Street, city, state and ZIP are known from the batch; the house number
      // is not, because one QR serves the whole street. The form asks only for
      // the number. Deliberately no address list: showing a visitor which of
      // their neighbours got mail is not ours to share.
      const { data: ctx } = await admin.rpc('batch_address_context', {
        p_location_id: v.location_id,
        p_batch_id: v.batch_id,
      });
      const c = Array.isArray(ctx) ? ctx[0] : ctx;

      const theme = (cfg?.theme && typeof cfg.theme === 'object') ? cfg.theme : {};

      return json({
        theme,
        brand: { name: cfg?.client_name, logo: cfg?.brand_logo_url || (theme as any).logo || null },
        prize: { label: prize.label || 'Your neighbour offer', sub: prize.sub || '' },
        address: {
          // full is present when the card is per-recipient: the booking form
          // then shows it read-only instead of asking for a house number.
          full: c?.address || null,
          street: c?.street || null,
          city: c?.city || null,
          state: c?.region || null,
          postal_code: c?.postal_code || null,
        },
        claimed: !!v.claimed_at,
        promoCode: v.promo_code || null,
        bookingWindow: v.booking_window || null,
        bookingDate: v.booking_date || null,
      });
    }

    // -----------------------------------------------------------------
    // /claim — commits the prize to a household and books the lead.
    // -----------------------------------------------------------------
    if (route === 'claim') {
      const token = String(body.token ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ error: 'bad token' }, 400);

      const name = String(body.name ?? '').trim();
      const phone = String(body.phone ?? '').trim();
      const email = String(body.email ?? '').trim();
      const houseNo = String(body.house_number ?? '').trim();
      const window_ = String(body.booking_window ?? '').trim();
      const bookingDate = String(body.booking_date ?? '').trim();

      if (!name) return json({ error: 'Please tell us your name.', field: 'name' }, 400);
      if (!phone && !email) {
        return json({ error: 'Please leave a phone number or an email so we can confirm.', field: 'phone' }, 400);
      }
      // Only required when the visit has no address from the QR.
      if (!['morning', 'afternoon'].includes(window_)) {
        return json({ error: 'Please choose morning or afternoon.', field: 'booking_window' }, 400);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) {
        return json({ error: 'Please choose a day.', field: 'booking_date' }, 400);
      }
      // Validated server-side as well as in the page: a date in the past or
      // years out is a broken request, not a booking anyone will honour.
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const picked = new Date(bookingDate + 'T00:00:00');
      const maxDay = new Date(today); maxDay.setDate(maxDay.getDate() + 60);
      if (isNaN(picked.getTime()) || picked < today || picked > maxDay) {
        return json({ error: 'Please choose a day within the next two months.', field: 'booking_date' }, 400);
      }

      const { data: v0 } = await admin
        .from('prize_visits')
        .select('location_id, batch_id, prize_idx, addr_hash, job_id')
        .eq('visit_token', token)
        .maybeSingle();
      if (!v0) return json({ error: 'We could not find your offer.' }, 404);

      const { data: cfgClaim } = await admin
        .from('config')
        .select('ghl_fields, prize_weights')
        .eq('location_id', v0.location_id)
        .maybeSingle();

      let fullAddress: string;
      let addrHash: string;
      let c: any = null;

      if (v0.addr_hash) {
        // Address came from the signed QR. Trust it over anything typed.
        const { data: rows } = await admin.rpc('recipient_context', {
          p_batch_id: v0.batch_id,
          p_addr_hash: v0.addr_hash,
        });
        c = Array.isArray(rows) ? rows[0] : rows;
        fullAddress = c?.address || '';
        addrHash = v0.addr_hash;
      } else {
        if (!houseNo) {
          return json({ error: 'Please add your house number.', field: 'house_number' }, 400);
        }
        const { data: ctx } = await admin.rpc('batch_address_context', {
          p_location_id: v0.location_id,
          p_batch_id: v0.batch_id,
        });
        c = Array.isArray(ctx) ? ctx[0] : ctx;
        fullAddress = houseNo + ' ' + (c?.street || '');
        // Hash with the same module the send path uses, so this compares like
        // with like against mailed.addr_hash.
        addrHash = canonicalAddrHash(fullAddress);
      }

      // claim_prize enforces one claim per household, across devices.
      const { data: claimed, error: claimErr } = await admin.rpc('claim_prize', {
        p_token: token,
        p_name: name,
        p_phone: phone || null,
        p_email: email || null,
        p_address: fullAddress,
        p_window: window_,
        p_addr_hash: addrHash,
      });
      if (claimErr) {
        if (/already been claimed/i.test(claimErr.message)) {
          return json({ error: 'This offer has already been claimed for your address.' }, 409);
        }
        throw claimErr;
      }
      const v = Array.isArray(claimed) ? claimed[0] : claimed;

      // Consent is recorded verbatim, with a timestamp. Never inferred.
      const consent = body.consent_sms === true;
      await admin.from('prize_visits').update({
        booking_date: bookingDate,
        consent_sms: consent,
        consent_text: consent ? String(body.consent_text ?? '').slice(0, 500) : null,
        consent_at: consent ? new Date().toISOString() : null,
        consent_ip: req.headers.get('x-forwarded-for') || null,
      }).eq('visit_token', token);

      // Push the lead into HighLevel. Wrapped: a CRM failure must not lose a
      // claim the customer has already completed — the row is the record.
      let contactId: string | null = null;
      let crmDetail: string | null = null;
      let duplicateOf: string | null = null;
      try {
        const { data: rows } = await admin
          .from('oauth_tokens')
          .select('provider, access_token_secret_id, status')
          .eq('location_id', v0.location_id);
        const row = (rows || []).find((r: any) =>
          r.access_token_secret_id && String(r.provider || '').toLowerCase() !== 'thanksio');

        if (!row) {
          crmDetail = 'no HighLevel token row for this location';
          console.error('[claim]', crmDetail, v0.location_id);
        }

        if (row) {
          const { data: tok, error: tokErr } = await admin.rpc('read_oauth_secret', { p_secret_id: row.access_token_secret_id });
          if (!tok) {
            crmDetail = 'could not read the HighLevel token: ' + (tokErr?.message || 'empty secret');
            console.error('[claim]', crmDetail);
          }
          if (tok) {
            // Custom fields, when the client has them mapped. Anything not
            // mapped still goes out as a tag and in the note, so a missing ID
            // degrades rather than losing the information.
            const fieldMap = (cfgClaim?.ghl_fields && typeof cfgClaim.ghl_fields === 'object')
              ? cfgClaim.ghl_fields as Record<string, string> : {};
            const prizeName = ((cfgClaim?.prize_weights) || [])
              .find((x: any) => x.idx === v0.prize_idx)?.label || '';

            const customFields: Array<{ id: string; value: string }> = [];
            const addField = (key: string, value: string) => {
              const id = fieldMap[key];
              if (id && value) customFields.push({ id, value });
            };
            // Keys match the fields already set up in HighLevel.
            addField('source_job', v0.job_id || '');           // ripple_source_job
            addField('prize_code', v.promo_code || '');        // ripple_prize_code
            addField('card_id', c?.mailing_id || '');          // thanksio_mailing_id
            addField('first_touch', new Date().toISOString().slice(0, 10)); // date field: YYYY-MM-DD
            // Kept as two fields so a workflow can act on the date directly
            // rather than parsing it back out of a combined string.
            addField('preferred_date', bookingDate);           // 2026-08-07
            addField('preferred_time', window_);               // morning | afternoon
            addField('prize', prizeName);                      // optional extra

            const parts = name.split(' ');
            const res = await fetch('https://services.leadconnectorhq.com/contacts/', {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + tok,
                Version: '2021-07-28',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                locationId: v0.location_id,
                firstName: parts[0],
                lastName: parts.slice(1).join(' ') || undefined,
                email: email || undefined,
                phone: phone || undefined,
                address1: fullAddress,
                city: c?.city || undefined,
                state: c?.region || undefined,
                postalCode: c?.postal_code || undefined,
                source: 'Ripple neighbour postcard',
                // Underscores, matching ghl-intake's filters and the runbook.
                // A hyphenated tag here would never match c.tags.includes(
                // "ripple_neighbor"), so workflow 1 could not tell a claimed
                // neighbour from a normal customer and every win would
                // re-ripple.
                tags: [
                  'ripple_neighbor',
                  'ripple_booked',
                  'ripple_' + window_,
                  consent ? 'sms_consent' : 'no_sms_consent',
                ],
                ...(customFields.length ? { customFields } : {}),
              }),
            });
            const cbody = await res.json().catch(() => ({}));
            contactId = cbody?.contact?.id || cbody?.id || null;

            // DUPLICATE CONTACTS.
            // A sub-account with "allow duplicate contacts" off answers a
            // create for an existing email or phone with HTTP 400 and the id
            // of the contact it matched, in meta.contactId. Treating that as
            // a failure loses the lead for exactly the people most likely to
            // respond - anyone already in the client's database. It is also
            // why every test claim failed: the test emails already existed.
            const dupeId = cbody?.meta?.contactId || null;
            if (!contactId && dupeId) {
              contactId = dupeId;
              duplicateOf = String(cbody?.meta?.matchingField || 'existing contact');

              // The create was refused, so none of the tags or fields landed.
              // Apply them to the contact HighLevel matched, or a returning
              // customer keeps the record they had before they claimed.
              await fetch('https://services.leadconnectorhq.com/contacts/' + contactId, {
                method: 'PUT',
                headers: {
                  Authorization: 'Bearer ' + tok,
                  Version: '2021-07-28',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  ...(customFields.length ? { customFields } : {}),
                }),
              }).catch(() => {});

              // Tags go through their own endpoint: PUT replaces the array and
              // would strip whatever the client already had on the contact.
              await fetch('https://services.leadconnectorhq.com/contacts/' + contactId + '/tags', {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + tok,
                  Version: '2021-07-28',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  tags: [
                    'ripple_neighbor',
                    'ripple_booked',
                    'ripple_' + window_,
                    consent ? 'sms_consent' : 'no_sms_consent',
                  ],
                }),
              }).catch(() => {});
            }

            // Log the refusal. Swallowing it protects the customer's claim but
            // leaves no trace of WHY the CRM write failed — which is how a
            // silent sync failure survives a whole test run.
            if (!contactId) {
              crmDetail = 'HTTP ' + res.status + ': ' +
                (cbody?.message || JSON.stringify(cbody)).toString().slice(0, 300);
              console.error('[claim] HighLevel contact create failed', {
                status: res.status,
                location: v0.location_id,
                body: JSON.stringify(cbody).slice(0, 500),
              });
            }

            if (contactId) {
              await admin.from('prize_visits')
                .update({ ghl_contact_id: contactId, booked_at: new Date().toISOString() })
                .eq('visit_token', token);

              // The prize and code belong on the contact record, or the tech
              // who turns up has no idea what was promised.
              await fetch('https://services.leadconnectorhq.com/contacts/' + contactId + '/notes', {
                method: 'POST',
                headers: {
                  Authorization: 'Bearer ' + tok,
                  Version: '2021-07-28',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  body: 'Ripple neighbour offer\nPrize: ' + (v.promo_code || '') +
                        '\nPreferred: ' + bookingDate + ' ' + window_ +
                        '\nAddress in mailed batch: ' + (v.in_batch ? 'yes' : 'no') +
                        '\nSMS consent: ' + (consent ? 'yes' : 'no'),
                }),
              }).catch(() => {});
            }
          }
        }
      } catch (crmErr) {
        // The lead is safe in prize_visits and can be re-pushed; but say so in
        // the logs rather than failing invisibly.
        crmDetail = (crmErr as Error).message;
        console.error('[claim] CRM sync threw', crmDetail);
      }

      // PERSIST THE OUTCOME (migration 0034).
      // Previously the reason lived only in the HTTP response and the function
      // logs, so a failed sync left a lead in the table with a null contact id
      // and no explanation. Storing it makes the failure queryable, which is
      // what turns "best effort" into something an owner can actually act on.
      await admin.from('prize_visits').update({
        crm_attempted_at: new Date().toISOString(),
        crm_error: contactId ? null : (crmDetail || 'not attempted'),
      }).eq('visit_token', token).then(() => {}, () => {});

      await admin.from('events').insert({
        location_id: v0.location_id,
        type: 'booked',
        prize_code: v.promo_code,
      }).then(() => {}, () => {});

      return json({
        ok: true,
        promoCode: v.promo_code,
        prizeLabel: null,
        bookingWindow: window_,
        bookingDate: bookingDate,
        inBatch: v.in_batch,
        syncedToCrm: !!contactId,
        // Says the contact already existed and was updated rather than created.
        matchedExisting: duplicateOf || undefined,
        // Present only when the CRM write failed, so a test run shows the
        // reason without digging through logs.
        crmError: contactId ? undefined : (crmDetail || 'not attempted'),
      });
    }

    return json({ error: 'unknown route' }, 404);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
