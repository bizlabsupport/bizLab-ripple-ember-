/**
 * QR / landing-page URL signing.
 *
 * Each postcard carries a QR whose URL encodes the batch, the address hash,
 * and the pre-rolled prize index, signed with the client's hmac_secret. The
 * landing page verifies the signature so the prize can't be tampered with by
 * editing the URL.
 *
 * Dynamic QR approach: the send call uses one qrcode_url template containing
 * ~CUSTOM1~, and each recipient carries its signed payload in custom1. That
 * gives every card a unique URL in a single API call.
 */

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Truncated signature — enough to prevent tampering, short enough for a QR. */
export async function signPayload(
  secret: string,
  parts: { batch: string; addr: string; prize: number },
): Promise<string> {
  const msg = `${parts.batch}.${parts.addr}.${parts.prize}`;
  const full = await hmacSha256Hex(secret, msg);
  return full.slice(0, 16);
}

export async function verifyPayload(
  secret: string,
  parts: { batch: string; addr: string; prize: number },
  sig: string,
): Promise<boolean> {
  const expected = await signPayload(secret, parts);
  // constant-time-ish compare
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/**
 * Build the per-recipient custom1 value: the query string the landing page
 * reads. Kept compact for QR density.
 */
export async function buildQrPayload(
  secret: string,
  parts: { batch: string; addr: string; prize: number },
): Promise<string> {
  const sig = await signPayload(secret, parts);
  return `b=${parts.batch}&a=${parts.addr}&p=${parts.prize}&s=${sig}`;
}

