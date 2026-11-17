/**
 * Thanks.io API client — Deno / Edge Function compatible.
 *
 * Base: https://api.thanks.io/api/v2
 * Auth: single agency bearer token (clients do NOT have their own accounts).
 *       Client separation is via the `sub_account` field on sends.
 *
 * Verified against the live OpenAPI spec. The three calls Ripple needs:
 *   radiusSearch()  -> POST /mailing-lists-utils/buy-radius-search
 *   getRecipients() -> GET  /mailing-lists-utils/recipients/{id}
 *   sendPostcard()  -> POST /send/postcard
 */

const THANKSIO_BASE = 'https://api.thanks.io/api/v2';

export class ThanksIoError extends Error {
  status?: number;
  body?: unknown;
  retryable: boolean;
  constructor(message: string, opts: { status?: number; body?: unknown; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ThanksIoError';
    this.status = opts.status;
    this.body = opts.body;
    this.retryable = opts.retryable ?? false;
  }
}

function classify(status: number): boolean {
  // 429 and 5xx are worth retrying; 4xx (bad request, auth) are not.
  return status === 429 || status >= 500;
}

async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);

  let res: Response;
  try {
    res = await fetch(`${THANKSIO_BASE}${path}`, {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new ThanksIoError(`network failure calling ${path}: ${(err as Error).message}`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    throw new ThanksIoError(
      `thanks.io ${method} ${path} failed (${res.status}): ${parsed.message ?? text.slice(0, 200)}`,
      { status: res.status, body: parsed, retryable: classify(res.status) },
    );
  }

  return parsed;
}

export interface RadiusSearchParams {
  address: string;
  postalCode: string;
  recordCount: number;
  recordTypes?: string;        // default 'all'
  includeCondos?: boolean;     // default false — apartments excluded
  includeSearchAddress?: boolean; // default false — don't mail the customer we served
  subAccount?: number;
}

export interface RadiusSearchResult {
  mailingListId: number;
  message: string;
  failure: boolean;
}

/**
 * Run a nearest-neighbour radius search. Creates a mailing list of the N
 * closest addresses to the center. Costs ~$0.05/record.
 */
export async function radiusSearch(
  token: string,
  p: RadiusSearchParams,
): Promise<RadiusSearchResult> {
  const body: Record<string, unknown> = {
    address: p.address,
    postal_code: p.postalCode,
    record_count: p.recordCount,
    record_types: p.recordTypes ?? 'all',
    include_condos: p.includeCondos ?? false,
    include_search_address: p.includeSearchAddress ?? false,
    append_data: false, // never — that's the +$0.20/record phone/email add-on
  };
  // The radius-search endpoint does NOT accept sub_account. Its undocumented
  // sub_account parameter was ignored and created lists in the agency account.
  // Create a correctly scoped mailing list first, and require verification.
  let expectedSubAccount: number | undefined;
  if (p.subAccount != null) {
    expectedSubAccount = Number(p.subAccount);
    if (!Number.isSafeInteger(expectedSubAccount) || expectedSubAccount <= 0) {
      throw new ThanksIoError('Invalid thanks.io sub-account id; radius search blocked');
    }
    const created = await call(token, 'POST', '/mailing-lists/', {
      description: 'Ripple radius search - ' + p.address + ' - ' + p.postalCode,
      sub_account_id: expectedSubAccount,
    });
    const newListId = Number(created?.id ?? created?.data?.id);
    if (!Number.isSafeInteger(newListId) || newListId <= 0) {
      throw new ThanksIoError('Mailing list created but no valid ID returned; radius purchase blocked');
    }
    const details = await call(token, 'GET', '/mailing-lists/' + newListId);
    const owner = details?.data ?? details;
    if (Number(owner?.sub_account_id) !== expectedSubAccount) {
      throw new ThanksIoError('Mailing list ownership mismatch; radius purchase blocked (expected sub-account ' +
        expectedSubAccount + ')');
    }
    body.mailing_list_id = newListId;
  }

  const r = await call(token, 'POST', '/mailing-lists-utils/buy-radius-search', body);
  const resultListId = Number(r.mailing_list_id ?? r.mailingListId);
  if (expectedSubAccount != null && Number.isSafeInteger(resultListId)) {
    const details = await call(token, 'GET', '/mailing-lists/' + resultListId);
    const owner = details?.data ?? details;
    if (Number(owner?.sub_account_id) !== expectedSubAccount) {
      throw new ThanksIoError('Purchased radius list is not owned by intended sub-account ' +
        expectedSubAccount + '; STOP further processing');
    }
  }
  return {
    mailingListId: resultListId,
    message: r.message ?? '',
    failure: r.failure ?? false,
  };
}

export interface Recipient {
  id?: string | number;
  name?: string;
  address: string;
  address2?: string;
  city?: string;
  province?: string;      // state
  postal_code?: string;
  [k: string]: unknown;
}

/**
 * Pull the recipients a radius search produced. Paginates defensively.
 */
export async function getRecipients(
  token: string,
  mailingListId: number,
): Promise<Recipient[]> {
  const out: Recipient[] = [];
  let page = 1;
  // The endpoint returns a page of recipients; loop until a short page.
  // Guard with a hard cap so a bad response can't loop forever.
  for (let i = 0; i < 100; i++) {
    const r = await call(
      token,
      'GET',
      `/mailing-lists-utils/recipients/${mailingListId}?page=${page}`,
    );
    const batch: Recipient[] = r.data ?? r.recipients ?? r ?? [];
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return out;
}

/**
 * thanks.io's radius search populates the mailing list ASYNCHRONOUSLY: it
 * returns a mailing_list_id immediately, but filling the list with found
 * addresses takes a few seconds. Fetching recipients right away returns an
 * empty list. This polls getRecipients until the list is populated or the
 * attempt cap is reached — the Edge Function equivalent of the n8n Wait/Retry
 * loop. Returns [] only if the list is genuinely empty after all tries.
 */
export async function getRecipientsWithRetry(
  token: string,
  mailingListId: number,
  opts: { tries?: number; delayMs?: number } = {},
): Promise<Recipient[]> {
  const tries = opts.tries ?? 5;
  const delayMs = opts.delayMs ?? 8000;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const recips = await getRecipients(token, mailingListId);
    if (recips.length > 0) return recips;
    if (attempt < tries) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return [];
}

export interface SendRecipient {
  name?: string;
  address: string;
  address2?: string;
  city?: string;
  province?: string;
  postal_code?: string;
  // Per-recipient dynamic QR variables (~CUSTOM1~ .. ~CUSTOM10~ in the URL)
  custom1?: string;
  custom2?: string;
  custom3?: string;
  custom4?: string;
}

export interface SendPostcardParams {
  recipients: SendRecipient[];
  message?: string;
  creativeId?: number;
  postageClass?: 'first_class' | 'standard';
  size?: '4x6' | '6x9' | '6x11';   // default 4x6
  frontImageUrl?: string;
  imageTemplateId?: number;
  handwritingStyleId?: number;
  handwritingRealism?: boolean;
  handwritingColor?: 'blue' | 'black' | 'green' | 'purple' | 'red';
  qrcodeUrl?: string;              // may embed ~CUSTOM1~ etc. for per-recipient QR
  subAccount?: number;
  sendStandardMail?: boolean;      // false = First Class (default)
  returnName?: string;
  returnAddress?: string;
  returnCity?: string;
  returnState?: string;
  returnPostalCode?: string;
  notificationEmails?: string;
  preview?: boolean;               // true = render proof, spend nothing
}

export interface SendResult {
  orderId?: string | number;
  preview?: boolean;
  previewUrl?: string;
  raw: any;
}

/**
 * Send postcards. Set `preview: true` to get a rendered proof back without
 * spending postage — use this throughout testing.
 *
 * Dynamic QR: put ~CUSTOM1~ (etc.) in qrcodeUrl and set custom1 per recipient,
 * so every card gets a unique signed URL while still being one API call.
 */
export async function sendPostcard(
  token: string,
  p: SendPostcardParams,
): Promise<SendResult> {
  if (!p.recipients?.length) throw new ThanksIoError('no recipients to send to');
  if (!p.message && p.creativeId == null) throw new ThanksIoError('message is required without creative');

  const body: Record<string, unknown> = {
    recipients: p.recipients,
    size: p.size ?? '4x6',
  };
  if (p.creativeId != null) {
    // Thanks.io 2026 API: creative_id must NOT be combined with message,
    // handwriting, background, or image-template fields.
    body.creative_id = p.creativeId;
  } else {
    body.message = p.message;
    body.handwriting_realism = p.handwritingRealism ?? true;
    if (p.frontImageUrl) body.front_image_url = p.frontImageUrl;
    if (p.imageTemplateId != null) body.image_template_id = p.imageTemplateId;
    if (p.handwritingStyleId != null) body.handwriting_style_id = p.handwritingStyleId;
    if (p.handwritingColor) body.handwriting_color = p.handwritingColor;
  }
  if(p.postageClass) body.postage_class = p.postageClass;
  if (p.qrcodeUrl) body.qrcode_url = p.qrcodeUrl;
  if (p.subAccount != null) body.sub_account = p.subAccount;
  if (p.sendStandardMail != null) body.send_standard_mail = p.sendStandardMail;
  if (p.returnName) body.return_name = p.returnName;
  if (p.returnAddress) body.return_address = p.returnAddress;
  if (p.returnCity) body.return_city = p.returnCity;
  if (p.returnState) body.return_state = p.returnState;
  if (p.returnPostalCode) body.return_postal_code = p.returnPostalCode;
  if (p.notificationEmails) body.notification_emails = p.notificationEmails;
  if (p.preview) body.preview = true;

  const r = await call(token, 'POST', '/send/postcard', body);
  return {
    orderId: r.order_id ?? r.id ?? r.orderId,
    preview: !!p.preview,
    previewUrl: r.preview_url ?? r.previewUrl,
    raw: r,
  };
}

/** List handwriting styles (for picking handwriting_style_id during setup). */
export async function listHandwritingStyles(token: string): Promise<any[]> {
  const r = await call(token, 'GET', '/handwriting-styles');
  return r.data ?? r ?? [];
}

