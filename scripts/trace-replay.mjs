// Replay a recorded trace through the meter's odometer and score it against a
// distance that is actually known.
//
// This is how the accuracy claim leaves the simulator. Record a trace on the
// /device console (Distance accuracy -> Start recording), on a real road whose
// length is known by something other than GPS, then:
//
//   npm run trace:replay -- trace.json                    summary only
//   npm run trace:replay -- trace.json --truth 2450       vs a measured total
//   npm run trace:replay -- trace.json --route r11.geojson vs the road's geometry
//
// Known distances worth using, best first: a car or bus trip-meter driven over
// the same path; kilometre stones (enter them as marks while recording); an
// athletics track (400 m a lap in lane 1); the road's own polyline from
// OpenStreetMap, exported as GeoJSON.
//
// No network, no browser. The odometer is the same protocol/meter.mjs the box
// runs, so a trace that scores well here scored well on the bus.
//
//   npm run trace:replay -- --demo sample.json
// writes a simulated R11 trace first, to see what a report looks like.

import { readFileSync, writeFileSync } from 'node:fs';
import { initialOdometer, applyFix, odometerReading, priceDistance, FUSION } from '../protocol/meter.mjs';
import { buildRoad, expandProfile, simulateDrive } from '../src/lib/gnss-sim.js';

const TOLERANCE_PCT = 2;
const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const pad = (label) => `${label}`.padEnd(30, '.');
const line = (label, value) => console.log(`  ${pad(label)} ${value}`);
const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

// ------------------------------------------------------------------ demo trace

if (args[0] === '--demo') {
  const out = args[1] ?? 'bhada-trace-demo.json';
  const R11 = [
    { lat: 27.7045, lon: 85.3145 }, { lat: 27.6975, lon: 85.3230 }, { lat: 27.6928, lon: 85.3222 },
    { lat: 27.6905, lon: 85.3175 }, { lat: 27.6893, lon: 85.3400 }, { lat: 27.6835, lon: 85.3490 },
    { lat: 27.6785, lon: 85.3495 },
  ];
  const road = buildRoad(R11, { wiggleM: 10, wavelengthM: 220 });
  const phases = [{ stopS: 20 }];
  for (let i = 0; i < 14; i += 1) phases.push({ speedMps: 4 + (i % 4) * 2, forS: 40 }, { stopS: 20 + (i % 3) * 10 });
  const drive = simulateDrive(road, expandProfile(phases), { seed: 42 });
  const start = drive.fixes[0].at;
  const marks = [{ at: start, label: 'start', truthM: 0 }];
  for (const i of [300, 600, drive.fixes.length - 1]) {
    marks.push({ at: drive.fixes[i].at, label: `stone ${marks.length}`, truthM: Math.round(drive.chains[i] - drive.chains[0]) });
  }
  const trace = { v: 'bhada-trace/1', startedAt: start, vehicleId: 'DEMO', marks, fixes: drive.fixes.map((f) => ({ ...f, source: 'demo' })) };
  writeFileSync(out, JSON.stringify(trace));
  // The route file a surveyor would supply, from the same geometry.
  const geo = {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: road.points.filter((_, i) => i % 5 === 0).map((p) => {
        const lat = road.origin.lat + p.n / (EARTH_RADIUS_M * DEG);
        const lon = road.origin.lon + p.e / (EARTH_RADIUS_M * DEG * Math.cos(road.origin.lat * DEG));
        return [lon, lat];
      }),
    },
  };
  writeFileSync(out.replace(/\.json$/, '.route.geojson'), JSON.stringify(geo));
  console.log(`\nWrote ${out} (${drive.fixes.length} fixes, ${marks.length} marks) and its route.`);
  console.log(`Replay it: npm run trace:replay -- ${out} --route ${out.replace(/\.json$/, '.route.geojson')}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- load trace

const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--truth' && args[args.indexOf(a) - 1] !== '--route');
if (!file) {
  console.error('Usage: npm run trace:replay -- <trace.json> [--truth <metres>] [--route <route.geojson>]');
  console.error('       npm run trace:replay -- --demo [out.json]');
  process.exit(2);
}

const trace = JSON.parse(readFileSync(file, 'utf8'));
if (trace.v !== 'bhada-trace/1' || !Array.isArray(trace.fixes)) {
  console.error(`${file} is not a Bhada trace (expected v: bhada-trace/1).`);
  process.exit(2);
}
const fixes = [...trace.fixes].sort((a, b) => a.at - b.at);
if (fixes.length < 2) {
  console.error('Trace has fewer than two fixes.');
  process.exit(2);
}

// ------------------------------------------------------------------- replay

let odo = initialOdometer(0);
const reasons = new Map();
const timeline = []; // [at, reading, fix, kept]
for (const fix of fixes) {
  const result = applyFix(odo, fix);
  odo = result.state;
  reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);
  timeline.push({ at: fix.at, reading: odometerReading(odo), fix, kept: result.accepted });
}

function readingAt(at) {
  let lo = 0;
  let hi = timeline.length - 1;
  if (at <= timeline[0].at) return timeline[0].reading;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].at <= at) lo = mid; else hi = mid;
  }
  return timeline[lo].reading;
}

// ------------------------------------------------------------------- report

const durationS = (fixes[fixes.length - 1].at - fixes[0].at) / 1000;
const withDoppler = fixes.filter((f) => Number.isFinite(f.speed)).length;
const accuracies = fixes.map((f) => f.accuracy).filter(Number.isFinite).sort((a, b) => a - b);
const median = accuracies.length ? accuracies[Math.floor(accuracies.length / 2)] : NaN;
let longestGapS = 0;
for (let i = 1; i < fixes.length; i += 1) longestGapS = Math.max(longestGapS, (fixes[i].at - fixes[i - 1].at) / 1000);

console.log(`\nBhada trace replay — ${file}`);
console.log(`Odometer: protocol/meter.mjs, deadband ${FUSION.deadbandM} m, accuracy gate ${FUSION.maxAccuracyM} m\n`);

console.log('Receiver');
line('fixes', `${fixes.length} over ${(durationS / 60).toFixed(1)} min (${(fixes.length / Math.max(1, durationS)).toFixed(2)} Hz)`);
line('Doppler speed reported', `${withDoppler} (${((withDoppler / fixes.length) * 100).toFixed(0)}%) — ${withDoppler / fixes.length > 0.9 ? 'measured grade' : 'conservative grade'}`);
line('median accuracy', Number.isFinite(median) ? `±${median.toFixed(1)} m` : 'not reported');
line('longest gap', `${longestGapS.toFixed(1)} s${longestGapS > FUSION.maxGapS ? ' — counted as unverified' : ''}`);
for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) line(`  ${reason}`, count);

console.log('\nOdometer');
line('metered', `${(odometerReading(odo) / 1000).toFixed(3)} km`);
line('unverified (gaps, relocations)', `${Math.round(odo.unverifiedMetres)} m`);

let failures = 0;
function verdict(label, meteredM, trueM) {
  const error = ((meteredM - trueM) / trueM) * 100;
  const fareTrue = priceDistance(trueM).amount;
  const fareMetered = priceDistance(meteredM).amount;
  const ok = Math.abs(error) <= TOLERANCE_PCT;
  if (!ok) failures += 1;
  line(label, `${(trueM / 1000).toFixed(3)} km true, ${(meteredM / 1000).toFixed(3)} km metered, ${pct(error)}  fare Rs ${fareMetered} vs Rs ${fareTrue}  ${ok ? 'PASS' : 'FAIL'}`);
}

// Marks with known distances: each consecutive pair is a leg with a truth.
const marks = (trace.marks ?? []).filter((m) => Number.isFinite(m.truthM)).sort((a, b) => a.at - b.at);
if (marks.length >= 2) {
  console.log('\nBetween marks with a known distance');
  for (let i = 1; i < marks.length; i += 1) {
    const trueM = marks[i].truthM - marks[i - 1].truthM;
    if (trueM <= 0) continue;
    verdict(`${marks[i - 1].label} → ${marks[i].label}`, readingAt(marks[i].at) - readingAt(marks[i - 1].at), trueM);
  }
}

const truthArg = Number(flag('--truth'));
if (Number.isFinite(truthArg) && truthArg > 0) {
  console.log('\nAgainst the measured total');
  verdict('whole trace', odometerReading(odo), truthArg);
}

// A route polyline: the road's own geometry. Each kept fix is projected onto it
// and the distance between the first and last projections is the truth. The
// cross-track distance is also a direct measure of the receiver's error.
const routeFile = flag('--route');
if (routeFile) {
  const geo = JSON.parse(readFileSync(routeFile, 'utf8'));
  const coords = geo.type === 'FeatureCollection' ? geo.features[0].geometry.coordinates
    : geo.type === 'Feature' ? geo.geometry.coordinates
      : geo.coordinates;
  const origin = { lat: coords[0][1], lon: coords[0][0] };
  const local = ([lon, lat]) => ({
    e: (lon - origin.lon) * EARTH_RADIUS_M * DEG * Math.cos(origin.lat * DEG),
    n: (lat - origin.lat) * EARTH_RADIUS_M * DEG,
  });
  const pts = coords.map(local);
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + Math.hypot(pts[i].e - pts[i - 1].e, pts[i].n - pts[i - 1].n));

  const project = (fix) => {
    const p = local([fix.lon, fix.lat]);
    let best = { d: Infinity, chain: 0 };
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const vx = b.e - a.e;
      const vy = b.n - a.n;
      const len2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((p.e - a.e) * vx + (p.n - a.n) * vy) / len2));
      const d = Math.hypot(a.e + vx * t - p.e, a.n + vy * t - p.n);
      if (d < best.d) best = { d, chain: cum[i] + Math.sqrt(len2) * t };
    }
    return best;
  };

  const kept = timeline.filter((t) => t.kept);
  const cross = kept.map((t) => project(t.fix).d).sort((a, b) => a - b);
  console.log(`\nAgainst the route (${(cum[cum.length - 1] / 1000).toFixed(2)} km of polyline)`);
  line('cross-track error, median', `${cross[Math.floor(cross.length / 2)].toFixed(1)} m`);
  line('cross-track error, 95th pct', `${cross[Math.floor(cross.length * 0.95)].toFixed(1)} m`);
  const first = project(kept[0].fix);
  const last = project(kept[kept.length - 1].fix);
  verdict('first fix → last fix', kept[kept.length - 1].reading - kept[0].reading, Math.abs(last.chain - first.chain));
}

if (marks.length < 2 && !Number.isFinite(truthArg) && !routeFile) {
  console.log('\nNo known distance supplied, so nothing to score against.');
  console.log('Pass --truth <metres>, --route <route.geojson>, or record marks with known distances.');
}

console.log(`\n${failures === 0 ? 'Within tolerance.' : `${failures} comparison(s) outside ±${TOLERANCE_PCT}%.`}\n`);
process.exit(failures === 0 ? 0 : 1);
