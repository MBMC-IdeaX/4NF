// Is this receipt a description of a bus journey, or of a phone in a drawer?
//
// The attack. An operator installs a mock-location app on the meter phone and
// feeds it a fabricated track — a track that covers more ground than the bus
// did, so every passenger aboard is billed for kilometres nobody rode. The
// receipt verifies: it is signed with the vehicle's real key, the arithmetic
// re-prices exactly, and the passenger's tap is genuine. Every check the system
// has says yes, because every check is about consent and arithmetic and none is
// about whether the numbers describe the physical world.
//
// Three things can be checked afterwards, none of them proof on their own and
// all of them cheap:
//
//   1. The ride against the route. A leg whose endpoints are nowhere near the
//      road the permit names is not a ride on that route.
//   2. The distance against the endpoints. The odometer may exceed the straight
//      line — roads bend — but not by an arbitrary factor. A 400 m hop billed
//      as 9 km is a meter reporting something that did not happen.
//   3. The speed the receipt implies. Distance over elapsed time, against what
//      a bus in Kathmandu traffic can actually average.
//
// What this is not: a fraud verdict. Every one of these has an honest cause —
// a diverted route, a bus held at a level crossing, a driver who took the ring
// road. Which is why nothing here refuses a settlement. It scores, and a score
// is something an operator's own dashboard shows before anybody is accused.

import { haversineMetres, CIRCUITY_FACTOR, routeDistanceM, DISTANCE_SOURCE } from './meter.mjs';

/*
  The bounds, and why each is where it is.

  Generous on purpose. A check tuned to catch the marginal case will flag a
  hundred honest rides for every dishonest one, and a flag nobody can act on is
  a flag an operator learns to ignore.
*/
export const PLAUSIBLE = {
  // The worst real circuity on a Kathmandu route: a stretch where the road
  // doubles back and the straight line across it is half the distance driven.
  // CIRCUITY_FACTOR is 1.3 for the typical case; this is the allowance before a
  // ride is worth a second look.
  maxCircuity: 3.0,
  // Below this the straight line is inside the receiver's own noise and the
  // ratio means nothing.
  minLineM: 150,
  // A Kathmandu bus averages 12-18 km/h across a trip and is capable of 60 on
  // the ring road at night. Sustained above this over a whole leg is not a bus.
  maxAverageMps: 22,     // ~79 km/h
  // Under this much elapsed time, the average is dominated by the clock's own
  // granularity.
  minSpanS: 30,
  // How far off the permitted route a leg's endpoints may sit. Wider than the
  // snapping tolerance: this is asking "was this bus on its route at all",
  // not "exactly where on it".
  maxOffRouteM: 400,
};

/*
  Score one settled leg.

  `leg` is the verified BM1. `route` is the vehicle's permitted geometry, or
  null when it is not known — in which case the route check is skipped rather
  than failed, because an unknown route is our gap and not the operator's.

  Returns `{ ok, flags, worst }`. `flags` is what to show a human, in their
  words, and each carries the numbers it was computed from so an operator can
  argue with it.
*/
export function scoreLeg(leg, { route = null } = {}) {
  const flags = [];
  const boardFix = fixOf(leg, 'board');
  const alightFix = fixOf(leg, 'alight');
  const spanS = Number(leg.alightAt) - Number(leg.boardAt);
  const metres = Number(leg.distanceM);

  // An unclosed leg is priced at the cap rather than from its distance, so its
  // distance is not a claim about anything and there is nothing here to check.
  if (leg.distanceSource === DISTANCE_SOURCE.UNCLOSED) return { ok: true, flags: [], worst: null };

  if (boardFix && alightFix) {
    const line = haversineMetres(boardFix, alightFix);
    if (line >= PLAUSIBLE.minLineM) {
      const circuity = metres / line;
      if (circuity > PLAUSIBLE.maxCircuity) {
        flags.push({
          code: 'circuity',
          severity: 'high',
          message: `Billed ${Math.round(metres)} m between points ${Math.round(line)} m apart — ${circuity.toFixed(1)}x the straight line.`,
          value: Number(circuity.toFixed(2)),
          limit: PLAUSIBLE.maxCircuity,
        });
      }
    }

    if (route) {
      const snapped = routeDistanceM(boardFix, alightFix, route, { maxOffsetM: PLAUSIBLE.maxOffRouteM });
      if (!snapped) {
        flags.push({
          code: 'off_route',
          severity: 'medium',
          message: 'Neither end of this ride is near the route on the permit.',
          limit: PLAUSIBLE.maxOffRouteM,
        });
      }
    }
  }

  if (spanS >= PLAUSIBLE.minSpanS) {
    const averageMps = metres / spanS;
    if (averageMps > PLAUSIBLE.maxAverageMps) {
      flags.push({
        code: 'too_fast',
        severity: 'high',
        message: `Averaged ${(averageMps * 3.6).toFixed(0)} km/h over the whole ride.`,
        value: Number(averageMps.toFixed(1)),
        limit: PLAUSIBLE.maxAverageMps,
      });
    }
  } else if (metres > PLAUSIBLE.minLineM && spanS >= 0) {
    // Distance with effectively no time on the clock. Nothing to average, but
    // worth saying: a ride cannot be kilometres long and seconds old.
    flags.push({
      code: 'no_elapsed_time',
      severity: 'high',
      message: `${Math.round(metres)} m billed over ${spanS} s.`,
      value: spanS,
      limit: PLAUSIBLE.minSpanS,
    });
  }

  const worst = flags.some((flag) => flag.severity === 'high') ? 'high'
    : flags.length > 0 ? 'medium' : null;
  return { ok: flags.length === 0, flags, worst };
}

function fixOf(leg, which) {
  const lat = leg[`${which}LatMicro`];
  const lon = leg[`${which}LonMicro`];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat: lat / 1e6, lon: lon / 1e6 };
}

/*
  A whole trip's worth, for an operator's dashboard.

  One implausible leg is a diversion. A trip where most of them trip the same
  flag is a meter, and that is the shape worth surfacing: the rate, not the
  incident.
*/
export function scoreTrip(legs, options = {}) {
  const scored = legs.map((leg) => ({ legId: leg.legId, ...scoreLeg(leg, options) }));
  const flagged = scored.filter((entry) => !entry.ok);
  const counts = {};
  for (const entry of flagged) {
    for (const flag of entry.flags) counts[flag.code] = (counts[flag.code] ?? 0) + 1;
  }
  return {
    legs: scored.length,
    flagged: flagged.length,
    rate: scored.length > 0 ? flagged.length / scored.length : 0,
    counts,
    worst: flagged.some((entry) => entry.worst === 'high') ? 'high' : flagged.length > 0 ? 'medium' : null,
    scored,
  };
}
