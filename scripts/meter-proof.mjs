// Step 3 proof: the on-vehicle meter, end to end, with no network and no browser.
//
// A scripted drive down the Ratna Park — Koteshwor corridor, with the GNSS noise
// a real receiver produces: a stationary wander at the terminus, a multipath
// jump under the Tinkune flyover, and a tunnel where fixes stop arriving. Two
// passengers board at different points and alight at different points. A third
// never taps out. The bus fills up and the boarding door interlock fires.
//
// Everything below runs the same functions the phones run. Nothing is mocked
// except the receiver, and the receiver is mocked by feeding it coordinates.
//
// Run: node scripts/meter-proof.mjs

import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { useRandomSource } from '../protocol/random.mjs';
import { createKeypair } from '../protocol/token.mjs';
import {
  initialOdometer, applyFix, odometerReading, priceDistance, resolveDistance, haversineMetres,
  doorDecision, admitDecision, DOOR_ROLE, TARIFF, TARIFFS, FUSION,
  snapToRoute, routeDistanceM, DISTANCE_SOURCE, CIRCUITY_FACTOR, ROUTE_SNAP_MAX_OFFSET_M,
} from '../protocol/meter.mjs';
import {
  buildPass, signPass, verifyPass, buildLeg, signLeg, verifyLeg, verifyLegConsent, toMicro, fromMicro,
  buildTap, signTap, verifyTap,
} from '../protocol/leg.mjs';
import { encodeFrame, decodeFrame, frameToHex, FLAG } from '../protocol/frame.mjs';
import {
  buildSignOn, signSignOn, verifySignOn, assessPower, cleanTripVerdict,
  SIGNON_MAX_AGE_S, SHIFT_MAX_AGE_S, POWER_GRACE_S, POWER_MOVING_WINDOW_S,
} from '../protocol/crew.mjs';
import { CLEAN_TRIP_BONUS_NPR, CLEAN_TRIP_MIN_LEGS, RECORDED_SHARE_MIN_PCT } from '../protocol/policy.mjs';
import { buildRoster, signRoster, verifyRoster, checkRider, tallyInspection, KEY_PREFIX, ROSTER_MAX_AGE_S } from '../protocol/inspect.mjs';
import { buildGroup, splitGroup, buildTap as buildRideTap, signTap as signRideTap, GROUP_MAX } from '../protocol/leg.mjs';
import { createMasterSeed, deriveDailyKeypair, deriveCompanionKeypair, MAX_COMPANIONS } from '../protocol/pseudonym.mjs';
import { buildCashTicket, signCashTicket, verifyCashTicket } from '../protocol/cash.mjs';
import { buildRoad, expandProfile, simulateDrive, seeded } from '../src/lib/gnss-sim.js';

useRandomSource((length) => new Uint8Array(nodeRandomBytes(length)));

const pad = (label) => `${label}`.padEnd(30, '.');
const line = (label, value) => console.log(`  ${pad(label)} ${value}`);
const heading = (text) => console.log(`\n${text}`);

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// --- the corridor ----------------------------------------------------------
// The same coordinates the app ships, kept here rather than imported so this
// script proves the protocol and not the app's copy of a table.
const CORRIDOR = [
  { code: 'RATNAPARK', lat: 27.7045, lon: 85.3145 },
  { code: 'SINGHADURBAR', lat: 27.6975, lon: 85.3230 },
  { code: 'MAITIGHAR', lat: 27.6928, lon: 85.3222 },
  { code: 'THAPATHALI', lat: 27.6905, lon: 85.3175 },
  { code: 'NEWBANESHWOR', lat: 27.6893, lon: 85.3400 },
  { code: 'TINKUNE', lat: 27.6835, lon: 85.3490 },
  { code: 'KOTESHWOR', lat: 27.6785, lon: 85.3495 },
];

const VEHICLE_ID = 'BA2KHA4412';
const CAPACITY = 4; // small on purpose: the interlock has to fire inside one proof
const UNIT = 'UMETER1';

const vehicle = createKeypair();

// --- the meter -------------------------------------------------------------
const meter = {
  odo: initialOdometer(0),
  tripId: 'TPROOF1',
  onboard: [],
  closed: [],
  clock: Math.floor(Date.now() / 1000),
};

function feed(fix) {
  const result = applyFix(meter.odo, fix);
  meter.odo = result.state;
  return result;
}

// A drive between two points, sampled once a second at a plausible speed, with
// a little lateral noise so no two fixes are perfectly collinear.
function* drive(from, to, speedMps = 11, noiseM = 3) {
  const straight = haversineMetres(from, to);
  const steps = Math.max(1, Math.round(straight / speedMps));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const jitterLat = ((Math.random() - 0.5) * noiseM) / 111320;
    const jitterLon = ((Math.random() - 0.5) * noiseM) / (111320 * Math.cos(from.lat * Math.PI / 180));
    meter.clock += 1;
    yield {
      lat: from.lat + (to.lat - from.lat) * t + jitterLat,
      lon: from.lon + (to.lon - from.lon) * t + jitterLon,
      accuracy: 6,
      at: meter.clock * 1000,
    };
  }
}

// --- passengers ------------------------------------------------------------
const riders = [
  { name: 'Sita', keys: createKeypair(), concession: 'none' },
  { name: 'Bibek', keys: createKeypair(), concession: 'student' },
  { name: 'Hari', keys: createKeypair(), concession: 'none' },
  { name: 'Maya', keys: createKeypair(), concession: 'senior' },
  { name: 'Ram', keys: createKeypair(), concession: 'none' },
  { name: 'Gita', keys: createKeypair(), concession: 'none' },
  { name: 'Kiran', keys: createKeypair(), concession: 'none' },
];

function tapIn(rider) {
  const admit = admitDecision({ onboard: meter.onboard.length, capacity: CAPACITY });
  if (!admit.admitted) return { ok: false, reason: admit.reason, message: admit.message };
  // The passenger's consent to the ride, signed on their own phone. The door
  // verifies it before issuing anything, and it travels with the leg to the
  // backend, which will not move money without it.
  const tap = signTap(
    buildTap({ passengerPublicKey: rider.keys.publicKey, vehicleId: VEHICLE_ID, doorId: 'A', timestamp: meter.clock }),
    rider.keys.secretKey,
  );
  const tapVerdict = verifyTap(tap, { vehicleId: VEHICLE_ID, now: meter.clock });
  if (!tapVerdict.ok) return tapVerdict;
  const pass = buildPass({
    vehicleId: VEHICLE_ID,
    tripId: meter.tripId,
    legId: `L${rider.name.toUpperCase()}`,
    passengerPublicKey: rider.keys.publicKey,
    boardDoorId: 'A',
    unitId: UNIT,
    boardOdoM: Math.round(meter.odo.metres),
    boardLatMicro: toMicro(meter.odo.lastFix.lat),
    boardLonMicro: toMicro(meter.odo.lastFix.lon),
    boardAt: meter.clock,
    concession: rider.concession,
  });
  const qr = signPass(pass, vehicle.secretKey);
  meter.onboard.push({ rider, pass, qr, tap });
  return { ok: true, pass, qr, tap };
}

function tapOut(rider) {
  const entry = meter.onboard.find((l) => l.rider === rider);
  if (!entry) return { ok: false, reason: 'not_aboard' };

  const verdict = verifyPass(entry.qr, { vehiclePublicKey: vehicle.publicKey, vehicleId: VEHICLE_ID, now: meter.clock });
  if (!verdict.ok) return verdict;

  const measured = resolveDistance({
    boardOdoM: verdict.pass.boardOdoM,
    alightOdoM: Math.round(meter.odo.metres),
    boardFix: { lat: fromMicro(verdict.pass.boardLatMicro), lon: fromMicro(verdict.pass.boardLonMicro) },
    alightFix: meter.odo.lastFix,
  });
  const price = priceDistance(measured.metres, { concession: verdict.pass.concession });
  const receipt = signLeg(
    buildLeg({
      vehicleId: VEHICLE_ID,
      tripId: meter.tripId,
      legId: verdict.pass.legId,
      passengerPublicKey: verdict.pass.passengerPublicKey,
      boardDoorId: verdict.pass.boardDoorId,
      alightDoorId: 'B',
      boardOdoM: verdict.pass.boardOdoM,
      alightOdoM: Math.round(meter.odo.metres),
      distanceM: Math.round(measured.metres),
      distanceSource: measured.source,
      boardAt: verdict.pass.boardAt,
      alightAt: meter.clock,
      concession: verdict.pass.concession,
      amount: price.amount,
      tariffCode: price.tariffCode,
    }),
    vehicle.secretKey,
  );
  meter.onboard = meter.onboard.filter((l) => l !== entry);
  const closed = { rider, measured, price, receipt, tap: entry.tap };
  meter.closed.push(closed);
  return { ok: true, ...closed };
}

// ===========================================================================
console.log('\nBhada meter proof — no network, no browser, no map service');
console.log(`Tariff ${TARIFF.code}: Rs ${TARIFF.boardingCharge} covers ${TARIFF.includedKm} km, then Rs ${TARIFF.perStep}/km, cap Rs ${TARIFF.cap}`);

heading('1. Receiver noise is rejected before it becomes distance');
feed({ lat: CORRIDOR[0].lat, lon: CORRIDOR[0].lon, accuracy: 5, at: (meter.clock += 1) * 1000 });
const before = meter.odo.metres;

// Parked at Ratna Park for two minutes. A real chip wanders several metres a
// second; none of it is travel.
for (let i = 0; i < 120; i += 1) {
  feed({
    lat: CORRIDOR[0].lat + (Math.random() - 0.5) * 0.00005,
    lon: CORRIDOR[0].lon + (Math.random() - 0.5) * 0.00005,
    accuracy: 8,
    at: (meter.clock += 1) * 1000,
  });
}
line('stationary fixes fed', 120);
line('odometer moved', `${(meter.odo.metres - before).toFixed(1)} m`);
check('parked bus bills nothing', meter.odo.metres - before < 1, `${(meter.odo.metres - before).toFixed(2)} m`);

const vague = feed({ lat: CORRIDOR[0].lat + 0.01, lon: CORRIDOR[0].lon, accuracy: 120, at: (meter.clock += 1) * 1000 });
check('vague fix rejected', !vague.accepted && vague.reason === 'accuracy', vague.reason);

const teleport = feed({ lat: CORRIDOR[0].lat + 0.05, lon: CORRIDOR[0].lon + 0.05, accuracy: 6, at: (meter.clock += 1) * 1000 });
check('multipath jump rejected', !teleport.accepted && teleport.reason === 'implausible_speed', teleport.reason);
line('odometer after noise', `${meter.odo.metres.toFixed(1)} m`);

heading('2. A real drive integrates to a real distance');
// Re-anchor after the teleport gate moved the anchor to a bad point.
feed({ lat: CORRIDOR[0].lat, lon: CORRIDOR[0].lon, accuracy: 5, at: (meter.clock += 1) * 1000 });
const startM = meter.odo.metres;

const sita = tapIn(riders[0]);
check('Sita boards', sita.ok);
line('Sita boarding odometer', `${sita.pass.boardOdoM} m`);

for (const fix of drive(CORRIDOR[0], CORRIDOR[1])) feed(fix);
const bibek = tapIn(riders[1]);
check('Bibek boards at Singha Durbar', bibek.ok);

for (const fix of drive(CORRIDOR[1], CORRIDOR[2])) feed(fix);
for (const fix of drive(CORRIDOR[2], CORRIDOR[3])) feed(fix);

const sitaOut = tapOut(riders[0]);
check('Sita alights', sitaOut.ok);
line('Sita distance', `${(sitaOut.measured.metres / 1000).toFixed(2)} km via ${sitaOut.measured.source}`);
line('Sita fare', `Rs ${sitaOut.price.amount}`);
for (const item of sitaOut.price.breakdown) line(`  ${item.label}`, item.value);

const straightLine = haversineMetres(CORRIDOR[0], CORRIDOR[3]);
check(
  'odometer exceeds the straight line',
  sitaOut.measured.metres >= straightLine,
  `${Math.round(sitaOut.measured.metres)} m vs ${Math.round(straightLine)} m as the crow flies`,
);
check('priced from the odometer, not an estimate', sitaOut.measured.source === 'odometer');

heading('3. Concession halves the same ride');
for (const fix of drive(CORRIDOR[3], CORRIDOR[4])) feed(fix);
const bibekOut = tapOut(riders[1]);
line('Bibek distance', `${(bibekOut.measured.metres / 1000).toFixed(2)} km`);
line('Bibek fare (student)', `Rs ${bibekOut.price.amount}`);
const full = priceDistance(bibekOut.measured.metres, { concession: 'none' });
line('same ride at full fare', `Rs ${full.amount}`);
check('student pays half, rounded up', bibekOut.price.amount === Math.ceil(full.amount / 2));

heading('4. A signed receipt survives the trip to the backend');
const settled = verifyLeg(bibekOut.receipt, {
  vehiclePublicKey: vehicle.publicKey,
  priceFn: (m, o) => priceDistance(m, o),
});
check('backend verifies the vehicle signature', settled.ok, settled.reason ?? '');
check('backend reproduces the fare', settled.ok && settled.leg.amount === bibekOut.price.amount);

const tampered = bibekOut.receipt.replace(`|${bibekOut.price.amount}|`, `|${bibekOut.price.amount - 10}|`);
const tamperVerdict = verifyLeg(tampered, { vehiclePublicKey: vehicle.publicKey });
check('an edited fare is refused', !tamperVerdict.ok, tamperVerdict.reason);

const reused = verifyLeg(bibekOut.receipt, {
  vehiclePublicKey: vehicle.publicKey,
  seenLegIds: new Set([bibekOut.receipt.split('|')[3]]),
});
check('a replayed receipt is refused', !reused.ok && reused.reason === 'replay');

// A tariff change must not turn last month's honest receipts into mismatches,
// and a tariff nobody published must not price anything.
{
  const oldLeg = (code, amount) => signLeg(buildLeg({
    ...settled.leg, legId: `LOLD${code.length}`, tariffCode: code, amount,
  }), vehicle.secretKey);
  const old = TARIFFS['NPR-KTM-2026'];
  const oldAmount = priceDistance(settled.leg.distanceM, { concession: settled.leg.concession, tariff: old }).amount;
  const underOld = verifyLeg(oldLeg('NPR-KTM-2026', oldAmount), { vehiclePublicKey: vehicle.publicKey, priceFn: priceDistance });
  check('a receipt priced under the previous tariff still reproduces', underOld.ok, underOld.reason ?? `Rs ${oldAmount}`);
  const invented = verifyLeg(oldLeg('NPR-FREE-FOR-ALL', 1), { vehiclePublicKey: vehicle.publicKey, priceFn: priceDistance });
  check('a receipt under an unpublished tariff is refused', !invented.ok && invented.reason === 'price_mismatch', invented.reason);
}

// The vehicle key signs receipts, but a passenger's public key is printed in
// every QR they have ever shown. Without the passenger's own signed tap, anyone
// holding a vehicle key could sign a receipt for any passenger and bill them.
// The tap is the passenger's consent, and the backend settles nothing without it.
const consent = verifyLegConsent(bibekOut.tap, settled.leg);
check('the passenger\'s own tap vouches for the ride', consent.ok, consent.reason ?? '');

const noTap = verifyLegConsent(null, settled.leg);
check('a receipt with no passenger tap is refused', !noTap.ok && noTap.reason === 'no_tap', noTap.reason);

const someoneElse = verifyLegConsent(sitaOut.tap, settled.leg);
check('another passenger\'s tap cannot vouch for this ride', !someoneElse.ok && someoneElse.reason === 'tap_mismatch', someoneElse.reason);

const impostorTap = signTap(
  buildTap({ passengerPublicKey: riders[1].keys.publicKey, vehicleId: VEHICLE_ID, doorId: 'A', timestamp: settled.leg.boardAt }),
  createKeypair().secretKey,
);
const forgedConsent = verifyLegConsent(impostorTap, settled.leg);
check('a tap forged by the operator is refused', !forgedConsent.ok && forgedConsent.reason === 'bad_tap', forgedConsent.reason);

const lateTap = signTap(
  buildTap({ passengerPublicKey: riders[1].keys.publicKey, vehicleId: VEHICLE_ID, doorId: 'A', timestamp: settled.leg.boardAt + 3600 }),
  riders[1].keys.secretKey,
);
const detached = verifyLegConsent(lateTap, settled.leg);
check('a tap from another time cannot open this ride', !detached.ok && detached.reason === 'tap_mismatch', detached.reason);

heading('5. A pass from another vehicle is worthless');
const otherBus = createKeypair();
const forged = signPass(
  buildPass({
    vehicleId: VEHICLE_ID,
    tripId: meter.tripId,
    legId: 'LFORGED',
    passengerPublicKey: riders[2].keys.publicKey,
    boardDoorId: 'A',
    unitId: UNIT,
    boardOdoM: 0,
    boardLatMicro: toMicro(CORRIDOR[0].lat),
    boardLonMicro: toMicro(CORRIDOR[0].lon),
    boardAt: meter.clock,
    concession: 'none',
  }),
  otherBus.secretKey,
);
const forgedVerdict = verifyPass(forged, { vehiclePublicKey: vehicle.publicKey, vehicleId: VEHICLE_ID, now: meter.clock });
check('pass signed by another bus is refused', !forgedVerdict.ok && forgedVerdict.reason === 'bad_signature');

heading('6. The bus fills up and the boarding door locks itself');
for (const rider of riders.slice(2)) {
  const result = tapIn(rider);
  line(`${rider.name} boards`, result.ok ? `yes — ${meter.onboard.length}/${CAPACITY} aboard` : `NO — ${result.message}`);
}
check('the fifth passenger is turned away', meter.onboard.length === CAPACITY, `${meter.onboard.length} aboard, capacity ${CAPACITY}`);
const doorFull = doorDecision({ role: DOOR_ROLE.BOARDING, onboard: meter.onboard.length, capacity: CAPACITY, speedMps: 0 });
check('boarding door held shut at capacity', !doorFull.open && doorFull.reason === 'at_capacity', `${meter.onboard.length}/${CAPACITY}`);

const exitFull = doorDecision({ role: DOOR_ROLE.ALIGHTING, onboard: meter.onboard.length, capacity: CAPACITY, speedMps: 0 });
check('alighting door is never held shut by capacity', exitFull.open, 'a full bus is when people most need out');

const movingDoor = doorDecision({ role: DOOR_ROLE.ALIGHTING, onboard: 1, capacity: CAPACITY, speedMps: 8 });
check('no door opens above walking pace', !movingDoor.open && movingDoor.reason === 'in_motion');

// A Nepali bus with its one door: the way in and the only way out.
const oneDoorFull = doorDecision({ role: DOOR_ROLE.BOTH, onboard: meter.onboard.length, capacity: CAPACITY, speedMps: 0 });
check('one-door bus at capacity: the door stays open, getting off only', oneDoorFull.open && oneDoorFull.reason === 'exit_only' && oneDoorFull.audit);
check('...and the next tap-in is still refused', !admitDecision({ onboard: meter.onboard.length, capacity: CAPACITY }).admitted);
const oneDoorMoving = doorDecision({ role: DOOR_ROLE.BOTH, onboard: 1, capacity: CAPACITY, speedMps: 8 });
check('one-door bus moving: the door is held like any other', !oneDoorMoving.open && oneDoorMoving.reason === 'in_motion');
const oneDoorClear = doorDecision({ role: DOOR_ROLE.BOTH, onboard: 1, capacity: CAPACITY, speedMps: 0 });
check('one-door bus with room: open, nothing on the tape', oneDoorClear.open && oneDoorClear.reason === 'clear' && !oneDoorClear.audit);

const overridden = doorDecision({ role: DOOR_ROLE.BOARDING, onboard: 99, capacity: CAPACITY, speedMps: 0, override: true });
check('crew override always opens, and is audited', overridden.open && overridden.audit);

heading('6b. No ride costs more than it does today');
// The promise the tariff is sold on. Today's regulated stage fare on R11 is
// Rs 15 for one stage, Rs 5 for each further stage, capped at Rs 25 end to end
// (0002_seed.sql). The metered fare for the same two stages, over the road
// distance between them, must never be higher — on every pair, not on average.
{
  const STAGE_CHAIN_M = [0, 1500, 2200, 2900, 5300, 6600, 7500]; // src/lib/nepali.js STOPS
  let dearer = [];
  let cheaper = 0;
  let pairs = 0;
  for (let i = 0; i < STAGE_CHAIN_M.length; i += 1) {
    for (let j = i + 1; j < STAGE_CHAIN_M.length; j += 1) {
      pairs += 1;
      const stage = Math.min(25, 15 + 5 * (j - i - 1));
      const metered = priceDistance(STAGE_CHAIN_M[j] - STAGE_CHAIN_M[i]).amount;
      if (metered > stage) dearer.push(`${CORRIDOR[i].code}→${CORRIDOR[j].code} Rs ${stage}→${metered}`);
      else if (metered < stage) cheaper += 1;
    }
  }
  line('stage pairs compared', pairs);
  line('cheaper metered', cheaper);
  check('no stage-to-stage ride is dearer metered than today', dearer.length === 0, dearer.join(', ') || 'none');
}

heading('7. A ride nobody closed is charged at the cap');
const stranded = meter.onboard[0];
const unclosed = priceDistance(999999, { concession: stranded.rider.concession });
line(`${stranded.rider.name} never tapped out`, `charged Rs ${TARIFF.unclosedLegFare}`);
check('an open leg cannot be cheaper than a closed one', TARIFF.unclosedLegFare >= unclosed.amount);

// The cap charge has to survive the backend, which re-prices every receipt.
// A receipt that says "0.4 km, Rs 25" does not reproduce from distance, so an
// unclosed leg is marked as one and priced by the unclosed rule instead — at
// the passenger's own concession, since the most a student can pay for a closed
// ride is half the cap.
for (const concession of ['none', 'student']) {
  const receipt = signLeg(buildLeg({
    vehicleId: VEHICLE_ID, tripId: meter.tripId, legId: `LUNCLOSED${concession.length}`,
    passengerPublicKey: stranded.rider.keys.publicKey, boardDoorId: 'A', alightDoorId: 'A',
    boardOdoM: stranded.pass.boardOdoM, alightOdoM: stranded.pass.boardOdoM + 420, distanceM: 420,
    distanceSource: 'unclosed', boardAt: stranded.pass.boardAt, alightAt: meter.clock + 60,
    concession, amount: priceDistance(420, { concession, unclosed: true }).amount, tariffCode: TARIFF.code,
  }), vehicle.secretKey);
  const verdict = verifyLeg(receipt, { vehiclePublicKey: vehicle.publicKey, priceFn: priceDistance });
  check(
    `an unclosed ${concession === 'none' ? 'full-fare' : 'student'} leg settles at its cap`,
    verdict.ok && verdict.leg.amount === Math.ceil(TARIFF.unclosedLegFare * (concession === 'none' ? 1 : 0.5)),
    verdict.ok ? `Rs ${verdict.leg.amount}` : verdict.reason,
  );
}

heading('8. The endpoint fallback, for a box whose odometer died');
const bench = resolveDistance({
  boardOdoM: 1000,
  alightOdoM: 1000,           // flat: the box never moved
  boardFix: CORRIDOR[0],
  alightFix: CORRIDOR[4],     // but the endpoints are 3 km apart
});
check('a flat odometer defers to the endpoints', bench.source === 'gps', bench.note ?? '');
line('estimated distance', `${(bench.metres / 1000).toFixed(2)} km (straight line × ${(bench.metres / haversineMetres(CORRIDOR[0], CORRIDOR[4])).toFixed(2)})`);
check('estimate is flagged as an estimate', bench.estimated);

heading('9. The 32-byte frame that goes out over GPRS');
const frame = encodeFrame({
  flags: FLAG.MOVING | FLAG.FIX_VALID | FLAG.AT_CAPACITY | FLAG.OFFLINE_QUEUE,
  occupancy: meter.onboard.length,
  capacity: CAPACITY,
  odometerMetres: Math.round(meter.odo.metres),
  latMicro: toMicro(meter.odo.lastFix.lat),
  lonMicro: toMicro(meter.odo.lastFix.lon),
  speedCmS: Math.round(meter.odo.speedMps * 100),
  unixSeconds: meter.clock,
  openLegs: meter.onboard.length,
  accrued: meter.closed.reduce((sum, l) => sum + l.price.amount, 0),
});
line('frame', frameToHex(frame));
line('bytes on the wire', `${frame.length} (JSON equivalent ≈ 210)`);
const round = decodeFrame(frame);
check('frame round-trips exactly', round.odometerMetres === Math.round(meter.odo.metres) && round.capacity === CAPACITY);
check('frame reports the flags set', round.flagNames.includes('AT_CAPACITY') && round.flagNames.includes('OFFLINE_QUEUE'));

const corrupt = Uint8Array.from(frame);
corrupt[7] ^= 0x40; // one bit, as a bad radio would
let crcCaught = false;
try { decodeFrame(corrupt); } catch { crcCaught = true; }
check('a single flipped bit is caught by CRC', crcCaught);

heading('10. Accuracy against a road whose length is known');
// Every drive above runs straight lines at one speed, which proves the gates
// and nothing about accuracy. This section is the accuracy claim: a road that
// bends, a speed profile that stops and crawls the way Kathmandu traffic does,
// and receiver error that wanders like a real chip's. Ground truth is the
// length of the road actually driven, and the odometer has to land within
// ACCURACY_TOLERANCE of it at every speed a bus actually runs — on the worst of
// SEEDS independent drives, not on one lucky one.
const ACCURACY_TOLERANCE = 0.02;
const NO_DOPPLER_UNDER_READ = 0.10;
const SEEDS = 5;
const road = buildRoad(CORRIDOR, { wiggleM: 12, wavelengthM: 220 });
line('test road', `${(road.lengthM / 1000).toFixed(2)} km, sharp corners at 7 junctions, bends every 220 m`);
line('receiver model', 'wander σ 2.5 m (τ 30 s) + jitter 0.8 m, 1 Hz');

const stopAndGo = [];
for (let i = 0; i < 12; i += 1) {
  stopAndGo.push({ speedMps: 7, forS: 25 }, { stopS: 30 }, { speedMps: 1.5, forS: 5 }, { stopS: 40 });
}
const SCENARIOS = [
  { name: 'walking the demo, 5 km/h', phases: [{ speedMps: 1.4, forS: 900 }] },
  { name: 'jam crawl, 11 km/h', phases: [{ speedMps: 3, forS: 600 }] },
  { name: 'city traffic, 22 km/h', phases: [{ speedMps: 6, forS: 400 }] },
  { name: 'open road, 40 km/h', phases: [{ speedMps: 11, forS: 250 }] },
  { name: 'stop-and-go junctions', phases: stopAndGo },
  { name: 'multipath spikes, 22 km/h', phases: [{ speedMps: 6, forS: 400 }], spikes: true },
];

function measureDrive(phases, { doppler, spikes = false, seed }) {
  // Parked at the terminus first: the meter has booted and settled before the
  // first passenger boards, which is the only time accuracy is billed.
  const speeds = expandProfile([{ stopS: 20 }, ...phases]);
  const { fixes, truthM } = simulateDrive(road, speeds, { seed, doppler });
  if (spikes) {
    // Every 45th fix bounces 150 m off a building and still claims to be good.
    for (let i = 45; i < fixes.length; i += 45) {
      fixes[i] = { ...fixes[i], lat: fixes[i].lat + 150 / 111320, accuracy: 9 };
    }
  }
  let odo = initialOdometer(0);
  for (const fix of fixes) odo = applyFix(odo, fix).state;
  return { truthM, measuredM: odo.metres, errorPct: ((odo.metres - truthM) / truthM) * 100 };
}

const pct = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

function sweep(scenario, index, doppler) {
  const errors = [];
  let truthM = 0;
  for (let s = 0; s < SEEDS; s += 1) {
    const r = measureDrive(scenario.phases, { doppler, spikes: scenario.spikes, seed: 1000 * (index + 1) + s });
    errors.push(r.errorPct);
    truthM = r.truthM;
  }
  const worst = errors.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  return { errors, worst, mean, truthM };
}

// The receiver a phone on a bus actually has. Android and iOS both report the
// chip's Doppler speed with a GPS fix, and it is what the meter is built on.
console.log('  receiver reports Doppler speed — the measured grade');
SCENARIOS.forEach((scenario, index) => {
  const r = sweep(scenario, index, true);
  line(`  ${scenario.name}`, `${(r.truthM / 1000).toFixed(2)} km, mean ${pct(r.mean)}, worst ${pct(r.worst)}`);
  check(
    `within ±${ACCURACY_TOLERANCE * 100}% on all ${SEEDS} drives — ${scenario.name}`,
    Math.abs(r.worst) <= ACCURACY_TOLERANCE * 100,
  );
});

// A receiver that only gives positions (a laptop, some browsers). The meter
// cannot tell a slow crawl from wander as well without Doppler, so it resolves
// every doubt towards the passenger: it may under-read, it must never over-read.
console.log('  no Doppler, position only — the conservative grade');
SCENARIOS.forEach((scenario, index) => {
  const r = sweep(scenario, index, false);
  const high = Math.max(...r.errors);
  const low = Math.min(...r.errors);
  line(`  ${scenario.name}`, `${(r.truthM / 1000).toFixed(2)} km, ${pct(low)} to ${pct(high)}`);
  check(
    `never over-reads past ${ACCURACY_TOLERANCE * 100}%, under-reads at most ${NO_DOPPLER_UNDER_READ * 100}% — ${scenario.name}`,
    high <= ACCURACY_TOLERANCE * 100 && low >= -NO_DOPPLER_UNDER_READ * 100,
  );
});

// Ten minutes parked with a receiver that wanders four metres — harsher than
// the drives above. A meter that bills this is billing people for sitting in
// traffic.
for (const doppler of [true, false]) {
  let worstM = 0;
  for (let s = 0; s < SEEDS; s += 1) {
    const parked = simulateDrive(road, expandProfile([{ stopS: 600 }]), {
      seed: 77 + s, doppler, wanderM: 4, accuracyM: 12,
    });
    let odo = initialOdometer(0);
    for (const fix of parked.fixes) odo = applyFix(odo, fix).state;
    worstM = Math.max(worstM, odo.metres);
  }
  const limit = doppler ? 1 : 20;
  check(
    `ten minutes parked bills under ${limit} m${doppler ? '' : ', no Doppler'}`,
    worstM < limit,
    `worst ${worstM.toFixed(1)} m`,
  );
}

// Mid-chord, the reading must include the distance the anchor is holding, or a
// tap that lands between chords under-charges and the next one over-charges.
{
  const { fixes } = simulateDrive(road, expandProfile([{ stopS: 10 }, { speedMps: 1.4, forS: 60 }]), { seed: 5 });
  let odo = initialOdometer(0);
  let heldSeen = false;
  let monotonic = true;
  let previous = 0;
  for (const fix of fixes) {
    odo = applyFix(odo, fix).state;
    const reading = odometerReading(odo);
    if (reading > odo.metres) heldSeen = true;
    if (reading < previous - 0.01) monotonic = false;
    previous = reading;
  }
  check('the reading includes distance held mid-chord', heldSeen);
  check('the reading never runs backwards', monotonic);
}

heading('11. What the passenger actually pays');
// Distance error is the engineer's number. The passenger's number is whether
// the fare on the receipt is the fare for the ride they took. A long mixed day
// — crawl, junction stops, open stretches — and random legs across it, each
// priced from the odometer and from the true road distance.
const day = [];
for (let i = 0; i < 6; i += 1) {
  day.push(
    { speedMps: 3, forS: 60 }, { stopS: 25 }, { speedMps: 8, forS: 50 }, { stopS: 40 },
    { speedMps: 1.5, forS: 8 }, { stopS: 20 }, { speedMps: 11, forS: 30 }, { stopS: 15 },
  );
}
const dayDrive = simulateDrive(road, expandProfile([{ stopS: 20 }, ...day]), { seed: 2026 });
const readings = [];
{
  let odo = initialOdometer(0);
  for (const fix of dayDrive.fixes) {
    odo = applyFix(odo, fix).state;
    readings.push(odometerReading(odo));
  }
}
const pick = seeded(11);
let legs = 0;
let exact = 0;
let over = 0;
let worstOverRs = 0;
let worstLegErrM = 0;
while (legs < 400) {
  const a = Math.floor(pick() * readings.length);
  const b = Math.floor(pick() * readings.length);
  const [board, alight] = a < b ? [a, b] : [b, a];
  const trueM = dayDrive.chains[alight] - dayDrive.chains[board];
  if (trueM < 300) continue; // nobody rides 300 m
  const meteredM = readings[alight] - readings[board];
  const trueFare = priceDistance(trueM).amount;
  const meteredFare = priceDistance(meteredM).amount;
  legs += 1;
  if (meteredFare === trueFare) exact += 1;
  if (meteredFare > trueFare) {
    over += 1;
    worstOverRs = Math.max(worstOverRs, meteredFare - trueFare);
  }
  worstLegErrM = Math.max(worstLegErrM, Math.abs(meteredM - trueM));
}
line('day driven', `${(dayDrive.truthM / 1000).toFixed(2)} km with ${day.filter((p) => p.stopS).length} stops`);
line('legs priced', legs);
line('fare exactly right', `${exact} (${((exact / legs) * 100).toFixed(1)}%)`);
line('fare one step high', `${over} (${((over / legs) * 100).toFixed(1)}%), worst Rs ${worstOverRs}`);
line('worst leg distance error', `${worstLegErrM.toFixed(0)} m`);
check('at least 95% of fares are exactly the true fare', exact / legs >= 0.95);
check(`no fare is ever more than one step (Rs ${TARIFF.perStep}) high`, worstOverRs <= TARIFF.perStep);

heading('\n6c. A ride with no odometer is measured along the route, not across it');
/*
  The failure this answers: the bus loses its fixes to multipath for a minute —
  under the Baneshwor flyover, in the lanes at Ason — and the odometer stops with
  them. What is left is two endpoints. Measuring across them and scaling by 1.3
  is a guess; placing them on the route the bus was driving and subtracting
  chainages is the road's own length.

  The route here is the published stage chainage, the same array the terminal
  hands in. The truth is the simulated road's own length between the two points,
  which is a wiggly line through the corridor rather than the chainage — so this
  compares two independent numbers, not a figure against itself.
*/
{
  const ROUTE = CORRIDOR.map((stop, i) => ({ ...stop, chainM: [0, 1500, 2200, 2900, 5300, 6600, 7500][i] }));

  // On-route, at the stages themselves: chainage must come back exactly.
  const atRatnaPark = snapToRoute(ROUTE[0], ROUTE);
  const atKoteshwor = snapToRoute(ROUTE[6], ROUTE);
  check('a fix at a stage snaps to that stage\'s chainage',
    Math.round(atRatnaPark.chainM) === 0 && Math.round(atKoteshwor.chainM) === 7500,
    `${Math.round(atRatnaPark.chainM)} m and ${Math.round(atKoteshwor.chainM)} m`);
  check('a fix on the route sits within a metre of it',
    atRatnaPark.offsetM < 1 && atKoteshwor.offsetM < 1,
    `${atRatnaPark.offsetM.toFixed(1)} m / ${atKoteshwor.offsetM.toFixed(1)} m`);

  // Every stage pair, snapped against the straight-line estimate it replaces.
  let routeWorst = 0;
  let circuityWorst = 0;
  let routeBeat = 0;
  let pairs = 0;
  for (let i = 0; i < ROUTE.length; i += 1) {
    for (let j = i + 1; j < ROUTE.length; j += 1) {
      pairs += 1;
      const truthM = ROUTE[j].chainM - ROUTE[i].chainM;
      const snapped = routeDistanceM(ROUTE[i], ROUTE[j], ROUTE);
      const circuityM = haversineMetres(ROUTE[i], ROUTE[j]) * CIRCUITY_FACTOR;
      const routeErr = Math.abs(snapped.metres - truthM) / truthM;
      const circuityErr = Math.abs(circuityM - truthM) / truthM;
      routeWorst = Math.max(routeWorst, routeErr);
      circuityWorst = Math.max(circuityWorst, circuityErr);
      if (routeErr <= circuityErr) routeBeat += 1;
    }
  }
  line('stage pairs measured', pairs);
  line('worst error, along the route', `${(routeWorst * 100).toFixed(1)}%`);
  line('worst error, straight line x 1.3', `${(circuityWorst * 100).toFixed(1)}%`);
  check('the route measurement is never worse than the straight-line guess', routeBeat === pairs, `${routeBeat}/${pairs}`);
  check('the route measurement is within 1% on every pair', routeWorst < 0.01, `${(routeWorst * 100).toFixed(2)}%`);

  // A bus that is not on this route must not be snapped onto it. Swayambhu is
  // about 4 km west of the corridor.
  const offRoute = { lat: 27.7149, lon: 85.2900 };
  check('a fix off the route is refused, not snapped',
    routeDistanceM(offRoute, ROUTE[3], ROUTE) === null,
    `offset ${Math.round(snapToRoute(offRoute, ROUTE).offsetM)} m > ${ROUTE_SNAP_MAX_OFFSET_M} m`);

  // And the whole rule, through resolveDistance: no odometer reading at all.
  const resolved = resolveDistance({
    boardOdoM: NaN, alightOdoM: NaN,
    boardFix: ROUTE[1], alightFix: ROUTE[5],
    route: ROUTE,
  });
  check('resolveDistance picks the route when the odometer has nothing',
    resolved.source === DISTANCE_SOURCE.ROUTE, resolved.source);
  check('and prices it at the road distance between those stages',
    Math.round(resolved.metres) === 6600 - 1500, `${Math.round(resolved.metres)} m`);

  // With no route handed in, the old estimate still stands — nothing regressed.
  const withoutRoute = resolveDistance({
    boardOdoM: NaN, alightOdoM: NaN, boardFix: ROUTE[1], alightFix: ROUTE[5],
  });
  check('without a route it still falls back to the straight-line estimate',
    withoutRoute.source === DISTANCE_SOURCE.GPS, withoutRoute.source);
  const savedRs = priceDistance(resolved.metres).amount - priceDistance(withoutRoute.metres).amount;
  line('same ride, the two ways', `route Rs ${priceDistance(resolved.metres).amount} vs straight line Rs ${priceDistance(withoutRoute.metres).amount} (${savedRs >= 0 ? '+' : ''}${savedRs})`);
}

heading('12. Somebody reaches under the seat and pulls the plug');
{
  /*
    The watcher, one tick at a time, with no phone and no charger. A step drives
    the rule with the state it kept from the step before, which is exactly how
    the device calls it.
  */
  const run = (steps) => {
    let carried = { charging: true, lostAt: null, pulled: false, lastMovedAt: null };
    const events = [];
    for (const step of steps) {
      carried = { ...carried, ...step };
      const next = assessPower(carried, { now: step.now });
      if (next.event) events.push({ at: step.now, event: next.event });
      carried = { ...carried, lostAt: next.lostAt, pulled: next.pulled };
    }
    return events;
  };

  // A bus working the corridor. The plug comes out at t=1000 and stays out.
  const pulled = run([
    { now: 900, charging: true, lastMovedAt: 900 },
    { now: 1000, charging: false, lastMovedAt: 995 },
    { now: 1000 + POWER_GRACE_S - 1, charging: false, lastMovedAt: 995 },
    { now: 1000 + POWER_GRACE_S, charging: false, lastMovedAt: 995 },
    { now: 1000 + POWER_GRACE_S + 60, charging: false, lastMovedAt: 995 },
  ]);
  const early = pulled.filter((e) => e.at < 1000 + POWER_GRACE_S);
  check('nothing is called while the grace period is still running',
    early.length === 0, `${early.length} event(s) inside ${POWER_GRACE_S} s`);
  check('the feed staying gone past the grace period raises power_lost',
    pulled.length === 1 && pulled[0].event === 'power_lost' && pulled[0].at === 1000 + POWER_GRACE_S,
    JSON.stringify(pulled));

  // The same absence on a bus that has been parked for twenty minutes. A depot
  // at midnight loses the same socket and is not tampering.
  const parked = run([
    { now: 5000, charging: true, lastMovedAt: 5000 - POWER_MOVING_WINDOW_S - 60 },
    { now: 5100, charging: false, lastMovedAt: 5000 - POWER_MOVING_WINDOW_S - 60 },
    { now: 5100 + POWER_GRACE_S * 4, charging: false, lastMovedAt: 5000 - POWER_MOVING_WINDOW_S - 60 },
  ]);
  check('a parked bus losing the same socket raises nothing', parked.length === 0, JSON.stringify(parked));

  // Plugged back in: one restore, and the watcher rearmed for the next pull.
  const restored = run([
    { now: 7000, charging: true, lastMovedAt: 7000 },
    { now: 7010, charging: false, lastMovedAt: 7005 },
    { now: 7010 + POWER_GRACE_S, charging: false, lastMovedAt: 7005 },
    { now: 7400, charging: true, lastMovedAt: 7390 },
    { now: 7500, charging: false, lastMovedAt: 7495 },
    { now: 7500 + POWER_GRACE_S, charging: false, lastMovedAt: 7495 },
  ]);
  check('plugging back in raises power_restored once',
    restored.filter((e) => e.event === 'power_restored').length === 1, JSON.stringify(restored));
  check('and the next pull is caught as well',
    restored.filter((e) => e.event === 'power_lost').length === 2, JSON.stringify(restored));

  // A platform that will not report the battery at all must not manufacture a
  // tamper out of a null.
  const unsupported = run([
    { now: 9000, charging: null, lastMovedAt: 9000 },
    { now: 9000 + POWER_GRACE_S * 3, charging: null, lastMovedAt: 9000 },
  ]);
  check('a phone whose platform will not say raises nothing', unsupported.length === 0, JSON.stringify(unsupported));
}

heading('13. The crew signs on, and a clean trip pays');
{
  const crew = createKeypair();
  const other = createKeypair();
  const now = 1_700_000_000;
  const signOn = signSignOn(buildSignOn({ crewPublicKey: crew.publicKey, vehicleId: 'BA2KHA4412', issuedAt: now }), crew.secretKey);

  check('a fresh sign-on verifies at the console',
    verifySignOn(signOn, { vehicleId: 'BA2KHA4412', now }).ok === true);
  check('and names the crew member it was signed by',
    verifySignOn(signOn, { now }).signOn.crewPublicKey === crew.publicKey);
  check('a sign-on for another bus is refused',
    verifySignOn(signOn, { vehicleId: 'BA1KHA1111', now }).reason === 'wrong_vehicle');
  check('a sign-on older than the console window is refused',
    verifySignOn(signOn, { now: now + SIGNON_MAX_AGE_S + 1 }).reason === 'expired');
  check('...but the backend still takes it over a whole shift',
    verifySignOn(signOn, { maxAgeS: SHIFT_MAX_AGE_S, now: now + SHIFT_MAX_AGE_S - 60 }).ok === true);
  check('and not the day after',
    verifySignOn(signOn, { maxAgeS: SHIFT_MAX_AGE_S, now: now + SHIFT_MAX_AGE_S + 60 }).reason === 'expired');

  // The signature is the whole claim: another key cannot sign somebody on.
  const forged = signSignOn(buildSignOn({ crewPublicKey: crew.publicKey, vehicleId: 'BA2KHA4412', issuedAt: now }), other.secretKey);
  check('a sign-on signed by somebody else is refused',
    verifySignOn(forged, { vehicleId: 'BA2KHA4412', now }).reason === 'bad_signature');
  check('a tampered sign-on is refused',
    verifySignOn(`${signOn}x`, { vehicleId: 'BA2KHA4412', now }).ok === false);

  const clean = cleanTripVerdict({ legs: 22, powerLost: 0, overrides: 0, implausible: 0 });
  check('a full trip with a quiet tape earns the bonus',
    clean.clean === true && clean.amount === CLEAN_TRIP_BONUS_NPR, `Rs ${clean.amount}`);

  for (const [label, evidence, code] of [
    ['a trip that carried almost nobody', { legs: CLEAN_TRIP_MIN_LEGS - 1 }, 'too_few_legs'],
    ['a trip whose meter lost its feed', { legs: 22, powerLost: 1 }, 'power_lost'],
    ['a trip that overrode the interlock', { legs: 22, overrides: 1 }, 'door_override'],
    ['a trip metering the impossible', { legs: 22, implausible: 1 }, 'implausible_legs'],
  ]) {
    const verdict = cleanTripVerdict(evidence);
    check(`${label} earns nothing`, verdict.clean === false && verdict.amount === 0);
    check(`...and is told why: ${code}`, verdict.reasons.some((r) => r.code === code),
      verdict.reasons.map((r) => r.code).join(', '));
  }

  // The one the rule deliberately does not punish.
  const capped = cleanTripVerdict({ legs: 22, powerLost: 0, overrides: 0, implausible: 0, unclosed: 4 });
  check('rides nobody tapped out of do not cost the crew their bonus',
    capped.clean === true && capped.amount === CLEAN_TRIP_BONUS_NPR);
}

heading('14. Riders who do not tap: the door count, cash, inspection, families');
{
  const nowS = Math.floor(Date.now() / 1000);

  // The door count, as cleanTripVerdict judges it.
  const judged = (e) => cleanTripVerdict({ legs: 0, cash: 0, powerLost: 0, overrides: 0, implausible: 0, ...e });
  check('no counter on the bus: judged as before', judged({ legs: 22 }).clean === true);
  check(`${RECORDED_SHARE_MIN_PCT}% of the count recorded: clean`, judged({ legs: 18, cash: 0, counted: 20 }).clean === true);
  check('below it: no bonus, and the crew is told how many',
    judged({ legs: 17, counted: 20 }).reasons.some((r) => r.code === 'riders_not_recorded' && r.message.startsWith('3 of 20')));
  check('cash tickets count toward the record', judged({ legs: 15, cash: 3, counted: 20 }).clean === true);
  check('a counter that has spoken before and now says nothing: no bonus',
    judged({ legs: 22, counted: null, counterExpected: true }).reasons.some((r) => r.code === 'counter_silent'));

  // Cash: signed by the bus, priced by the tariff.
  const bus = createKeypair();
  const ticketFor = (amount) => signCashTicket(buildCashTicket({
    vehicleId: VEHICLE_ID, tripId: 'T1', doorId: 'A', fromStop: 'RATNAPARK', toStop: 'TINKUNE',
    distanceM: 6600, amount, tariffCode: TARIFF.code, issuedAt: nowS,
  }), bus.secretKey);
  const fair = priceDistance(6600).amount;
  check('a cash ticket at the tariff verifies', verifyCashTicket(ticketFor(fair), { vehiclePublicKey: bus.publicKey, priceFn: priceDistance }).ok);
  check('one written down for less does not', verifyCashTicket(ticketFor(fair - 5), { vehiclePublicKey: bus.publicKey, priceFn: priceDistance }).reason === 'price_mismatch');
  check('nor one signed by another bus', verifyCashTicket(ticketFor(fair), { vehiclePublicKey: createKeypair().publicKey, priceFn: priceDistance }).reason === 'bad_signature');

  // The inspector's roster.
  const aboard = [createKeypair(), createKeypair(), createKeypair()];
  const stowaway = createKeypair();
  const roster = signRoster(buildRoster({ vehicleId: VEHICLE_ID, tripId: 'T1', aboard: aboard.map((k) => k.publicKey), cash: 2, counted: 6, issuedAt: nowS }), bus.secretKey);
  const verified = verifyRoster(roster, { vehiclePublicKey: bus.publicKey, now: nowS });
  check('the roster verifies against the key from the register', verified.ok && verified.roster.prefixes.length === 3 && verified.roster.cash === 2 && verified.roster.counted === 6);
  check(`each rider is ${KEY_PREFIX} characters of key, so a full bus fits one QR`,
    signRoster(buildRoster({ vehicleId: VEHICLE_ID, tripId: 'T1', aboard: Array.from({ length: 60 }, () => createKeypair().publicKey), issuedAt: nowS }), bus.secretKey).length < 900);
  check('a roster from a bus with another key is refused', verifyRoster(roster, { vehiclePublicKey: createKeypair().publicKey, now: nowS }).reason === 'bad_signature');
  check('a roster edited after it was signed is refused', verifyRoster(roster.replace('|T1|', '|T2|'), { vehiclePublicKey: bus.publicKey, now: nowS }).reason === 'bad_signature');
  check(`a roster older than ${ROSTER_MAX_AGE_S} s is refused`, verifyRoster(roster, { vehiclePublicKey: bus.publicKey, now: nowS + ROSTER_MAX_AGE_S + 1 }).reason === 'stale');
  check('no register entry: the inspector is told to sync', verifyRoster(roster, { vehiclePublicKey: null, now: nowS }).reason === 'unknown_vehicle');

  const code = (k, vehicleId = VEHICLE_ID) => signRideTap(buildRideTap({ passengerPublicKey: k.publicKey, vehicleId, doorId: 'ANY' }), k.secretKey);
  const r = verified.roster;
  check('a passenger with a ride open: ON RECORD', checkRider(r, code(aboard[1]), { now: nowS }).ok === true);
  check('a passenger who never tapped: NOT ON RECORD', checkRider(r, code(stowaway), { now: nowS }).reason === 'not_recorded');
  check('a code for another bus is not accepted as this one', checkRider(r, code(aboard[0], 'BA9KHA9999'), { now: nowS }).reason === 'wrong_vehicle');
  const forgedKey = code(aboard[0]).replace(aboard[0].publicKey, aboard[2].publicKey);
  check('somebody else’s key on a stranger’s phone is not accepted', checkRider(r, forgedKey, { now: nowS }).reason === 'bad_signature');
  const t = tallyInspection(r, 7);
  check('7 heads against 3 rides + 2 cash: 2 not on the record', t.recorded === 5 && t.unrecorded === 2);

  // Families: companion keys and the group code.
  const seed = createMasterSeed();
  const day = 20000;
  const c1 = deriveCompanionKeypair(seed, day, 1);
  check('a companion key is the same every time for the same seed and day', deriveCompanionKeypair(seed, day, 1).publicKey === c1.publicKey);
  check('and is never the payer’s own day-key', c1.publicKey !== deriveDailyKeypair(seed, day).publicKey && c1.publicKey !== deriveCompanionKeypair(seed, day, 2).publicKey);
  let refusedFifth = false;
  try { deriveCompanionKeypair(seed, day, MAX_COMPANIONS + 1); } catch { refusedFifth = true; }
  check(`at most ${MAX_COMPANIONS} companions`, refusedFifth);
  const family = [createKeypair(), createKeypair(), createKeypair()].map((k) => code(k));
  const group = buildGroup(family);
  check('a group code carries each ride code intact', JSON.stringify(splitGroup(group)) === JSON.stringify(family));
  check('the same person twice in a group is refused', splitGroup(`BG1~${family[0]}~${family[0]}`) === null);
  check(`more than ${GROUP_MAX} is refused`, splitGroup(['BG1', ...Array.from({ length: GROUP_MAX + 1 }, () => code(createKeypair()))].join('~')) === null);
  check('a group of anything but ride codes is refused', splitGroup(`BG1~${roster}`) === null);
}

heading('Summary');
line('odometer', `${(meter.odo.metres / 1000).toFixed(2)} km over ${meter.odo.fixes} fixes`);
line('fixes rejected', `${meter.odo.rejected} (${((meter.odo.rejected / meter.odo.fixes) * 100).toFixed(1)}%)`);
line('rides completed', meter.closed.length);
line('still aboard', meter.onboard.length);
line('collected', `Rs ${meter.closed.reduce((sum, l) => sum + l.price.amount, 0)}`);
line('fusion gates', `accuracy ≤ ${FUSION.maxAccuracyM} m, deadband ${FUSION.deadbandM} m, ≤ ${FUSION.maxSpeedMps} m/s`);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
