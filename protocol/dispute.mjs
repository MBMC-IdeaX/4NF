// BD1 — the claim a passenger makes when their phone died on the bus.
//
// A ride opens with the passenger's tap and closes when they show their pass at
// the exit door. A phone with a flat battery cannot show anything, so the ride
// stays open, the meter closes it at the end of the trip, and the passenger is
// charged the unclosed cap: the rule that stops tapping out being optional.
// That rule is right, and it is also going to bill a lot of honest people who
// did nothing worse than ride a bus with a two-year-old handset.
//
// This is their answer. The passenger's phone ran its own odometer beside the
// bus's the whole time it was alive, and wrote it down every few seconds. The
// claim is that record, signed by the same key that tapped in:
//
//   "I am the passenger on this leg. My own odometer read this far at this
//    moment, at this position, and then my phone stopped."
//
// What it proves and what it does not
// -----------------------------------
// The witness distance is a floor, never a measurement of the ride: the
// passenger rode at least that far and possibly much further, because nothing
// recorded the part after the battery went. So re-pricing at the witness
// distance is a decision to give the passenger the benefit of the doubt, not a
// calculation of what they owe. Three things keep that bounded:
//
//   - only an `unclosed` leg can be disputed at all. A leg closed at a door has
//     two signatures on it and there is nothing here to argue about.
//   - the re-price is an ordinary metered price, so the boarding charge still
//     applies. The most a claim can ever return is the cap minus the minimum
//     fare — Rs 10 at the current tariff, and half that for a concession.
//   - the claim is filed against the leg once, and the database enforces it.
//
// A passenger who kills their app early to get Rs 10 back is real and this does
// not stop them. What stops them is that it is Rs 10, that every claim is a row
// with their key on it, and that an operator can see the pattern.

import nacl from 'tweetnacl';
import { toBase64url, fromBase64url, utf8Bytes } from './base64url.mjs';
import { assertCode, assertWholeNumber, newNonce, FIELD_SEPARATOR as SEP } from './token.mjs';

export const DISPUTE_VERSION = 'BD1';
const DISPUTE_FIELDS = 11;

// A claim can be filed late — that is the point, the phone was dead — but not
// forever. Long enough to charge a phone, find a charger, and open the app.
export const DISPUTE_MAX_AGE_S = 14 * 24 * 60 * 60;

// The witness has to stop meaningfully before the ride does, or there was no
// dead phone to explain. A passenger whose phone recorded to within a minute of
// the trip closing had a working phone and chose not to tap out.
export const WITNESS_GAP_S = 120;

function disputeBody(claim) {
  return [
    DISPUTE_VERSION,
    claim.passengerPublicKey,
    claim.vehicleId,
    claim.legId,
    String(claim.witnessM),
    String(claim.witnessAt),
    String(claim.witnessLatMicro),
    String(claim.witnessLonMicro),
    claim.nonce,
    String(claim.timestamp),
  ].join(SEP);
}

export function buildDispute({
  passengerPublicKey,
  vehicleId,
  legId,
  witnessM,
  witnessAt,
  witnessLatMicro = 0,
  witnessLonMicro = 0,
  nonce = newNonce(),
  timestamp = Math.floor(Date.now() / 1000),
}) {
  assertCode(passengerPublicKey, 'passengerPublicKey', 43);
  assertCode(vehicleId, 'vehicleId');
  assertCode(legId, 'legId', 32);
  assertCode(nonce, 'nonce');
  assertWholeNumber(witnessM, 'witnessM');
  assertWholeNumber(witnessAt, 'witnessAt');
  assertWholeNumber(timestamp, 'timestamp');
  if (!Number.isInteger(witnessLatMicro)) throw new Error('witnessLatMicro must be a whole number');
  if (!Number.isInteger(witnessLonMicro)) throw new Error('witnessLonMicro must be a whole number');
  return {
    passengerPublicKey, vehicleId, legId,
    witnessM, witnessAt, witnessLatMicro, witnessLonMicro,
    nonce, timestamp,
  };
}

export function signDispute(claim, secretKeyBase64url) {
  const body = disputeBody(claim);
  const signature = nacl.sign.detached(utf8Bytes(body), fromBase64url(secretKeyBase64url));
  return `${body}${SEP}${toBase64url(signature)}`;
}

export function decodeDispute(text) {
  const parts = String(text ?? '').trim().split(SEP);
  if (parts[0] !== DISPUTE_VERSION) throw new Error('not a Bhada claim');
  if (parts.length !== DISPUTE_FIELDS) throw new Error('claim is damaged or incomplete');
  const [
    , passengerPublicKey, vehicleId, legId,
    witnessM, witnessAt, witnessLatMicro, witnessLonMicro, nonce, timestamp, signature,
  ] = parts;
  const claim = {
    passengerPublicKey,
    vehicleId,
    legId,
    witnessM: Number(witnessM),
    witnessAt: Number(witnessAt),
    witnessLatMicro: Number(witnessLatMicro),
    witnessLonMicro: Number(witnessLonMicro),
    nonce,
    timestamp: Number(timestamp),
  };
  for (const field of ['witnessM', 'witnessAt', 'witnessLatMicro', 'witnessLonMicro', 'timestamp']) {
    if (!Number.isInteger(claim[field])) throw new Error(`claim has a non-numeric ${field}`);
  }
  return { claim, signature, body: disputeBody(claim) };
}

// The signature, and nothing else. What the claim is worth against a particular
// leg is assessDispute()'s question, because only the backend holds the leg.
export function verifyDispute(text, { now = Math.floor(Date.now() / 1000), maxAgeSeconds = DISPUTE_MAX_AGE_S } = {}) {
  let decoded;
  try {
    decoded = decodeDispute(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { claim, signature, body } = decoded;

  let valid = false;
  try {
    valid = nacl.sign.detached.verify(
      utf8Bytes(body),
      fromBase64url(signature),
      fromBase64url(claim.passengerPublicKey),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'bad_signature', message: 'This claim was not signed by that phone.', claim };
  }
  if (now - claim.timestamp > maxAgeSeconds) {
    return { ok: false, reason: 'too_late', message: 'This ride is too old to claim against.', claim };
  }
  return { ok: true, claim };
}

/*
  What the claim is worth against the leg it names.

  `leg` is the settled row, as the backend holds it: legId, passengerPublicKey,
  vehicleId, distanceSource, distanceM, amount, concession, tariffCode, boardAt
  and alightAt, the last two in unix seconds. `priceFn` is priceDistance.

  Every refusal is a reason a person can be told, because a passenger whose
  claim fails is entitled to hear which rule it failed.
*/
export function assessDispute(claim, leg, { priceFn }) {
  if (!leg) {
    return { ok: false, reason: 'unknown_leg', message: 'No settled ride with that number.' };
  }
  if (claim.legId !== leg.legId
    || claim.passengerPublicKey !== leg.passengerPublicKey
    || claim.vehicleId !== leg.vehicleId) {
    return { ok: false, reason: 'not_your_leg', message: 'That claim is against somebody else\'s ride.' };
  }

  // A ride closed at a door carries the passenger's tap and the vehicle's
  // receipt. Both parties already agreed to it; a claim is not an appeal.
  if (leg.distanceSource !== 'unclosed') {
    return {
      ok: false,
      reason: 'not_disputable',
      message: 'This ride was closed at the door and measured. There is nothing to reopen.',
    };
  }

  if (claim.witnessAt < leg.boardAt || claim.witnessAt > leg.alightAt) {
    return { ok: false, reason: 'witness_outside_ride', message: 'That reading was not taken during this ride.' };
  }
  if (leg.alightAt - claim.witnessAt < WITNESS_GAP_S) {
    return {
      ok: false,
      reason: 'phone_was_alive',
      message: 'This phone was still recording when the ride ended. The exit tap was missed, not lost.',
    };
  }
  // The phone cannot have measured more of the ride than the bus did. If it
  // says it has, the bus under-read and no refund is owed on this route.
  if (claim.witnessM > leg.distanceM) {
    return { ok: false, reason: 'witness_exceeds_ride', message: 'Your phone measured more than the bus did.' };
  }

  // An ordinary metered price for the distance the phone can account for. Not
  // the unclosed rule: that is the charge being disputed. The tariff is the one
  // the leg was charged under, never today's.
  const repriced = priceFn(Math.max(0, claim.witnessM), {
    concession: leg.concession,
    tariffCode: leg.tariffCode,
  });
  if (!Number.isFinite(repriced.amount)) {
    return { ok: false, reason: 'unknown_tariff', message: `No published tariff ${leg.tariffCode}.` };
  }

  const refund = leg.amount - repriced.amount;
  if (refund <= 0) {
    return {
      ok: false,
      reason: 'no_refund',
      message: 'The distance your phone recorded prices no lower than you were charged.',
      repriced,
    };
  }
  return { ok: true, refund, amount: repriced.amount, repriced };
}
