// A GNSS receiver on a bus, simulated well enough to be argued with.
//
// The meter's accuracy claim is only as good as the drive it was tested on, and
// a drive that runs straight lines at a constant 40 km/h tests almost nothing: a
// Kathmandu bus crawls, stops for a minute at a junction, lurches forward five
// metres, and follows roads that bend. This module produces that — a road with
// curves, a speed profile with stops, and receiver error that behaves like a
// real chip's rather than like white noise.
//
// Platform-free and seeded, so `npm run proof:meter` gives the same numbers on
// every run and the /device bench drive can use the same generator in a browser.

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

// mulberry32. Small, fast, and deterministic — the proof must not flake.
export function seeded(seed = 1) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand) {
  // Box–Muller. `1 - rand()` keeps log away from zero.
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function offset(origin, eastM, northM) {
  return {
    lat: origin.lat + northM / (EARTH_RADIUS_M * DEG),
    lon: origin.lon + eastM / (EARTH_RADIUS_M * DEG * Math.cos(origin.lat * DEG)),
  };
}

function toLocal(origin, point) {
  return {
    e: (point.lon - origin.lon) * EARTH_RADIUS_M * DEG * Math.cos(origin.lat * DEG),
    n: (point.lat - origin.lat) * EARTH_RADIUS_M * DEG,
  };
}

/*
  A road through the given waypoints, sampled every `stepM` metres, with a
  sideways sinusoid laid over each straight so the road bends the way a real one
  does. The chord a meter measures across a bend is shorter than the bend; a
  test road with no bends hides that error completely.

  Returns dense points with cumulative chainage. Ground truth is the length of
  this polyline, and nothing else.
*/
export function buildRoad(waypoints, { wiggleM = 0, wavelengthM = 250, stepM = 2 } = {}) {
  const origin = waypoints[0];
  const local = waypoints.map((p) => toLocal(origin, p));
  const dense = [];
  for (let i = 0; i < local.length - 1; i += 1) {
    const a = local[i];
    const b = local[i + 1];
    const length = Math.hypot(b.e - a.e, b.n - a.n);
    const ux = (b.e - a.e) / length;
    const uy = (b.n - a.n) / length;
    const steps = Math.max(1, Math.round(length / stepM));
    for (let s = i === 0 ? 0 : 1; s <= steps; s += 1) {
      const t = s / steps;
      // Taper the wiggle to zero at each waypoint so segments join cleanly.
      const lateral = wiggleM * Math.sin(Math.PI * t) * Math.sin((2 * Math.PI * t * length) / wavelengthM);
      dense.push({ e: a.e + ux * length * t - uy * lateral, n: a.n + uy * length * t + ux * lateral });
    }
  }
  const points = [];
  let chain = 0;
  for (let i = 0; i < dense.length; i += 1) {
    if (i > 0) chain += Math.hypot(dense[i].e - dense[i - 1].e, dense[i].n - dense[i - 1].n);
    points.push({ ...dense[i], chainM: chain });
  }
  return { origin, points, lengthM: chain };
}

export function pointAt(road, chainM) {
  const { points } = road;
  const target = Math.max(0, Math.min(chainM, road.lengthM));
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].chainM <= target) lo = mid; else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.chainM - a.chainM || 1;
  const t = (target - a.chainM) / span;
  return { e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t };
}

/*
  A speed profile as phases: { speedMps, forS } cruises (accelerating toward the
  target at a bus's pace), { stopS } holds still. Expanded to one speed per tick.
*/
export function expandProfile(phases, { hz = 1, accelMps2 = 0.9, brakeMps2 = 1.4 } = {}) {
  const dt = 1 / hz;
  const speeds = [];
  let v = 0;
  for (const phase of phases) {
    const target = phase.stopS ? 0 : phase.speedMps;
    const ticks = Math.round((phase.stopS ?? phase.forS) * hz);
    for (let i = 0; i < ticks; i += 1) {
      if (v < target) v = Math.min(target, v + accelMps2 * dt);
      else if (v > target) v = Math.max(target, v - brakeMps2 * dt);
      speeds.push(v);
    }
  }
  return speeds;
}

/*
  Drive the road and report what a phone's receiver would.

  Receiver error has two parts, because that is what real error looks like:
    - a slow wander (first-order Gauss–Markov, σ metres, τ seconds) — multipath
      and atmosphere that drift over tens of seconds rather than jumping
    - a small white jitter on top, fix to fix
  Doppler speed is reported by the chip independently of position and is much
  better: real receivers resolve it to a couple of decimetres per second. Pass
  `doppler: false` to model a receiver or browser that does not expose it.
*/
export function simulateDrive(road, speeds, {
  seed = 7,
  hz = 1,
  startChainM = 0,
  startAt = 1_700_000_000_000,
  wanderM = 2.5,
  wanderTauS = 30,
  whiteM = 0.8,
  accuracyM = 8,
  doppler = true,
  dopplerNoiseMps = 0.15,
} = {}) {
  const rand = seeded(seed);
  const dt = 1 / hz;
  const decay = Math.exp(-dt / wanderTauS);
  const drive = Math.sqrt(1 - decay * decay) * wanderM;
  let we = gaussian(rand) * wanderM;
  let wn = gaussian(rand) * wanderM;
  let chain = startChainM;
  const fixes = [];
  const chains = []; // the true chainage at each fix: ground truth for any leg

  for (let i = 0; i < speeds.length; i += 1) {
    chain += speeds[i] * dt;
    chains.push(Math.min(chain, road.lengthM));
    we = we * decay + gaussian(rand) * drive;
    wn = wn * decay + gaussian(rand) * drive;
    const p = pointAt(road, chain);
    const at = startAt + Math.round((i + 1) * dt * 1000);
    const fix = {
      ...offset(road.origin, p.e + we + gaussian(rand) * whiteM, p.n + wn + gaussian(rand) * whiteM),
      accuracy: Math.max(3, accuracyM + gaussian(rand) * 1.5),
      at,
    };
    if (doppler) fix.speed = Math.max(0, speeds[i] + gaussian(rand) * dopplerNoiseMps);
    fixes.push(fix);
  }
  return { fixes, chains, truthM: Math.min(chain, road.lengthM) - startChainM, endChainM: chain };
}
