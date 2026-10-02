// CR1 — the conductor signing on, and what a clean trip is worth.
//
// A metered fare system takes something away from a crew. Under cash an
// uncounted passenger is the conductor's own money; once every boarding runs
// through a door terminal there is nothing left to skim. A system that only
// takes is a system the crew will defeat, and the cheapest way to defeat this
// one is to reach under the seat and pull the meter's power.
//
// So the honest trip pays. Rs 50, flat, to the crew member who was signed on —
// not a share of the takings, because a conductor can hold a flat number in
// their head and argue about it, and an argument about the number is exactly
// the conversation that makes a bonus scheme real.
//
// There is no employee record here and this file does not invent one. A crew
// member holds an ordinary Bhada wallet — the same one they ride on — and signs
// on at the console with a token their own phone signs: their key, the vehicle,
// the minute. It is the mirror of the passenger's BT1 tap. A tap is consent to
// be charged; a sign-on is consent to be credited and named on the trip.

import nacl from 'npm:tweetnacl@1.0.3';
import { toBase64url, fromBase64url, utf8Bytes } from './base64url.mjs';
import { assertCode, assertWholeNumber, FIELD_SEPARATOR as SEP } from './token.mjs';
import { CLEAN_TRIP_BONUS_NPR, CLEAN_TRIP_MIN_LEGS, RECORDED_SHARE_MIN_PCT } from './policy.mjs';

export const CREW_VERSION = 'CR1';
const CREW_FIELDS = 5;

/*
  How stale a sign-on may be when the console reads it.

  Short, and for the same reason the passenger's tap window is short: the token
  is shown face to face, so the only thing a long window buys is the chance to
  reuse a screenshot of somebody else's sign-on. Five minutes covers a crew
  member fumbling for their phone at the depot.
*/
export const SIGNON_MAX_AGE_S = 300;

/*
  How long one sign-on covers.

  A conductor works a shift, not a trip: the same person runs Ratnapark to
  Koteshwor and back eight times before going home, and asking them to re-scan
  at every terminus is how a feature gets switched off in week one. So the
  console keeps them signed on across trips, and the backend accepts the one
  token against every trip the shift covers.

  The tight window above still applies where it matters — at the console, the
  one moment a screenshot of somebody else's sign-on could be held up to the
  camera. By the time a batch arrives, what the backend needs from CR1 is that
  the key consented, and the shift window is long enough for a fourteen-hour day
  and nothing like long enough to reuse last week's.
*/
export const SHIFT_MAX_AGE_S = 14 * 60 * 60;

function signOnBody(signOn) {
  return [
    CREW_VERSION,
    signOn.crewPublicKey,
    signOn.vehicleId,
    String(signOn.issuedAt),
  ].join(SEP);
}

export function buildSignOn({ crewPublicKey, vehicleId, issuedAt = Math.floor(Date.now() / 1000) }) {
  assertCode(crewPublicKey, 'crewPublicKey', 43);
  assertCode(vehicleId, 'vehicleId', 24);
  assertWholeNumber(issuedAt, 'issuedAt');
  return { crewPublicKey, vehicleId, issuedAt };
}

export function signSignOn(signOn, crewSecretKeyBase64url) {
  const body = signOnBody(signOn);
  const signature = nacl.sign.detached(utf8Bytes(body), fromBase64url(crewSecretKeyBase64url));
  return `${body}${SEP}${toBase64url(signature)}`;
}

export function decodeSignOn(text) {
  const parts = String(text ?? '').trim().split(SEP);
  if (parts[0] !== CREW_VERSION) throw new Error('not a Bhada crew sign-on');
  if (parts.length !== CREW_FIELDS) throw new Error('crew sign-on is damaged or incomplete');
  const [, crewPublicKey, vehicleId, issuedAt, signature] = parts;
  const signOn = { crewPublicKey, vehicleId, issuedAt: Number(issuedAt) };
  if (!Number.isInteger(signOn.issuedAt)) throw new Error('crew sign-on has a non-numeric issuedAt');
  return { signOn, signature, body: signOnBody(signOn) };
}

/*
  Is this sign-on this crew member's, for this bus, now?

  `vehicleId` is checked when it is given, which is always at a console and
  never at the backend: by the time a batch arrives the console has already
  bound the sign-on to the trip, and re-deriving the vehicle from the trip only
  creates a second place for the two to disagree.
*/
export function verifySignOn(text, {
  vehicleId = null,
  maxAgeS = SIGNON_MAX_AGE_S,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  let decoded;
  try {
    decoded = decodeSignOn(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { signOn, signature, body } = decoded;

  let valid = false;
  try {
    valid = nacl.sign.detached.verify(
      utf8Bytes(body),
      fromBase64url(signature),
      fromBase64url(signOn.crewPublicKey),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'bad_signature', message: 'This sign-on was not signed by the key it names.', signOn };
  }
  if (vehicleId && signOn.vehicleId !== vehicleId) {
    return { ok: false, reason: 'wrong_vehicle', message: `This sign-on is for ${signOn.vehicleId}, not this bus.`, signOn };
  }
  if (now - signOn.issuedAt > maxAgeS) {
    return { ok: false, reason: 'expired', message: 'This sign-on is stale. Show a fresh one.', signOn };
  }
  if (signOn.issuedAt - now > SIGNON_MAX_AGE_S) {
    return { ok: false, reason: 'not_yet_valid', message: 'This sign-on is dated in the future.', signOn };
  }
  return { ok: true, signOn };
}

/*
  Was this trip clean?

  `evidence` is counted by whatever database the caller has, and judged here,
  because the rule is policy and policy lives in exactly one file. Every
  condition is something the crew controls:

    legs          how many rides settled on the trip. A bonus for a trip that
                  carried nobody is free money, so a floor.
    powerLost     the meter's feed was pulled while the bus was working.
    overrides     the capacity interlock was overridden — the one way past it.
    implausible   legs the plausibility score called `high`: a meter reporting
                  distances a bus cannot have covered.
    counted       bodies the door counter saw board, when the bus has one.
                  The record — settled legs plus cash tickets — must cover
                  RECORDED_SHARE_MIN_PCT of it.
    counterExpected  the bus has reported a count before. A counter that has
                  spoken once and then goes quiet is treated like a pulled plug:
                  unplugging it must not be how a trip dodges the count.

  Legs priced at the unclosed cap are deliberately absent. A tap-out is the
  passenger's to give and a crew cannot make a flat phone produce one; docking
  the crew for it would teach them to refuse boarding to anyone whose battery
  looks low.

  Returns the reasons as well as the verdict, because a crew that loses a bonus
  has to be able to see why without asking the owner.
*/
export function cleanTripVerdict(evidence = {}) {
  const legs = Number(evidence.legs ?? 0);
  const powerLost = Number(evidence.powerLost ?? 0);
  const overrides = Number(evidence.overrides ?? 0);
  const implausible = Number(evidence.implausible ?? 0);
  const cash = Number(evidence.cash ?? 0);
  const counted = evidence.counted === null || evidence.counted === undefined ? null : Number(evidence.counted);
  const recorded = legs + cash;
  const reasons = [];

  if (recorded < CLEAN_TRIP_MIN_LEGS) {
    reasons.push({
      code: 'too_few_legs',
      message: `${recorded} ride${recorded === 1 ? '' : 's'} on this trip; a bonus needs ${CLEAN_TRIP_MIN_LEGS}.`,
      value: recorded,
      limit: CLEAN_TRIP_MIN_LEGS,
    });
  }
  if (powerLost > 0) {
    reasons.push({
      code: 'power_lost',
      message: `The meter lost power ${powerLost} time${powerLost === 1 ? '' : 's'} while the bus was moving.`,
      value: powerLost,
    });
  }
  if (overrides > 0) {
    reasons.push({
      code: 'door_override',
      message: `The capacity interlock was overridden ${overrides} time${overrides === 1 ? '' : 's'}.`,
      value: overrides,
    });
  }
  if (implausible > 0) {
    reasons.push({
      code: 'implausible_legs',
      message: `${implausible} ride${implausible === 1 ? '' : 's'} on this trip could not have happened as metered.`,
      value: implausible,
    });
  }

  if (counted === null && evidence.counterExpected) {
    reasons.push({
      code: 'counter_silent',
      message: 'The door counter reported nothing for this trip.',
    });
  }
  if (counted !== null && counted > 0 && recorded * 100 < counted * RECORDED_SHARE_MIN_PCT) {
    const missing = counted - recorded;
    reasons.push({
      code: 'riders_not_recorded',
      message: `${missing} of ${counted} people counted through the door have no ride or cash ticket; a bonus needs ${RECORDED_SHARE_MIN_PCT}% recorded.`,
      value: Math.floor((recorded * 100) / counted),
      limit: RECORDED_SHARE_MIN_PCT,
    });
  }

  return {
    clean: reasons.length === 0,
    amount: reasons.length === 0 ? CLEAN_TRIP_BONUS_NPR : 0,
    reasons,
  };
}

/*
  When a charger going away is the 12 V feed being pulled.

  The meter runs off the bus's supply. A crew that wants it to stop counting
  does not have to break anything — they reach under the seat and unplug it, and
  the phone keeps showing a console while its battery drains and its receiver
  throttles. So the unplugging itself is the event.

  Two conditions, because a bus parked with the ignition off loses the same
  socket and that is not tampering. The feed has to stay gone for the grace
  period, and the bus has to have been moving recently enough that it was
  working when the plug came out. A depot at midnight trips neither.
*/
export const POWER_GRACE_S = 120;
export const POWER_MOVING_WINDOW_S = 600;

/*
  One step of the plug watcher, as arithmetic.

  Here rather than in the device because it is a rule, and a rule the proofs
  have to be able to run without a phone, a charger or a bus. The device owns
  the battery subscription and the clock; this owns what the numbers mean.

  `state` is what the device remembers between calls:

    charging     what the Battery Status API last said: true, false, or null
                 when the platform will not say
    lostAt       when charging last went false, or null
    pulled       whether this absence has already been called a tamper
    lastMovedAt  when the odometer last read above a crawl, or null

  Returns the same three, plus `event`: `power_lost` the one tick the grace
  period runs out, `power_restored` the one tick the charger comes back after a
  pull, and null every other tick. Nothing here refuses anything — the event is
  a mark on the tape, and its only consequence is the trip it lands on earning
  its crew no bonus.
*/
export function assessPower(state = {}, { now = Math.floor(Date.now() / 1000) } = {}) {
  const { charging = null, lastMovedAt = null } = state;
  let { lostAt = null, pulled = false } = state;

  if (charging === null) return { lostAt, pulled, event: null };

  const movedRecently = lastMovedAt !== null && now - lastMovedAt <= POWER_MOVING_WINDOW_S;

  if (charging === false) {
    if (lostAt === null) lostAt = now;
    if (!pulled && movedRecently && now - lostAt >= POWER_GRACE_S) {
      return { lostAt, pulled: true, event: 'power_lost', moving: true };
    }
    return { lostAt, pulled, event: null };
  }

  const event = pulled ? 'power_restored' : null;
  return { lostAt: null, pulled: false, event, moving: movedRecently };
}
