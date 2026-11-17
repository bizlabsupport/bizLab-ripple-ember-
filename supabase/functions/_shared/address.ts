/**
 * Canonical address normalisation — Deno/TS port of src/lib/address.js.
 *
 * MUST produce byte-identical hashes to address.js and the n8n backfill's
 * inline copy. All three are verified to match. If you change one, change all
 * three and re-run the cross-check, or suppression silently breaks.
 */

const HASH_LENGTH = 12;

const DIRECTIONALS: Record<string, string> = {
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  n: 'n', s: 's', e: 'e', w: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw',
};

const STREET: Record<string, string> = {
  street: 'st', st: 'st', avenue: 'ave', ave: 'ave', av: 'ave',
  road: 'rd', rd: 'rd', drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct', circle: 'cir', cir: 'cir',
  boulevard: 'blvd', blvd: 'blvd', boul: 'blvd', place: 'pl', pl: 'pl',
  terrace: 'ter', ter: 'ter', terr: 'ter', parkway: 'pkwy', pkwy: 'pkwy', pky: 'pkwy',
  highway: 'hwy', hwy: 'hwy', trail: 'trl', trl: 'trl', way: 'way',
  square: 'sq', sq: 'sq', loop: 'loop', crescent: 'cres', cres: 'cres',
  close: 'cl', gardens: 'gdns', gdns: 'gdns', heights: 'hts', hts: 'hts',
  junction: 'jct', jct: 'jct', manor: 'mnr', mnr: 'mnr', point: 'pt', pt: 'pt',
  ridge: 'rdg', rdg: 'rdg', station: 'sta', sta: 'sta', extension: 'ext', ext: 'ext',
};

const UNIT = new Set([
  'apt', 'apartment', 'unit', 'ste', 'suite', 'rm', 'room', 'fl', 'floor',
  'bldg', 'building', 'dept', 'department', 'lot', 'trlr', 'trailer', 'spc',
  'space', 'key', 'slip', 'hangar', 'pier', 'basement', 'bsmt', 'front',
  'frnt', 'lower', 'lowr', 'upper', 'uppr', 'rear', 'side', 'penthouse', 'ph',
]);

const ORD: Record<string, string> = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
  sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th',
  eleventh: '11th', twelfth: '12th',
};

function stripDia(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normaliseAddress(address: string | null | undefined): string {
  if (address == null) return '';
  let s = stripDia(String(address)).toLowerCase();
  s = s.replace(/[,]/g, ' ').replace(/#\s*/g, ' apt ')
       .replace(/[.'\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ');
  let toks = s.split(' ').filter(Boolean);
  if (!toks.length) return '';
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (UNIT.has(toks[i])) {
      const nx = toks[i + 1];
      if (nx !== undefined && /^[a-z0-9]{1,6}$/.test(nx)) i++;
      continue;
    }
    out.push(toks[i]);
  }
  if (out.length) toks = out;
  toks = toks.map((t) => ORD[t] ?? t).map((t) => DIRECTIONALS[t] ?? STREET[t] ?? t);
  return toks.join(' ');
}

export function normalisePostalCode(pc: string | null | undefined): string {
  if (pc == null) return '';
  const s = stripDia(String(pc)).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (/^\d{9}$/.test(s)) return s.slice(0, 5);
  return s;
}

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 12-char address hash, or null if the address is unusable. Async because
 * Web Crypto's digest is async in Deno.
 */
export async function addressHash(
  address: string | null | undefined,
  postalCode: string | null | undefined,
): Promise<string | null> {
  const a = normaliseAddress(address);
  if (a === '') return null;
  const p = normalisePostalCode(postalCode);
  const full = await sha1Hex(`${a}|${p}`);
  return full.slice(0, HASH_LENGTH);
}

