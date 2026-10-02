// RS1: what an inspector checks a bus against.
//
// An inspector steps aboard with a phone and no signal. They need to know two
// things: is this person's ride on the record, and does the number of people
// on the record match the number of people on the bus. The meter answers both
// with one QR on its screen, signed with the vehicle key:
//
//   RS1 | vehicle | trip | unix s | cash tickets | door count | key.key.key… | sig
//
// `key` is the first KEY_PREFIX characters of each open ride's passenger key —
// 60 bits, plenty to tell forty people apart, and short enough that a full bus
// fits one QR. The inspector then scans each passenger's live ride code (the
// same BT1 the door reads): the signature proves the phone holds that key, and
// the prefix says whether the bus has a ride open for it.
//
// The roster is only as fresh as its timestamp, so it expires in minutes; the
// inspector scans it again at the next stop. The vehicle's public key comes
// from the backend's register (vehicle_public_keys(), migration 0031), fetched
// while the inspector's phone had signal, never from the bus being inspected.

import nacl from 'npm:tweetnacl@1.0.3';
import { toBase64url, fromBase64url, utf8Bytes } from './base64url.mjs';
import { assertCode, assertWholeNumber, FIELD_SEPARATOR as SEP } from './token.mjs';
import { verifyTap, TAP_MAX_AGE_S } from './leg.mjs';

export const ROSTER_VERSION = 'RS1';
export const KEY_PREFIX = 10;
export const ROSTER_MAX_AGE_S = 180;
const ROSTER_FIELDS = 8;

function rosterBody(roster) {
  return [
    ROSTER_VERSION,
    roster.vehicleId,
    roster.tripId,
    String(roster.issuedAt),
    String(roster.cash),
    roster.counted === null || roster.counted === undefined ? '-' : String(roster.counted),
    roster.prefixes.join('.'),
  ].join(SEP);
}

export function buildRoster({ vehicleId, tripId, aboard = [], cash = 0, counted = null, issuedAt = Math.floor(Date.now() / 1000) }) {
  assertCode(vehicleId, 'vehicleId');
  assertCode(tripId, 'tripId', 32);
  assertWholeNumber(cash, 'cash');
  if (counted !== null) assertWholeNumber(counted, 'counted');
  assertWholeNumber(issuedAt, 'issuedAt');
  const prefixes = [...new Set(aboard.map((key) => String(key).slice(0, KEY_PREFIX)))].sort();
  return { vehicleId, tripId, issuedAt, cash, counted, prefixes };
}

export function signRoster(roster, vehicleSecretKeyBase64url) {
  const body = rosterBody(roster);
  const signature = nacl.sign.detached(utf8Bytes(body), fromBase64url(vehicleSecretKeyBase64url));
  return `${body}${SEP}${toBase64url(signature)}`;
}

export function decodeRoster(text) {
  const parts = String(text ?? '').trim().split(SEP);
  if (parts[0] !== ROSTER_VERSION) throw new Error('not a Bhada inspection roster');
  if (parts.length !== ROSTER_FIELDS) throw new Error('roster is damaged or incomplete');
  const [, vehicleId, tripId, issuedAt, cash, counted, prefixes, signature] = parts;
  const roster = {
    vehicleId,
    tripId,
    issuedAt: Number(issuedAt),
    cash: Number(cash),
    counted: counted === '-' ? null : Number(counted),
    prefixes: prefixes ? prefixes.split('.') : [],
  };
  if (!Number.isInteger(roster.issuedAt) || !Number.isInteger(roster.cash)) throw new Error('roster has a bad number');
  return { roster, signature, body: rosterBody(roster) };
}

export function verifyRoster(text, { vehiclePublicKey, now = Math.floor(Date.now() / 1000), maxAgeS = ROSTER_MAX_AGE_S } = {}) {
  let decoded;
  try {
    decoded = decodeRoster(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { roster, signature, body } = decoded;
  if (!vehiclePublicKey) return { ok: false, reason: 'unknown_vehicle', message: `No key on file for ${roster.vehicleId}. Sync the register while there is signal.`, roster };
  let valid = false;
  try {
    valid = nacl.sign.detached.verify(utf8Bytes(body), fromBase64url(signature), fromBase64url(vehiclePublicKey));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature', message: 'This roster was not signed by that bus.', roster };
  if (Math.abs(now - roster.issuedAt) > maxAgeS) {
    return { ok: false, reason: 'stale', message: 'This roster is old. Ask for a fresh one.', roster };
  }
  return { ok: true, roster };
}

/*
  One passenger, checked against a verified roster.

  `recorded` — their phone signed a fresh code for this bus and the bus has a
  ride open for that key. `not_recorded` — a genuine code, but no ride on the
  bus's record: they boarded without tapping. Anything else is the tap's own
  refusal (a screenshot of an old code, a code for another bus).
*/
export function checkRider(roster, tapText, { now = Math.floor(Date.now() / 1000), seenNonces } = {}) {
  const verdict = verifyTap(tapText, { vehicleId: roster.vehicleId, now, seenNonces, maxAgeSeconds: TAP_MAX_AGE_S });
  if (!verdict.ok) return verdict;
  const prefix = verdict.tap.passengerPublicKey.slice(0, KEY_PREFIX);
  if (!roster.prefixes.includes(prefix)) {
    return { ok: false, reason: 'not_recorded', message: 'No ride on this bus for that passenger.', tap: verdict.tap };
  }
  return { ok: true, status: 'recorded', tap: verdict.tap };
}

/*
  The bus as a whole: the people the inspector counted against the record.
  Cash riders have no key to scan, so they count by their tickets.
*/
export function tallyInspection(roster, headcount) {
  const recorded = roster.prefixes.length + roster.cash;
  return {
    recorded,
    rides: roster.prefixes.length,
    cash: roster.cash,
    counted: roster.counted,
    headcount,
    unrecorded: Math.max(0, headcount - recorded),
  };
}
