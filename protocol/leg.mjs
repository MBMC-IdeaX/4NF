// Two signatures per ride, and neither device has to be online for either.
//
//   BT1 — the tap. Signed by the passenger, shown at a door terminal. It says
//         "I, this key, am boarding this vehicle at this door, now."
//   BM1 — the leg receipt. Signed by the vehicle, produced at tap-out. It says
//         "this key rode from this odometer reading to that one, and here is
//         the arithmetic."
//
// Why both. A vehicle-signed receipt alone lets an operator invent rides. A
// passenger-signed tap alone lets a passenger deny one. Holding the pair means
// a settled leg is agreed by the only two parties who were there, and the
// backend re-verifies both rather than trusting either.
//
// BH1 in token.mjs is untouched. Stage fares still work exactly as they did;
// this is the distance path beside it.

import nacl from 'tweetnacl';
import { toBase64url, fromBase64url, utf8Bytes } from './base64url.mjs';
import { assertCode, assertWholeNumber, newNonce, FIELD_SEPARATOR as SEP } from './token.mjs';

export const TAP_VERSION = 'BT1';
export const LEG_VERSION = 'BM1';
// BM2 is a BM1 that also names the boarding and exit stages, for a ride priced
// by a stage tariff. A ride with no stages is still written as BM1, so every
// receipt already issued keeps verifying.
export const LEG_VERSION_STAGED = 'BM2';
const LEG_FIELDS_STAGED = 19;

const TAP_FIELDS = 7;
const LEG_FIELDS = 17;

/*
  A tap is shown as a QR on a phone whose clock nobody has corrected.

  A cheap Android handset that has been out of cellular coverage — the exact
  handset this is built for — drifts tens of seconds a week, and a phone two
  weeks off the network can be three minutes from satellite time while its owner
  is standing at the door with a freshly generated code. Refusing that passenger
  is a bug in us, not a stale pass.

  So the window is the drift a real offline phone accumulates, not the time a
  screenshot stays interesting. What actually stops a screenshot is the nonce:
  `seenNonces` at the door, and a unique index on the tap nonce in the database.
  A tap is good once, whatever its clock said. This window is the second lock,
  and it is sized for the passenger rather than against them.
*/
export const TAP_MAX_AGE_S = 300;

// Coordinates travel as microdegrees. 1e-6° is about 11 cm — far finer than any
// consumer fix — and an integer cannot pick up a float's last-digit drift
// between the device that signs and the server that re-verifies.
export function toMicro(degrees) {
  return Math.round(Number(degrees) * 1e6);
}

export function fromMicro(micro) {
  return Number(micro) / 1e6;
}

function assertInteger(value, label) {
  if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number`);
}

// ---------------------------------------------------------------- BT1: tap

function tapBody(tap) {
  return [
    TAP_VERSION,
    tap.passengerPublicKey,
    tap.vehicleId,
    tap.doorId,
    tap.nonce,
    String(tap.timestamp),
  ].join(SEP);
}

export function buildTap({
  passengerPublicKey,
  vehicleId,
  doorId,
  nonce = newNonce(),
  timestamp = Math.floor(Date.now() / 1000),
}) {
  assertCode(passengerPublicKey, 'passengerPublicKey', 43);
  assertCode(vehicleId, 'vehicleId');
  assertCode(doorId, 'doorId', 8);
  assertCode(nonce, 'nonce');
  assertWholeNumber(timestamp, 'timestamp');
  return { passengerPublicKey, vehicleId, doorId, nonce, timestamp };
}

export function signTap(tap, secretKeyBase64url) {
  const body = tapBody(tap);
  const signature = nacl.sign.detached(utf8Bytes(body), fromBase64url(secretKeyBase64url));
  return `${body}${SEP}${toBase64url(signature)}`;
}

export function decodeTap(text) {
  const parts = String(text ?? '').trim().split(SEP);
  if (parts[0] !== TAP_VERSION) throw new Error('not a Bhada tap');
  if (parts.length !== TAP_FIELDS) throw new Error('tap is damaged or incomplete');
  const [, passengerPublicKey, vehicleId, doorId, nonce, timestamp, signature] = parts;
  const tap = { passengerPublicKey, vehicleId, doorId, nonce, timestamp: Number(timestamp) };
  if (!Number.isInteger(tap.timestamp)) throw new Error('tap has a non-numeric timestamp');
  return { tap, signature, body: tapBody(tap) };
}

/*
  What a door terminal decides, on its own, with no network and no help from the
  meter. Replay is scoped to the vehicle's own set of seen nonces, so the same
  passenger may tap in and out all day; they may not reuse one tap twice.
*/
export function verifyTap(text, { vehicleId, seenNonces, now = Math.floor(Date.now() / 1000), maxAgeSeconds = TAP_MAX_AGE_S } = {}) {
  let decoded;
  try {
    decoded = decodeTap(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { tap, signature, body } = decoded;

  let valid = false;
  try {
    valid = nacl.sign.detached.verify(
      utf8Bytes(body),
      fromBase64url(signature),
      fromBase64url(tap.passengerPublicKey),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature', message: 'This pass was not signed by that phone.', tap };

  if (vehicleId && tap.vehicleId !== vehicleId) {
    return { ok: false, reason: 'wrong_vehicle', message: `Pass is for vehicle ${tap.vehicleId}.`, tap };
  }
  if (seenNonces && seenNonces.has(tap.nonce)) {
    return { ok: false, reason: 'replay', message: 'This pass was already used. Refresh it.', tap };
  }
  // How far the passenger's clock is from this one, signed: negative when their
  // phone is behind. Returned on the way out so a terminal can tell the holder
  // their clock is wrong instead of just refusing them, and so a door that
  // accepted a badly drifted tap leaves a number in the log rather than a guess.
  const skewS = tap.timestamp - now;
  if (Math.abs(skewS) > maxAgeSeconds) {
    return {
      ok: false,
      reason: 'stale',
      message: `Pass expired, or this phone's clock is ${Math.round(Math.abs(skewS) / 60)} min out. Refresh the code.`,
      tap,
      skewS,
    };
  }
  return { ok: true, tap, skewS };
}

// ------------------------------------------------------------ BG1: a group

/*
  Several ride codes in one QR, for a family paying from one phone.

  Nothing new is signed: a BG1 is only a container for up to five ordinary BT1
  codes — the payer's and their companions' (deriveCompanionKeypair in
  pseudonym.mjs) — joined with '~', which no BT1 contains. A door takes it apart
  and treats each code exactly as if it had been shown on its own, so every rule
  a single tap obeys, each companion obeys too.
*/
export const GROUP_VERSION = 'BG1';
export const GROUP_MAX = 5;
const GROUP_SEP = '~';

export function buildGroup(codes) {
  const list = codes.filter(Boolean);
  if (list.length < 1 || list.length > GROUP_MAX) throw new Error(`a group carries 1-${GROUP_MAX} ride codes`);
  if (list.some((code) => !String(code).startsWith(`${TAP_VERSION}${SEP}`) || String(code).includes(GROUP_SEP))) {
    throw new Error('a group carries ride codes only');
  }
  return [GROUP_VERSION, ...list].join(GROUP_SEP);
}

export function splitGroup(text) {
  const parts = String(text ?? '').trim().split(GROUP_SEP);
  if (parts[0] !== GROUP_VERSION) return null;
  const codes = parts.slice(1).filter(Boolean);
  if (codes.length < 1 || codes.length > GROUP_MAX) return null;
  if (codes.some((code) => !code.startsWith(`${TAP_VERSION}${SEP}`))) return null;
  // The same person twice is one person: a group cannot double a key's ride.
  if (new Set(codes.map((code) => code.split(SEP)[1])).size !== codes.length) return null;
  return codes;
}

// ------------------------------------------------------------ BM1: leg receipt

function legBody(leg) {
  const staged = Boolean(leg.boardStage && leg.alightStage);
  return [
    staged ? LEG_VERSION_STAGED : LEG_VERSION,
    leg.vehicleId,
    leg.tripId,
    leg.legId,
    leg.passengerPublicKey,
    leg.boardDoorId,
    leg.alightDoorId,
    String(leg.boardOdoM),
    String(leg.alightOdoM),
    String(leg.distanceM),
    leg.distanceSource,
    String(leg.boardAt),
    String(leg.alightAt),
    leg.concession,
    String(leg.amount),
    leg.tariffCode,
    ...(staged ? [leg.boardStage, leg.alightStage] : []),
  ].join(SEP);
}

export function buildLeg({
  vehicleId,
  tripId,
  legId,
  passengerPublicKey,
  boardDoorId,
  alightDoorId,
  boardOdoM,
  alightOdoM,
  distanceM,
  distanceSource,
  boardAt,
  alightAt,
  concession,
  amount,
  tariffCode,
  boardStage = null,
  alightStage = null,
}) {
  assertCode(vehicleId, 'vehicleId');
  assertCode(tripId, 'tripId', 32);
  assertCode(legId, 'legId', 32);
  assertCode(passengerPublicKey, 'passengerPublicKey', 43);
  assertCode(boardDoorId, 'boardDoorId', 8);
  assertCode(alightDoorId, 'alightDoorId', 8);
  assertCode(distanceSource, 'distanceSource', 12);
  assertCode(concession, 'concession', 12);
  assertCode(tariffCode, 'tariffCode', 24);
  if (Boolean(boardStage) !== Boolean(alightStage)) throw new Error('a leg names both stages or neither');
  if (boardStage) {
    assertCode(boardStage, 'boardStage', 24);
    assertCode(alightStage, 'alightStage', 24);
  }
  assertWholeNumber(boardOdoM, 'boardOdoM');
  assertWholeNumber(alightOdoM, 'alightOdoM');
  assertWholeNumber(distanceM, 'distanceM');
  assertWholeNumber(boardAt, 'boardAt');
  assertWholeNumber(alightAt, 'alightAt');
  assertWholeNumber(amount, 'amount');
  if (alightAt < boardAt) throw new Error('a leg cannot end before it starts');
  return {
    vehicleId,
    tripId,
    legId,
    passengerPublicKey,
    boardDoorId,
    alightDoorId,
    boardOdoM,
    alightOdoM,
    distanceM,
    distanceSource,
    boardAt,
    alightAt,
    concession,
    amount,
    tariffCode,
    ...(boardStage ? { boardStage, alightStage } : {}),
  };
}

export function signLeg(leg, vehicleSecretKeyBase64url) {
  const body = legBody(leg);
  const signature = nacl.sign.detached(utf8Bytes(body), fromBase64url(vehicleSecretKeyBase64url));
  return `${body}${SEP}${toBase64url(signature)}`;
}

export function decodeLeg(text) {
  const parts = String(text ?? '').trim().split(SEP);
  const staged = parts[0] === LEG_VERSION_STAGED;
  if (parts[0] !== LEG_VERSION && !staged) throw new Error('not a Bhada leg receipt');
  if (parts.length !== (staged ? LEG_FIELDS_STAGED : LEG_FIELDS)) throw new Error('leg receipt is damaged or incomplete');
  const [
    ,
    vehicleId, tripId, legId, passengerPublicKey, boardDoorId, alightDoorId,
    boardOdoM, alightOdoM, distanceM, distanceSource, boardAt, alightAt,
    concession, amount, tariffCode,
  ] = parts;
  const signature = parts[parts.length - 1];
  const [boardStage, alightStage] = staged ? parts.slice(16, 18) : [];
  const leg = {
    vehicleId,
    tripId,
    legId,
    passengerPublicKey,
    boardDoorId,
    alightDoorId,
    boardOdoM: Number(boardOdoM),
    alightOdoM: Number(alightOdoM),
    distanceM: Number(distanceM),
    distanceSource,
    boardAt: Number(boardAt),
    alightAt: Number(alightAt),
    concession,
    amount: Number(amount),
    tariffCode,
    ...(staged ? { boardStage, alightStage } : {}),
  };
  for (const field of ['boardOdoM', 'alightOdoM', 'distanceM', 'boardAt', 'alightAt', 'amount']) {
    assertInteger(leg[field], field);
  }
  return { leg, signature, body: legBody(leg) };
}

/*
  Verify a leg receipt against the vehicle key the backend has on file, then
  re-price it from the recorded distance. A receipt whose arithmetic does not
  reproduce is a receipt the operator's own box got wrong, and the backend says
  so rather than settling it — which is the point of shipping the same pricing
  function to both ends.
*/
export function verifyLeg(text, { vehiclePublicKey, priceFn, seenLegIds } = {}) {
  let decoded;
  try {
    decoded = decodeLeg(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { leg, signature, body } = decoded;

  if (vehiclePublicKey) {
    let valid = false;
    try {
      valid = nacl.sign.detached.verify(
        utf8Bytes(body),
        fromBase64url(signature),
        fromBase64url(vehiclePublicKey),
      );
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: 'bad_signature', message: 'Receipt was not signed by that vehicle.', leg };
  }

  if (seenLegIds && seenLegIds.has(leg.legId)) {
    return { ok: false, reason: 'replay', message: 'This leg was already settled.', leg };
  }

  if (priceFn) {
    const repriced = priceFn(leg.distanceM, {
      concession: leg.concession,
      tariffCode: leg.tariffCode,
      unclosed: leg.distanceSource === 'unclosed',
      boardStage: leg.boardStage,
      alightStage: leg.alightStage,
    });
    if (repriced.amount !== leg.amount) {
      return {
        ok: false,
        reason: 'price_mismatch',
        message: `Receipt says ${leg.amount}, tariff says ${repriced.amount}.`,
        leg,
        repriced,
      };
    }
  }

  return { ok: true, leg };
}

/*
  The passenger's consent to a leg.

  A receipt is signed by the vehicle. A passenger's public key is not a secret —
  it is in every QR they have ever shown — so a vehicle signature alone would
  let anyone holding a vehicle key bill any passenger for a ride they never
  took. The BT1 tap is the half only the passenger can produce. A leg is
  settled only with the tap that opened it, and the tap has to be:

    - signed by the passenger the receipt bills
    - for the vehicle the receipt is from
    - made at boarding: within TAP_MAX_AGE_S of the receipt's boardAt

  One tap opens one leg. That rule needs a memory of every tap nonce ever
  settled, so it lives in the database (a unique index), not here.
*/
export function verifyLegConsent(tapText, leg) {
  if (!tapText) {
    return { ok: false, reason: 'no_tap', message: 'No passenger tap came with this receipt.' };
  }
  const verdict = verifyTap(tapText, { now: leg.boardAt, maxAgeSeconds: TAP_MAX_AGE_S });
  if (verdict.reason === 'unreadable' || verdict.reason === 'bad_signature') {
    return { ok: false, reason: 'bad_tap', message: 'The tap was not signed by the passenger it names.' };
  }
  const { tap, skewS } = verdict;
  if (tap.passengerPublicKey !== leg.passengerPublicKey) {
    return { ok: false, reason: 'tap_mismatch', message: 'The tap belongs to a different passenger.', tap };
  }
  if (tap.vehicleId !== leg.vehicleId) {
    return { ok: false, reason: 'tap_mismatch', message: 'The tap was made for a different vehicle.', tap };
  }
  if (verdict.reason === 'stale') {
    return { ok: false, reason: 'tap_mismatch', message: 'The tap was not made when this ride began.', tap };
  }
  return { ok: true, tap, skewS };
}

// --------------------------------------------------------- BO1: boarding pass

/*
  The piece that makes a two-door ride work with no network at all.

  A ride starts at one terminal and ends at another. Those two terminals are one
  device on real hardware and two phones in a demo, and in Nepal they will
  regularly be two phones on a bus with no signal. So the boarding snapshot
  travels with the passenger rather than over a wire: the boarding terminal signs
  it with the vehicle key and hands it back as a QR, and the alighting terminal
  verifies that signature against the same vehicle key it was provisioned with.

  This is a paper ticket with a signature on it — which is exactly what it should
  be, because a paper ticket is the only fare medium that has ever worked on a
  Nepali bus. The only thing added is that this one cannot be forged, cannot be
  used twice, and carries the odometer reading it was issued at.
*/
export const PASS_VERSION = 'BO1';
const PASS_FIELDS = 13;

// Long enough for a slow ride across the valley, short enough that a pass found
// on the floor tomorrow is worth nothing.
export const PASS_MAX_AGE_S = 6 * 60 * 60;

function passBody(pass) {
  return [
    PASS_VERSION,
    pass.vehicleId,
    pass.tripId,
    pass.legId,
    pass.passengerPublicKey,
    pass.boardDoorId,
    pass.unitId,
    String(pass.boardOdoM),
    String(pass.boardLatMicro),
    String(pass.boardLonMicro),
    String(pass.boardAt),
    pass.concession,
  ].join(SEP);
}

export function buildPass({
  vehicleId,
  tripId,
  legId,
  passengerPublicKey,
  boardDoorId,
  unitId,
  boardOdoM,
  boardLatMicro = 0,
  boardLonMicro = 0,
  boardAt,
  concession = 'none',
}) {
  assertCode(vehicleId, 'vehicleId');
  assertCode(tripId, 'tripId', 32);
  assertCode(legId, 'legId', 32);
  assertCode(passengerPublicKey, 'passengerPublicKey', 43);
  assertCode(boardDoorId, 'boardDoorId', 8);
  // Which physical unit issued this pass. Odometer readings are only comparable
  // within one unit, so the alighting side has to know whether the number in the
  // pass came off the same odometer it is reading now.
  assertCode(unitId, 'unitId', 24);
  assertCode(concession, 'concession', 12);
  assertWholeNumber(boardOdoM, 'boardOdoM');
  assertWholeNumber(boardAt, 'boardAt');
  assertInteger(boardLatMicro, 'boardLatMicro');
  assertInteger(boardLonMicro, 'boardLonMicro');
  return {
    vehicleId, tripId, legId, passengerPublicKey, boardDoorId, unitId,
    boardOdoM, boardLatMicro, boardLonMicro, boardAt, concession,
  };
}

export function signPass(pass, vehicleSecretKeyBase64url) {
  const body = passBody(pass);
  const signature = nacl.sign.detached(utf8Bytes(body), fromBase64url(vehicleSecretKeyBase64url));
  return `${body}${SEP}${toBase64url(signature)}`;
}

export function decodePass(text) {
  const parts = String(text ?? '').trim().split(SEP);
  if (parts[0] !== PASS_VERSION) throw new Error('not a Bhada boarding pass');
  if (parts.length !== PASS_FIELDS) throw new Error('boarding pass is damaged or incomplete');
  const [
    , vehicleId, tripId, legId, passengerPublicKey, boardDoorId, unitId,
    boardOdoM, boardLatMicro, boardLonMicro, boardAt, concession, signature,
  ] = parts;
  const pass = {
    vehicleId,
    tripId,
    legId,
    passengerPublicKey,
    boardDoorId,
    unitId,
    boardOdoM: Number(boardOdoM),
    boardLatMicro: Number(boardLatMicro),
    boardLonMicro: Number(boardLonMicro),
    boardAt: Number(boardAt),
    concession,
  };
  for (const field of ['boardOdoM', 'boardLatMicro', 'boardLonMicro', 'boardAt']) {
    assertInteger(pass[field], field);
  }
  return { pass, signature, body: passBody(pass) };
}

export function verifyPass(text, { vehiclePublicKey, vehicleId, seenLegIds, now = Math.floor(Date.now() / 1000), maxAgeSeconds = PASS_MAX_AGE_S } = {}) {
  let decoded;
  try {
    decoded = decodePass(text);
  } catch (error) {
    return { ok: false, reason: 'unreadable', message: error.message };
  }
  const { pass, signature, body } = decoded;

  let valid = false;
  try {
    valid = nacl.sign.detached.verify(
      utf8Bytes(body),
      fromBase64url(signature),
      fromBase64url(vehiclePublicKey),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature', message: 'This pass was not issued by this vehicle.', pass };

  if (vehicleId && pass.vehicleId !== vehicleId) {
    return { ok: false, reason: 'wrong_vehicle', message: `Pass belongs to vehicle ${pass.vehicleId}.`, pass };
  }
  // A closed leg's pass is a used ticket. Refusing it here is what stops one
  // boarding paying for two rides.
  if (seenLegIds && seenLegIds.has(pass.legId)) {
    return { ok: false, reason: 'replay', message: 'This ride was already closed.', pass };
  }
  if (now - pass.boardAt > maxAgeSeconds) {
    return { ok: false, reason: 'stale', message: 'Pass is from an earlier day.', pass };
  }
  return { ok: true, pass };
}
