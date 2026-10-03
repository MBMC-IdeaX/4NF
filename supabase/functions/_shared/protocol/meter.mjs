// The meter: what the box bolted under the driver's seat actually computes.
//
// Nepal's buses have no fixed stops. People wave one down between junctions and
// step off wherever the traffic stalls, so a fare priced from a stop pair is a
// fare priced from a fiction. This module prices from distance instead, and the
// distance comes from an odometer the vehicle keeps for itself.
//
// Platform-free by the same rule as the rest of protocol/: no browser, no Node,
// no clock of its own. Position fixes and timestamps are handed in. That is what
// lets the same code run on the phone, in the Edge Function that re-prices a
// disputed leg, and in `npm run proof:meter` with a scripted drive.

// ---------------------------------------------------------------- geometry

import { ROUTE_STAGES } from './stages.mjs';

const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius
const DEG = Math.PI / 180;

/*
  Great-circle distance. Haversine rather than the equirectangular shortcut
  because the shortcut's error grows with latitude and nobody wants to explain
  to a regulator why fares in Kathmandu and fares in Dhangadhi round differently.
*/
export function haversineMetres(a, b) {
  if (!a || !b) return 0;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/*
  Road distance is longer than the straight line between two points. The ratio
  is the circuity factor, and for a dense urban grid it sits around 1.3. It is
  only ever used when the odometer could not supply a real figure, and a leg
  priced this way is labelled as such on the receipt — an estimate a passenger
  can see is an estimate they can dispute.
*/
export const CIRCUITY_FACTOR = 1.3;

// ---------------------------------------------------------------- odometer

/*
  Fusion limits. A consumer GNSS chip is a noisy distance sensor: parked at a
  junction it will still wander tens of metres a minute, and under the Koteshwor
  flyover it will jump the bus half a kilometre sideways. Integrating that raw
  would bill a stationary passenger, so every fix passes these gates before its
  distance is allowed to count.
*/
export const FUSION = {
  maxAccuracyM: 35,   // a fix vaguer than this says nothing useful about distance
  // Distance is counted in chords at least this long. Shorter chords sum the
  // receiver's noise into the distance (+3.5% at walking pace with 8 m); longer
  // ones cut corners (-2% on the open road with 20 m). 12 m sits between, and
  // was chosen by sweeping `npm run proof:meter`'s drives, not by feel.
  deadbandM: 12,
  deadbandAccuracyRatio: 0.5, // ...and longer when the fixes are vaguer
  maxSpeedMps: 33,    // 120 km/h. no city bus; a fix this fast is a bad fix
  maxGapS: 45,        // longer than this and the road taken between fixes is a guess
  warmupFixes: 3,     // discard the first fixes: the chip is still settling
  stationaryMps: 0.5, // Doppler speed below this is a bus standing still
  motionWindowS: 10,  // without Doppler, motion is judged over this many seconds
  minTravelMps: 1.0,  // ...and slower than this across the window is wander
  relocateAfter: 3,   // consistent "implausible" fixes in a row are the truth
};

export const FIX_QUALITY = {
  NONE: 'no_fix',
  WARMUP: 'warming_up',
  POOR: 'poor',
  GOOD: 'good',
};

export function initialOdometer(seedMetres = 0) {
  return {
    metres: seedMetres,
    readingM: seedMetres, // what a tap is stamped with; see odometerReading()
    fixes: 0,
    accepted: 0,
    rejected: 0,
    lastFix: null,      // the newest fix believed: where the bus is now
    anchor: null,       // the fix the uncounted distance is measured from
    recent: [],         // the last few seconds of fixes, for judging motion
    pending: null,      // a run of "implausible" fixes that may be the truth
    pendingCount: 0,
    heldMetres: 0,      // travel since the anchor, not yet a whole chord
    lastAcceptedAt: null,
    speedMps: 0,
    moving: false,
    quality: FIX_QUALITY.NONE,
    unverifiedMetres: 0, // distance crossed while the gates were rejecting fixes
  };
}

function point(fix) {
  return { lat: fix.lat, lon: fix.lon, at: fix.at, accuracy: fix.accuracy };
}

// Keep just enough history that the oldest entry is at least the motion window
// old. At 1 Hz that is nine fixes; at 0.2 Hz it is two.
function remember(recent, fix) {
  const next = [...recent, point(fix)];
  const cutoff = fix.at - FUSION.motionWindowS * 1000;
  while (next.length > 2 && next[1].at <= cutoff) next.shift();
  return next.length > 32 ? next.slice(-32) : next;
}

/*
  Is the bus moving? The chip's Doppler speed answers this far better than
  position does — it is measured from the carrier frequency, not differenced
  from two noisy points — so it is used whenever the receiver reports it.
  Without it, motion is displacement across the last several seconds: long
  enough that wander averages out, short enough that a bus pulling away from a
  junction is noticed within a few metres.
*/
function judgeMotion(recent, fix) {
  if (Number.isFinite(fix.speed)) {
    return { moving: fix.speed >= FUSION.stationaryMps, speedMps: fix.speed, doppler: true };
  }
  const oldest = recent[0];
  const spanS = oldest ? (fix.at - oldest.at) / 1000 : 0;
  if (!oldest || spanS <= 0) return { moving: false, speedMps: 0, doppler: false };
  const speedMps = haversineMetres(oldest, fix) / spanS;
  return { moving: speedMps >= FUSION.minTravelMps, speedMps, doppler: false };
}

/*
  Fold one position fix into the odometer.

  Returns a new state rather than mutating: the device console replays the last
  200 of these to draw its trace, and a reducer that mutates makes that a lie.
  `reason` is kept on every rejection because "why did the odometer not move"
  is the first question anyone asks of a meter, and the console answers it.

  Distance is counted in chords from an anchor, and the whole of the accuracy
  claim rests on when the anchor moves:

    - standing still, the anchor follows the fix, so wander never accumulates
      into a step. A parked bus bills nothing however long it waits.
    - moving, the anchor is HELD until the bus is a deadband away, then the
      chord is counted and the anchor jumps to the fix. A bus crawling at 5 km/h
      covers 1.4 m a second — far less than any deadband — and an anchor that
      followed every fix would never see it move at all. That was the bug this
      design replaced: the old odometer read zero below 29 km/h.
*/
export function applyFix(state, fix) {
  const result = fold(state, fix);
  // The reading is a ratchet. Held distance wobbles with receiver noise between
  // fixes, and an odometer seen to run backwards — even by a metre — is one
  // nobody at the door will believe again.
  const live = result.state.metres + (result.state.moving ? result.state.heldMetres || 0 : 0);
  const readingM = Math.max(state.readingM ?? state.metres, live);
  return { ...result, state: { ...result.state, readingM } };
}

function fold(state, fix) {
  const next = { ...state, fixes: state.fixes + 1 };

  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || !Number.isFinite(fix.at)) {
    return { state: { ...next, rejected: state.rejected + 1 }, accepted: false, reason: 'malformed', deltaMetres: 0 };
  }

  const accuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : Infinity;
  if (accuracy > FUSION.maxAccuracyM) {
    return {
      state: { ...next, rejected: state.rejected + 1, quality: FIX_QUALITY.POOR },
      accepted: false,
      reason: 'accuracy',
      deltaMetres: 0,
    };
  }

  // The first fixes anchor the trace without adding distance: the chip is still
  // settling, and with no settled previous point any number would be invented.
  if (!state.lastFix || state.accepted < FUSION.warmupFixes) {
    if (state.lastFix && fix.at <= state.lastFix.at) {
      return { state: { ...next, rejected: state.rejected + 1 }, accepted: false, reason: 'out_of_order', deltaMetres: 0 };
    }
    const accepted = state.accepted + 1;
    return {
      state: {
        ...next,
        lastFix: fix,
        anchor: point(fix),
        recent: remember(state.recent ?? [], fix),
        lastAcceptedAt: fix.at,
        accepted,
        quality: accepted < FUSION.warmupFixes ? FIX_QUALITY.WARMUP : FIX_QUALITY.GOOD,
      },
      accepted: true,
      reason: state.lastFix ? 'warmup' : 'anchor',
      deltaMetres: 0,
    };
  }

  const gapS = (fix.at - state.lastFix.at) / 1000;
  if (gapS <= 0) {
    return { state: { ...next, rejected: state.rejected + 1 }, accepted: false, reason: 'out_of_order', deltaMetres: 0 };
  }

  // Teleport gate. A fix that implies motorway speed on a Kathmandu ring road is
  // multipath off a building, not the bus. It is dropped and the anchor stays
  // where it was, so the bounce back is not a second jump and the real distance
  // is recovered from the next good fix.
  //
  // Unless it keeps happening. Three fixes in a row that agree with each other
  // and not with us mean the receiver was wrong before, not now: re-anchor
  // there, and book the crossing as unverified rather than billing it.
  const jump = haversineMetres(state.lastFix, fix);
  if (jump / gapS > FUSION.maxSpeedMps) {
    const pending = state.pending;
    const consistent = pending && fix.at > pending.at
      && haversineMetres(pending, fix) / ((fix.at - pending.at) / 1000) <= FUSION.maxSpeedMps;
    const count = consistent ? state.pendingCount + 1 : 1;

    if (count >= FUSION.relocateAfter) {
      const anchor = state.anchor ?? state.lastFix;
      return {
        state: {
          ...next,
          lastFix: fix,
          anchor: point(fix),
          recent: [point(fix)],
          pending: null,
          pendingCount: 0,
          lastAcceptedAt: fix.at,
          accepted: state.accepted + 1,
          quality: FIX_QUALITY.POOR,
          unverifiedMetres: state.unverifiedMetres + haversineMetres(anchor, fix),
        },
        accepted: true,
        reason: 'relocated',
        deltaMetres: 0,
      };
    }
    return {
      state: {
        ...next,
        rejected: state.rejected + 1,
        pending: point(fix),
        pendingCount: count,
        quality: FIX_QUALITY.POOR,
      },
      accepted: false,
      reason: 'implausible_speed',
      deltaMetres: 0,
    };
  }

  const recent = remember(state.recent ?? [], fix);
  const motion = judgeMotion(state.recent ?? [], fix);
  const anchor = state.anchor ?? state.lastFix;
  const step = haversineMetres(anchor, fix);
  const deadband = Math.max(
    FUSION.deadbandM,
    FUSION.deadbandAccuracyRatio * Math.max(anchor.accuracy ?? 0, accuracy),
  );
  // A long gap means we do not know the road taken, only the endpoints. Count
  // the straight line — never more — and mark the metres as unverified so the
  // leg receipt can say the odometer was interpolated across that stretch.
  const gapped = gapS > FUSION.maxGapS;
  const base = {
    ...next,
    lastFix: fix,
    recent,
    pending: null,
    pendingCount: 0,
    lastAcceptedAt: fix.at,
    accepted: state.accepted + 1,
  };

  if (step >= deadband && (motion.moving || gapped)) {
    return {
      state: {
        ...base,
        metres: state.metres + step,
        anchor: point(fix),
        speedMps: motion.speedMps,
        moving: true,
        heldMetres: 0,
        dopplerHeldM: 0,
        quality: gapped ? FIX_QUALITY.POOR : FIX_QUALITY.GOOD,
        unverifiedMetres: gapped ? state.unverifiedMetres + step : state.unverifiedMetres,
      },
      accepted: true,
      reason: gapped ? 'gapped' : 'travelled',
      deltaMetres: step,
    };
  }

  // Distance since the anchor by integrating Doppler speed. Over a short span it
  // is a better figure than the chord, which is mostly receiver noise when it is
  // only a few metres long. It is used as a ceiling on the chord, never alone: a
  // receiver that fakes "Doppler" by differencing positions reports speeds that
  // run high, and the ceiling then simply never binds.
  const dopplerHeldM = motion.doppler && state.moving
    ? (state.dopplerHeldM || 0) + ((state.speedMps + motion.speedMps) / 2) * gapS
    : 0;

  if (motion.moving) {
    // Moving, but not yet a deadband from the anchor. Hold it: the distance is
    // not lost, it is counted as soon as it is long enough to be sure of.
    return {
      state: {
        ...base,
        speedMps: motion.speedMps,
        moving: true,
        heldMetres: motion.doppler ? Math.min(step, dopplerHeldM) : 0,
        dopplerHeldM,
        quality: FIX_QUALITY.GOOD,
      },
      accepted: true,
      reason: 'accumulating',
      deltaMetres: 0,
    };
  }

  // The bus has just stopped. Whatever it covered since the last chord is real
  // travel — Doppler says it was moving — so it is counted now rather than
  // dropped. Otherwise every junction stop would forfeit up to a deadband, and a
  // bus that stops forty times a trip would under-read by hundreds of metres.
  // Only with Doppler: position-only motion is judged too loosely to trust a
  // short chord, and there an under-read is the right direction to be wrong.
  const flush = state.moving && motion.doppler ? Math.min(step, dopplerHeldM) : 0;

  // Standing still. The anchor follows the fix so wander never becomes a step.
  // Without Doppler, motion is only noticed a few seconds after the bus pulls
  // away; the anchor is therefore laid at the start of the motion window rather
  // than here, so those first metres are counted when the motion is confirmed —
  // but never earlier than the anchor already is, or metres already counted
  // would be counted again.
  const trailing = recent[0].at > anchor.at ? recent[0] : anchor;
  return {
    state: {
      ...base,
      metres: state.metres + flush,
      anchor: motion.doppler || flush > 0 ? point(fix) : trailing,
      speedMps: 0,
      moving: false,
      heldMetres: 0,
      dopplerHeldM: 0,
      quality: FIX_QUALITY.GOOD,
    },
    accepted: true,
    reason: flush > 0 ? 'stopped' : 'stationary',
    deltaMetres: flush,
  };
}

/*
  The odometer as a reading — the number a tap is stamped with. Distance held
  against the anchor while the bus is moving is real but not yet counted; a tap
  that lands mid-chord would lose it and the next tap would gain it, so the
  reading includes it. Only when Doppler vouches for the motion — otherwise the
  held figure can be wander. Never less than the counted metres, never less
  than it was a fix ago.
*/
export function odometerReading(state) {
  return Math.max(state.metres, state.readingM ?? state.metres);
}

// ---------------------------------------------------------------- tariff

/*
  A telescoping distance tariff, which is what every regulated distance fare in
  the region actually is: a flat boarding charge that buys the first stretch,
  then a per-kilometre rate on whole kilometres above it, then a cap.

    fare = min(cap, boardingCharge + ceil(max(0, km - includedKm) / stepKm) * perStep)

  Whole kilometres rounded up, not fractional rupees, because the number has to
  be arguable at the door of a moving bus by two people with no calculator.

  The promise: no ride between two stages costs more metered than the stage
  table charges for it today. A boarding charge equal to today's minimum and a
  cap equal to today's end-to-end fare are not enough on their own — the first
  tariff (NPR-KTM-2026: Rs 15 bought 2 km) broke the promise on three stage
  pairs, Thapathali to New Baneshwor worst at Rs 18 against Rs 15. Rs 15 now
  buys 3 km, the smallest change that keeps it on every pair, and
  `npm run proof:meter` checks all 21 pairs rather than trusting the argument.
  The old code stays in the tariffs table: a fare is re-priced with the tariff
  it was charged under, so tariffs are added, never edited.
*/
export const TARIFF = {
  code: 'NPR-KTM-2026B',
  boardingCharge: 15,  // NPR, includes the first stretch
  includedKm: 3,
  stepKm: 1,
  perStep: 3,          // NPR per whole kilometre past includedKm
  cap: 25,             // NPR per leg — the current end-to-end stage fare
  unclosedLegFare: 25, // no tap-out: charged as if ridden to the cap
  currency: 'NPR',
};

// Every tariff ever published, by code. A receipt names the tariff it was
// priced under and is re-priced with that one, so a tariff change never turns
// last month's honest receipts into mismatches.
/*
  The stage tariff: how Kathmandu buses are actually priced.

  A fare is set by the regulator as a table of stage-to-stage amounts; Bhada
  does not invent one. GPS finds the stage a passenger boarded at and the
  stage they got off at, and this table gives the fare between them. The
  distance travelled is still measured and printed, as the record of the
  journey, but it does not set the price.

  THIS IS A DEMO FARE TABLE. The amounts follow the same rule as the seeded
  `fares` table (0002_seed.sql) and src/lib/fares.js — Rs 15 for the next
  stage, Rs 5 for each stage after, never more than Rs 25 — and are not a
  published government table. When the real table is loaded it is published
  as a new tariff code; tariffs are added, never edited, so every receipt is
  re-priced with the table it names.
*/
function stageFareTable(stages, { first, perStage, cap }) {
  const table = {};
  for (let a = 0; a < stages.length; a += 1) {
    for (let b = 0; b < stages.length; b += 1) {
      const gap = Math.abs(b - a);
      table[`${stages[a].code}|${stages[b].code}`] = gap === 0 ? first : Math.min(cap, first + (gap - 1) * perStage);
    }
  }
  return table;
}

export const STAGE_TARIFF = {
  code: 'R11-STAGE-DEMO-1',
  kind: 'stage',
  demo: true,
  routeId: 'R11',
  stages: ROUTE_STAGES.R11,
  fares: stageFareTable(ROUTE_STAGES.R11, { first: 15, perStage: 5, cap: 25 }),
  // Kept so the fields every tariff carries still mean something: the lowest
  // fare, the highest, and what a ride nobody closed is charged.
  boardingCharge: 15,
  includedKm: 0,
  stepKm: 1,
  perStep: 0,
  cap: 25,
  unclosedLegFare: 25,
  currency: 'NPR',
};

// The tariff new rides are priced under. Distance tariffs stay published so
// older receipts still re-price.
export const CURRENT_TARIFF = STAGE_TARIFF;

export const TARIFFS = {
  'NPR-KTM-2026': { ...TARIFF, code: 'NPR-KTM-2026', includedKm: 2 },
  [TARIFF.code]: TARIFF,
  [STAGE_TARIFF.code]: STAGE_TARIFF,
};

/*
  The stage a point is nearest, on a stage tariff's route. A bus at a stop is
  at that stage; a bus between two is nearer one of them, which is the stage a
  conductor would name too.
*/
export function stageNear(tariff, point, { maxM = 1500 } = {}) {
  const stages = tariff?.stages;
  if (!stages?.length || !point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  if (point.lat === 0 && point.lon === 0) return null;
  let best = null;
  for (const stage of stages) {
    const d = haversineMetres(point, stage);
    if (!best || d < best.d) best = { d, stage };
  }
  // Off the route altogether: no stage, and the ride is priced by distance.
  return best.d <= maxM ? best.stage.code : null;
}

/*
  The exit stage when the door has no fix at the moment of getting off: the
  stage that sits the measured distance along the route from the boarding
  stage. If both directions fit inside the route the answer is ambiguous and
  this returns null, and the ride is priced by the distance tariff instead.
*/
export function stageAlong(tariff, fromCode, metres) {
  const stages = tariff?.stages;
  const from = stages?.find((s) => s.code === fromCode);
  if (!from || !Number.isFinite(metres)) return null;
  const last = stages[stages.length - 1].chainM;
  const nearestTo = (chain) => stages.reduce((best, s) => (Math.abs(s.chainM - chain) < Math.abs(best.chainM - chain) ? s : best)).code;
  const ahead = from.chainM + metres;
  const behind = from.chainM - metres;
  const aheadFits = ahead <= last + 300;
  const behindFits = behind >= -300;
  if (aheadFits && behindFits && metres > 300) return null;
  if (aheadFits) return nearestTo(Math.min(ahead, last));
  if (behindFits) return nearestTo(Math.max(behind, 0));
  return null;
}

export function stageName(tariff, code) {
  return tariff?.stages?.find((s) => s.code === code) ?? null;
}

function priceStages(metres, { concession, tariff, boardStage, alightStage }) {
  const base = tariff.fares[`${boardStage}|${alightStage}`];
  if (!Number.isFinite(base)) {
    return { amount: NaN, tariffCode: tariff.code, unknownStage: true, breakdown: [] };
  }
  const rate = CONCESSION_RATE[concession] ?? 1;
  const amount = Math.ceil(base * rate);
  const order = (code) => tariff.stages.findIndex((s) => s.code === code) + 1;
  const from = stageName(tariff, boardStage);
  const to = stageName(tariff, alightStage);
  const safeMetres = Math.max(0, Number(metres) || 0);
  return {
    basis: 'stage',
    metres: Math.round(safeMetres),
    km: Number((safeMetres / 1000).toFixed(3)),
    boardStage,
    alightStage,
    fareRule: `Stage ${order(boardStage)} → Stage ${order(alightStage)}`,
    base,
    capped: false,
    concession,
    rate,
    discounted: rate < 1,
    amount,
    currency: tariff.currency,
    tariffCode: tariff.code,
    demo: Boolean(tariff.demo),
    breakdown: [
      { label: `${from?.en ?? boardStage} → ${to?.en ?? alightStage} (stage ${order(boardStage)} → ${order(alightStage)})`, value: base },
      ...(rate < 1 ? [{ label: `${concession} concession ×${rate}`, value: amount - base }] : []),
    ],
  };
}

export const CONCESSION_RATE = { none: 1, student: 0.5, senior: 0.5, staff: 0 };

/*
  Price one leg.

  Returns the arithmetic, not just the answer. The device console prints these
  lines verbatim and so does the passenger receipt, which means a dispute is
  settled by reading rather than by trusting.
*/
export function priceDistance(metres, { concession = 'none', tariff: given, tariffCode, unclosed = false, boardStage, alightStage } = {}) {
  const tariff = given ?? (tariffCode ? TARIFFS[tariffCode] : TARIFF);
  if (!tariff) {
    // A code nobody published. Priced as nothing, so no receipt under it can
    // ever reproduce and the backend refuses it rather than guessing.
    return { amount: NaN, tariffCode, unknownTariff: true, breakdown: [] };
  }
  if (unclosed) return priceUnclosed(metres, { concession, tariff });
  // A stage tariff prices the two stages, never the kilometres. Without both
  // stages there is nothing to price, and a receipt that names a stage tariff
  // but carries no stages cannot reproduce.
  if (tariff.kind === 'stage') {
    if (!boardStage || !alightStage) return { amount: NaN, tariffCode: tariff.code, missingStages: true, breakdown: [] };
    return priceStages(metres, { concession, tariff, boardStage, alightStage });
  }
  const safeMetres = Math.max(0, Number(metres) || 0);
  const km = safeMetres / 1000;
  const chargeableKm = Math.max(0, km - tariff.includedKm);
  const steps = Math.ceil(chargeableKm / tariff.stepKm - 1e-9); // 2.000001 km is 2 km
  const uncapped = tariff.boardingCharge + steps * tariff.perStep;
  const base = Math.min(tariff.cap, uncapped);
  const rate = CONCESSION_RATE[concession] ?? 1;
  const amount = Math.ceil(base * rate);

  return {
    metres: Math.round(safeMetres),
    km: Number(km.toFixed(3)),
    includedKm: tariff.includedKm,
    steps,
    base,
    capped: uncapped > tariff.cap,
    concession,
    rate,
    discounted: rate < 1,
    amount,
    currency: tariff.currency,
    tariffCode: tariff.code,
    breakdown: [
      { label: `Boarding charge (first ${tariff.includedKm} km)`, value: tariff.boardingCharge },
      // A ride inside the first stretch has no per-kilometre line: "0 × 1 km @ 3"
      // on a receipt reads like a charge, and it is not one.
      ...(steps > 0 ? [{ label: `${steps} × ${tariff.stepKm} km @ ${tariff.perStep}`, value: steps * tariff.perStep }] : []),
      ...(uncapped > tariff.cap ? [{ label: `Capped at ${tariff.cap}`, value: tariff.cap - uncapped }] : []),
      ...(rate < 1 ? [{ label: `${concession} concession ×${rate}`, value: amount - base }] : []),
    ],
  };
}

/*
  A ride nobody closed. Charged the cap, because an unclosed leg must never be
  cheaper than a closed one or tapping out becomes optional — but the cap at the
  passenger's own concession, because the most a student can pay for any closed
  ride is half of it. Priced by rule, not by distance: the recorded distance is
  kept on the receipt for the record, and the receipt says `unclosed` so the
  backend re-prices it by this rule rather than refusing it for not matching
  the distance tariff.
*/
function priceUnclosed(metres, { concession, tariff }) {
  const rate = CONCESSION_RATE[concession] ?? 1;
  const amount = Math.ceil(tariff.unclosedLegFare * rate);
  return {
    metres: Math.round(Math.max(0, Number(metres) || 0)),
    km: Number((Math.max(0, Number(metres) || 0) / 1000).toFixed(3)),
    includedKm: tariff.includedKm,
    steps: 0,
    base: tariff.unclosedLegFare,
    capped: true,
    unclosed: true,
    concession,
    rate,
    discounted: rate < 1,
    amount,
    currency: tariff.currency,
    tariffCode: tariff.code,
    breakdown: [
      { label: 'No tap-out: charged at the route cap', value: tariff.unclosedLegFare },
      ...(rate < 1 ? [{ label: `${concession} concession ×${rate}`, value: amount - tariff.unclosedLegFare }] : []),
    ],
  };
}

/*
  Which measurement a leg was priced from, best first.

  odometer  — the meter integrated real fixes across the whole ride. Billable.
  gps       — endpoints only, scaled by the circuity factor. Estimated.
  stage     — neither was available, so the old stop-pair table priced it.

  The order matters more than the values: the meter always prefers the
  measurement it can defend, and records which one it used.
*/
export const DISTANCE_SOURCE = {
  ODOMETER: 'odometer',
  ROUTE: 'route',
  GPS: 'gps',
  STAGE: 'stage',
  UNCLOSED: 'unclosed',
};

/*
  The road, when the receiver cannot describe it.

  A bus under the Baneshwor flyover or in the lanes at Ason loses its fixes to
  multipath for a minute at a time, and the odometer stops with them. What was
  left was the straight line between the endpoints times 1.3 — a guess that is
  wrong in both directions at once: too short across a tortuous heritage lane,
  too long on a stretch that happens to run straight.

  But the bus was not driving an unknown road. It was driving its route, and the
  route's geometry is a published fact: each point carries its running road
  chainage from the first stop, measured along the road rather than across it.
  So a fix is not converted into a distance at all — it is placed on the route,
  and the distance is the difference between two chainages. That is the road's
  own length, not an estimate of it.

  `route` is an array of `{ lat, lon, chainM }` in running order, handed in like
  everything else here. Nothing in this file knows which route it is.
*/

// How far off the line a fix may sit and still be placed on it. Wide enough for
// multipath in a canyon and a route drawn down the centreline of a road that has
// two carriageways; tight enough that a bus on a different street does not snap.
export const ROUTE_SNAP_MAX_OFFSET_M = 120;

/*
  Place one fix on the route.

  Returns the chainage of the closest point on the polyline and how far the fix
  sits off it, or null for a route too short to have a segment. The projection is
  done in local metres — at these latitudes a degree of longitude is a fixed
  scale factor of a degree of latitude, and over a segment of a few hundred
  metres treating that as flat costs far less than the fix's own accuracy.
*/
export function snapToRoute(fix, route) {
  if (!fix || !Array.isArray(route) || route.length < 2) return null;
  const latScale = Math.cos(fix.lat * DEG);
  const toLocal = (p) => ({ x: (p.lon - fix.lon) * latScale, y: p.lat - fix.lat });

  let best = null;
  for (let i = 0; i < route.length - 1; i += 1) {
    const a = route[i];
    const b = route[i + 1];
    const pa = toLocal(a);
    const pb = toLocal(b);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const lenSq = dx * dx + dy * dy;
    // A repeated point carries no direction; the next segment will cover it.
    if (lenSq === 0) continue;
    // The fix is at the local origin, so projecting it onto the segment is the
    // dot product of (origin - a) with the segment, clamped to the segment.
    let t = -(pa.x * dx + pa.y * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const foot = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    const offsetM = haversineMetres(fix, foot);
    if (best === null || offsetM < best.offsetM) {
      // Chainage is interpolated along the segment's own road length, which is
      // what makes this a road distance rather than a straight-line one: a
      // segment whose road runs 1500 m between endpoints 1200 m apart hands back
      // road metres at every point along it.
      const chainM = a.chainM + (b.chainM - a.chainM) * t;
      best = { chainM, offsetM, segment: i, t };
    }
  }
  return best;
}

/*
  Road distance between two fixes, along the route both sit on.

  Null unless both fixes place within `maxOffsetM`: a bus that left its route, or
  a fix thrown far enough by multipath that it no longer says where the bus was,
  must fall through to the older estimate rather than be snapped to a road it was
  not on.
*/
export function routeDistanceM(boardFix, alightFix, route, { maxOffsetM = ROUTE_SNAP_MAX_OFFSET_M } = {}) {
  const from = snapToRoute(boardFix, route);
  const to = snapToRoute(alightFix, route);
  if (!from || !to) return null;
  if (from.offsetM > maxOffsetM || to.offsetM > maxOffsetM) return null;
  return {
    metres: Math.abs(to.chainM - from.chainM),
    boardChainM: from.chainM,
    alightChainM: to.chainM,
    offsetM: Math.max(from.offsetM, to.offsetM),
  };
}


// Below this, an odometer delta is indistinguishable from a meter that sat still.
export const ODO_CREDIBLE_M = 50;

/*
  The one subtle rule in the whole module.

  The odometer is authoritative when the meter travelled the ride. It is not
  authoritative when it did not. Those come apart in exactly one situation, and
  it is a situation that happens: the endpoints moved but the box did not — a
  bench test, a spare unit on a desk, or a stalled odometer input on a bus that
  is very much still driving.

  So: trust the odometer when it actually turned. When it reads flat but the two
  position fixes are hundreds of metres apart, the box is telling us about
  itself, not about the ride, and the endpoints are the better evidence. The
  chosen source is written onto the receipt either way, so nobody has to guess
  afterwards which rule fired.
*/
export function resolveDistance({ boardOdoM, alightOdoM, boardFix, alightFix, stageMetres, route }) {
  const odoDelta = Number(alightOdoM) - Number(boardOdoM);
  const odoUsable = Number.isFinite(odoDelta) && odoDelta >= 0;
  const line = boardFix && alightFix ? haversineMetres(boardFix, alightFix) : null;
  const roadFromFixes = line === null ? null : line * CIRCUITY_FACTOR;
  const snapped = boardFix && alightFix && route ? routeDistanceM(boardFix, alightFix, route) : null;

  const odoStalled = odoUsable && odoDelta < ODO_CREDIBLE_M
    && roadFromFixes !== null && roadFromFixes >= ODO_CREDIBLE_M;

  if (odoUsable && !odoStalled) {
    return { metres: odoDelta, source: DISTANCE_SOURCE.ODOMETER, estimated: false, line };
  }
  // The route beats the circuity factor whenever both endpoints sit on it,
  // because it is the road's measured length rather than a guess at the ratio
  // between a road and the line across it.
  if (snapped) {
    return {
      metres: snapped.metres,
      source: DISTANCE_SOURCE.ROUTE,
      estimated: true,
      line,
      offsetM: snapped.offsetM,
      note: odoStalled ? 'odometer flat; measured along the route' : 'no odometer reading; measured along the route',
    };
  }
  if (roadFromFixes !== null) {
    return {
      metres: roadFromFixes,
      source: DISTANCE_SOURCE.GPS,
      estimated: true,
      line,
      note: odoStalled ? 'odometer flat while endpoints moved' : 'no odometer reading',
    };
  }
  if (Number.isFinite(stageMetres)) {
    return { metres: stageMetres, source: DISTANCE_SOURCE.STAGE, estimated: true, line };
  }
  return { metres: 0, source: DISTANCE_SOURCE.STAGE, estimated: true, line };
}

// ------------------------------------------------------- occupancy and doors

/*
  The second thing the box is for.

  Overloading is not a billing problem, it is the reason people die on Nepali
  roads. The meter already knows exactly how many people are aboard, because it
  counted every tap. Wiring that count to the boarding door's interlock turns a
  fare computer into a load limiter at no extra hardware cost — which is the
  whole argument for putting the two in one box.

  Safety rules that are not negotiable and are therefore encoded here rather
  than left to the UI:
    - the alighting door is NEVER held shut by occupancy. A full bus is exactly
      when people most need to get out.
    - no door opens above walking pace.
    - an override always opens, and always writes an audit event.
*/
// Most buses in Nepal have one door, and it is both the way in and the way
// out: BOTH. A second, rear door on the large buses is ALIGHTING, and the front
// one of those is BOARDING.
export const DOOR_ROLE = { BOTH: 'both', BOARDING: 'boarding', ALIGHTING: 'alighting' };
export const DOOR_STATE = { CLOSED: 'closed', OPEN: 'open', LOCKED: 'locked', OVERRIDE: 'override' };

export const CREEP_SPEED_MPS = 0.8; // walking pace; above this the bus is moving

export function occupancyState({ onboard, capacity }) {
  const seats = Math.max(0, capacity - onboard);
  const load = capacity > 0 ? onboard / capacity : 0;
  return {
    onboard,
    capacity,
    seatsLeft: seats,
    load,
    atCapacity: onboard >= capacity,
    // 90% is where a conductor should stop waving people on, not where the
    // door slams. Warning early is what keeps the interlock from surprising anyone.
    nearCapacity: load >= 0.9 && onboard < capacity,
  };
}

export function doorDecision({ role, onboard, capacity, speedMps = 0, override = false }) {
  const occupancy = occupancyState({ onboard, capacity });

  if (override) {
    return { open: true, state: DOOR_STATE.OVERRIDE, reason: 'manual_override', audit: true, occupancy };
  }
  if (speedMps > CREEP_SPEED_MPS) {
    return { open: false, state: DOOR_STATE.LOCKED, reason: 'in_motion', audit: false, occupancy };
  }
  if (role === DOOR_ROLE.BOARDING && occupancy.atCapacity) {
    return { open: false, state: DOOR_STATE.LOCKED, reason: 'at_capacity', audit: true, occupancy };
  }
  // The only door is also the only way out. A full bus refuses the next tap-in
  // (admitDecision) but never locks this door: locking it would lock people in.
  if (role === DOOR_ROLE.BOTH && occupancy.atCapacity) {
    return { open: true, state: DOOR_STATE.OPEN, reason: 'exit_only', audit: true, occupancy };
  }
  return { open: true, state: DOOR_STATE.OPEN, reason: 'clear', audit: false, occupancy };
}

/*
  Whether one more tap-in may be accepted. Separate from the door because the
  two fail differently: a door can be forced by a person, a tap cannot, and the
  meter must refuse to open a leg it is not allowed to bill for.
*/
export function admitDecision({ onboard, capacity, override = false }) {
  const occupancy = occupancyState({ onboard, capacity });
  if (occupancy.atCapacity && !override) {
    return {
      admitted: false,
      reason: 'at_capacity',
      message: `Bus is full — ${onboard} of ${capacity}. Next bus, please.`,
      occupancy,
    };
  }
  return { admitted: true, reason: override ? 'override' : 'clear', occupancy };
}
