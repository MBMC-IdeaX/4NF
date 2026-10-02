// AL1 — a phone saying "this login is mine".
//
// A passenger account is an email or phone login. A wallet is a key the phone
// holds. Joining the two is the one step where an account could claim money it
// does not own: anybody can type any wallet key into a form, because wallet
// keys are public — they were on every receipt before rotation. So the join is
// signed by the wallet itself:
//
//   "I, this wallet, belong to login U, as of time T."
//
// Only the phone holding the wallet's secret can produce that. The backend
// checks it, checks the login presenting it is U, and checks it is fresh, so a
// link seen once cannot be replayed into someone else's session later.
//
// What it is not: an identity check. It proves possession of a key, the same
// thing every other signature in Bhada proves, and nothing about the person.

import nacl from 'npm:tweetnacl@1.0.3';
import { toBase64url, fromBase64url, utf8Bytes } from './base64url.mjs';
import { assertCode, assertWholeNumber, FIELD_SEPARATOR as SEP } from './token.mjs';

export const ACCOUNT_LINK_VERSION = 'AL1';
export const ACCOUNT_LINK_MAX_AGE_S = 300;
const FIELDS = 5;

function body(link) {
  return [ACCOUNT_LINK_VERSION, link.userId, link.walletPublicKey, String(link.timestamp)].join(SEP);
}

export function buildAccountLink({ userId, walletPublicKey, timestamp = Math.floor(Date.now() / 1000) }) {
  assertCode(userId, 'userId', 36);
  assertCode(walletPublicKey, 'walletPublicKey', 43);
  assertWholeNumber(timestamp, 'timestamp');
  return { userId, walletPublicKey, timestamp };
}

export function signAccountLink(link, walletSecretKey) {
  const text = body(link);
  const signature = nacl.sign.detached(utf8Bytes(text), fromBase64url(walletSecretKey));
  return `${text}${SEP}${toBase64url(signature)}`;
}

export function decodeAccountLink(text) {
  const parts = String(text ?? '').trim().split(SEP);
  if (parts[0] !== ACCOUNT_LINK_VERSION) throw new Error('not a Bhada account link');
  if (parts.length !== FIELDS) throw new Error('account link is damaged or incomplete');
  const [, userId, walletPublicKey, timestamp, signature] = parts;
  const link = { userId, walletPublicKey, timestamp: Number(timestamp) };
  if (!Number.isInteger(link.timestamp)) throw new Error('account link has a non-numeric time');
  return { link, signature };
}

export function verifyAccountLink(text, { now = Math.floor(Date.now() / 1000), maxAgeSeconds = ACCOUNT_LINK_MAX_AGE_S } = {}) {
  let decoded;
  try {
    decoded = decodeAccountLink(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { link, signature } = decoded;
  let valid = false;
  try {
    valid = nacl.sign.detached.verify(utf8Bytes(body(link)), fromBase64url(signature), fromBase64url(link.walletPublicKey));
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'bad_signature', message: 'This link was not signed by the wallet it names.', link };
  }
  if (Math.abs(now - link.timestamp) > maxAgeSeconds) {
    return { ok: false, reason: 'stale', message: 'This link is too old. Link the wallet again from the phone.', link };
  }
  return { ok: true, link };
}
