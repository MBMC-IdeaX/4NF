// A different key every day, so a bus company cannot follow anyone home.
//
// The problem, stated plainly. Every BT1 tap and every BM1 receipt carries the
// passenger's public key in clear text, and both end up in tables an operator
// can read. One key per phone, forever, means a fleet owner can run:
//
//   "key a8F…9z boards at Thapathali at 08:32 every weekday and gets off at
//    Koteshwor at 09:05"
//
// That is a movement record for a named route on a named person's daily
// commute, assembled by a private company from data they were given for the
// purpose of collecting Rs 15. Nobody consented to it, nobody asked for it, and
// in a country where who attended which gathering is a live question it is not
// a hypothetical harm.
//
// The fix is that the key the operator sees is not an identity. The phone keeps
// one master seed it never transmits and derives a fresh keypair per calendar
// day. Every day's rides are signed by that day's key; tomorrow's key cannot be
// linked to today's by anyone holding only the public halves.
//
//   K(day) = ed25519 seed from SHA-512(masterSeed || "bhada/pseudonym/1" || day)
//
// What this does and does not buy, because a privacy claim that oversells
// itself is worse than none:
//
//   - The operator, the conductor and the vehicle see unlinkable daily keys.
//     That is the surveillance in the review, and it closes.
//   - The BACKEND can still link them. It has to: one wallet holds the money
//     and something must know which wallet a day-key spends from. That link is
//     a PK1 certificate the phone sends only to the backend, stored in a table
//     no operator can read.
//   - So this protects passengers from the fleet, not from the system operator
//     or from anyone who compels them. Real, bounded, and worth stating that way
//     rather than calling it anonymity.
//   - A route with three passengers a day is re-identifiable from the timings
//     whatever key is on the row. Rotation is not a defence against a thin
//     crowd, and nothing here pretends otherwise.

import nacl from 'tweetnacl';
import { toBase64url, fromBase64url, utf8Bytes } from './base64url.mjs';
import { assertCode, assertWholeNumber, FIELD_SEPARATOR as SEP } from './token.mjs';

export const LINK_VERSION = 'PK1';
const LINK_FIELDS = 6;

// Domain separation. A hash of a seed used for two purposes is a way to make
// one purpose leak the other; the label makes these keys good for this and
// nothing else, even if the same seed is ever used elsewhere.
const DOMAIN = 'bhada/pseudonym/1';

// Days since the epoch, in Kathmandu. A pseudonym has to turn over on the same
// boundary the passenger experiences as "a day", not on a UTC one that splits
// their evening commute in half — Nepal is UTC+05:45, so a UTC day rolls over
// at a quarter past six in the morning, mid rush hour.
const KATHMANDU_OFFSET_S = 5 * 3600 + 45 * 60;

export function dayIndex(nowS = Math.floor(Date.now() / 1000)) {
  return Math.floor((nowS + KATHMANDU_OFFSET_S) / 86400);
}

/*
  The day's keypair.

  Deterministic: the same seed and day always give the same keys, so a phone
  that is reinstalled from a backed-up seed can still prove it owns yesterday's
  rides, and a phone that reboots mid-shift does not orphan an open leg.
*/
export function deriveDailyKeypair(masterSeedBase64url, day = dayIndex()) {
  const seed = fromBase64url(masterSeedBase64url);
  if (seed.length < 32) throw new Error('a master seed is at least 32 bytes');
  const material = new Uint8Array([...seed, ...utf8Bytes(`${DOMAIN}/${day}`)]);
  // SHA-512, halved: nacl.sign wants a 32-byte seed and gives the same keypair
  // for the same one every time.
  const pair = nacl.sign.keyPair.fromSeed(nacl.hash(material).slice(0, 32));
  return {
    day,
    publicKey: toBase64url(pair.publicKey),
    secretKey: toBase64url(pair.secretKey),
  };
}

/*
  A companion's keypair, for the same day.

  A mother with two children, a man with his elderly father: one phone pays for
  the group. Each companion still rides under a key of their own — a ride is one
  key, one tap, one receipt, and nothing in the settlement path changes — but the
  key is derived from the payer's seed, and linked to the payer's wallet with an
  ordinary PK1 link, so every companion's fare is charged to the one wallet.

  `n` counts from 1. Domain-separated from the day-key, so no companion key is
  ever the payer's own.
*/
export const MAX_COMPANIONS = 4;

export function deriveCompanionKeypair(masterSeedBase64url, day = dayIndex(), n = 1) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_COMPANIONS) throw new Error(`a companion is numbered 1-${MAX_COMPANIONS}`);
  const seed = fromBase64url(masterSeedBase64url);
  if (seed.length < 32) throw new Error('a master seed is at least 32 bytes');
  const material = new Uint8Array([...seed, ...utf8Bytes(`${DOMAIN}/${day}/companion/${n}`)]);
  const pair = nacl.sign.keyPair.fromSeed(nacl.hash(material).slice(0, 32));
  return {
    day,
    companion: n,
    publicKey: toBase64url(pair.publicKey),
    secretKey: toBase64url(pair.secretKey),
  };
}

export function createMasterSeed() {
  return toBase64url(nacl.randomBytes(32));
}

// ------------------------------------------------------ PK1: the link

/*
  This day-key spends from this wallet.

  Signed twice, which is the whole point. The root signature says the account
  owner authorised this pseudonym; the day-key signature proves whoever sent it
  actually holds the pseudonym's secret rather than having copied its public
  half off a receipt. One without the other lets somebody bind a stranger's
  pseudonym to their own wallet, or their own pseudonym to a stranger's.
*/
function linkBody(link) {
  return [LINK_VERSION, link.rootPublicKey, link.pseudonymPublicKey, String(link.day)].join(SEP);
}

export function buildLink({ rootPublicKey, pseudonymPublicKey, day = dayIndex() }) {
  assertCode(rootPublicKey, 'rootPublicKey', 43);
  assertCode(pseudonymPublicKey, 'pseudonymPublicKey', 43);
  assertWholeNumber(day, 'day');
  return { rootPublicKey, pseudonymPublicKey, day };
}

export function signLink(link, rootSecretKey, pseudonymSecretKey) {
  const body = linkBody(link);
  const bytes = utf8Bytes(body);
  const byRoot = nacl.sign.detached(bytes, fromBase64url(rootSecretKey));
  const byPseudonym = nacl.sign.detached(bytes, fromBase64url(pseudonymSecretKey));
  return `${body}${SEP}${toBase64url(byRoot)}${SEP}${toBase64url(byPseudonym)}`;
}

export function decodeLink(text) {
  const parts = String(text ?? '').trim().split(SEP);
  if (parts[0] !== LINK_VERSION) throw new Error('not a Bhada key link');
  if (parts.length !== LINK_FIELDS) throw new Error('key link is damaged or incomplete');
  const [, rootPublicKey, pseudonymPublicKey, day, byRoot, byPseudonym] = parts;
  const link = { rootPublicKey, pseudonymPublicKey, day: Number(day) };
  if (!Number.isInteger(link.day)) throw new Error('key link has a non-numeric day');
  return { link, byRoot, byPseudonym, body: linkBody(link) };
}

export function verifyLink(text) {
  let decoded;
  try {
    decoded = decodeLink(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { link, byRoot, byPseudonym, body } = decoded;
  const bytes = utf8Bytes(body);

  const checks = (signature, key) => {
    try {
      return nacl.sign.detached.verify(bytes, fromBase64url(signature), fromBase64url(key));
    } catch {
      return false;
    }
  };
  if (!checks(byRoot, link.rootPublicKey)) {
    return { ok: false, reason: 'bad_root_signature', message: 'The account did not authorise this key.', link };
  }
  if (!checks(byPseudonym, link.pseudonymPublicKey)) {
    return { ok: false, reason: 'bad_pseudonym_signature', message: 'Whoever sent this does not hold that key.', link };
  }
  // A root that links itself is the ordinary un-rotated case and is allowed:
  // it is how a device that has not turned rotation on still settles.
  return { ok: true, link };
}
