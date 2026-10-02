// The box. Everything the on-vehicle unit does, in one place.
//
// This is the runtime around protocol/meter.mjs: the part that owns a clock, a
// GNSS receiver, a disk and a radio, none of which the protocol is allowed to
// know about. Split that way because the arithmetic has to be re-runnable by the
// backend and by a proof script, and neither of those has a bus.
//
// The unit is a state machine with one job per second:
//   read a fix -> fold it into the odometer -> re-evaluate the doors ->
//   emit a 32-byte frame -> tell anyone listening.
//
// It survives power loss. A bus cuts the ignition at every terminus; an odometer
// that resets on restart is a fare system that undercharges every second trip,
// so the reading, the trip and the open legs are written through to IndexedDB.

import { db } from '../storage/db';
import { installRandomSource } from './identity';
import { openLink, LINK } from './link';
import {
  initialOdometer, applyFix, odometerReading, doorDecision, occupancyState, priceDistance,
  TARIFF, DOOR_ROLE, DOOR_STATE, FIX_QUALITY, haversineMetres, CREEP_SPEED_MPS,
} from '../../protocol/meter.mjs';
import { buildLeg, signLeg, toMicro, PASS_MAX_AGE_S } from '../../protocol/leg.mjs';
import { encodeFrame, decodeFrame, FLAG, frameToHex } from '../../protocol/frame.mjs';
import { createKeypair } from '../../protocol/token.mjs';
import { buildRoster, signRoster } from '../../protocol/inspect.mjs';
import { verifySignOn, assessPower } from '../../protocol/crew.mjs';
import { STOPS, ROUTE_LENGTH_M } from '../lib/nepali';
import { buildRoad, expandProfile, simulateDrive, seeded } from '../lib/gnss-sim';
import { fixFromPosition, holdScreenOn, watchPower, createRecorder } from './positioning';
import { DEFAULT_VEHICLE, loadVehicle } from './fleet';

/*
  The vehicle this unit is bolted into.

  Provisioned per device rather than compiled in: an operator with eleven buses
  on R11 cannot ship eleven builds, and a phone moved to another vehicle in the
  morning must not keep signing for the one it left. `VEHICLE` stays exported as
  the default a fresh install starts from; what the box actually runs as is
  whatever `loadVehicle()` hands back at boot, and that is what every signature
  names.

  Capacity is the legal figure from the vehicle's route permit — seated plus
  standing — and it is the number the door interlock enforces. Nothing in the
  code assumes this value; changing it changes when the door locks.
*/
export const VEHICLE = DEFAULT_VEHICLE;

export const DOORS = {
  // A Nepali bus has one door, in and out. B is the rear door the large
  // buses have; a one-door bus simply never pairs a terminal to it.
  A: { id: 'A', role: DOOR_ROLE.BOTH, ne: 'ढोका', en: 'The door — in and out' },
  B: { id: 'B', role: DOOR_ROLE.ALIGHTING, ne: 'पछाडि', en: 'Rear door — large buses only' },
};

const TICK_MS = 1000;
const EVENT_LIMIT = 250;
const TRACE_LIMIT = 240;

// A simulated drive is not a cheat, it is the bench harness. Bringing a bus to a
// pitch is not an option and a GPS fix indoors is not either, so the unit can be
// driven from a script that follows the real corridor the way Kathmandu traffic
// does — crawling, stopping at junctions, lurching forward — with a receiver
// that wanders like a real one. Because the script knows the true distance, the
// console can show the meter's error against it live, which is the only honest
// way to demonstrate an accuracy claim in a room with no bus in it.
export function benchLeg(forward, seed) {
  const waypoints = STOPS.map((s) => ({ lat: s.lat, lon: s.lon }));
  const road = buildRoad(forward ? waypoints : [...waypoints].reverse(), { wiggleM: 10, wavelengthM: 220 });
  const rand = seeded(seed);
  const phases = [{ stopS: 8 }];
  let planned = 0;
  while (planned < road.lengthM) {
    const cruise = 3 + rand() * 8;             // 11–40 km/h
    const forS = 15 + Math.round(rand() * 40);
    phases.push({ speedMps: cruise, forS });
    phases.push({ stopS: 6 + Math.round(rand() * 30) });
    if (rand() < 0.35) phases.push({ speedMps: 1.2 + rand(), forS: 6 }, { stopS: 10 }); // the jam lurch
    planned += cruise * forS * 0.9;
  }
  return simulateDrive(road, expandProfile(phases), { seed, doppler: true });
}

let instance = null;

export function meter() {
  if (!instance) instance = createMeter();
  return instance;
}

function nowS() {
  return Math.floor(Date.now() / 1000);
}

function newId(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function createMeter() {
  const subscribers = new Set();
  let link = null;
  let ticker = null;
  let watchId = null;
  let simTimer = null;
  let releaseScreen = () => {};
  let releasePower = () => {};
  let bench = null; // { drive, index, forward, seed, lastChain }
  const recorder = createRecorder();

  const state = {
    booted: false,
    bootedAt: Date.now(),
    vehicle: DEFAULT_VEHICLE,
    vehicleId: DEFAULT_VEHICLE.id,
    vehicleKeys: null,
    tripId: null,
    capacity: DEFAULT_VEHICLE.capacity,
    odo: initialOdometer(0),
    fix: null,
    trace: [],          // recent accepted fixes, for the console's route trace
    onboard: [],        // open legs. the roster, the count and the interlock input
    closed: [],         // legs completed this trip, newest first
    registry: new Map(),// every passenger this unit has ever seen
    doors: {
      A: { ...DOORS.A, state: DOOR_STATE.CLOSED, reason: 'boot', commanded: false },
      B: { ...DOORS.B, state: DOOR_STATE.CLOSED, reason: 'boot', commanded: false },
    },
    override: false,
    tamper: false,
    events: [],
    frame: null,
    frameHex: '',
    accrued: 0,
    link: LINK.DETACHED,
    simulating: false,
    benchTruthM: 0,     // what the bench drive actually covered, for comparison
    benchOdoM: 0,       // ...and what the odometer made of it
    doppler: null,      // whether the receiver is reporting Doppler speed
    screenHeld: false,
    // What the Battery Status API will admit to. `sinking` is a charger losing
    // ground to the load, which under a bus seat means heat.
    power: { supported: false, charging: null, level: null, sinking: false },
    // Who is working this shift, and therefore who the clean-trip bonus belongs
    // to. A crew member holds an ordinary wallet and signs on with a CR1; the
    // sign-on outlives the trip because a conductor works a shift of them.
    crew: null,        // { publicKey, signOn, signedOnAt, trips: [] }
    powerLostAt: null, // when the charger went away, before the grace period is up
    powerPulled: false,// ...and whether that has been called a tamper yet
    lastMovedAt: null,
    // Bodies the door counter saw board this trip. null until the counter has
    // spoken, so a bus without one is not mistaken for a bus nobody boarded.
    counted: null,
    cash: { tickets: 0, npr: 0 }, // fares taken in cash this trip (CT1)
    queued: 0,          // legs not yet uploaded
    tick: 0,
  };

  function publish() {
    const snap = snapshot();
    for (const fn of subscribers) fn(snap);
  }

  function snapshot() {
    const occupancy = occupancyState({ onboard: state.onboard.length, capacity: state.capacity });
    return {
      booted: state.booted,
      vehicle: state.vehicle,
      vehicleId: state.vehicleId,
      vehiclePublicKey: state.vehicleKeys?.publicKey ?? null,
      tripId: state.tripId,
      uptimeS: Math.floor((Date.now() - state.bootedAt) / 1000),
      odometerM: reading(),
      odo: state.odo,
      fix: state.fix,
      trace: state.trace,
      speedKmh: Number((state.odo.speedMps * 3.6).toFixed(1)),
      moving: state.odo.moving,
      quality: state.odo.quality,
      occupancy,
      capacity: state.capacity,
      onboard: state.onboard,
      closed: state.closed,
      registry: [...state.registry.values()],
      doors: state.doors,
      override: state.override,
      tamper: state.tamper,
      events: state.events,
      frameHex: state.frameHex,
      frameBytes: state.frame,
      accrued: state.accrued,
      crew: state.crew,
      powerPulled: state.powerPulled,
      link: state.link,
      simulating: state.simulating,
      bench: state.benchTruthM > 0
        ? { truthM: state.benchTruthM, meteredM: state.benchOdoM, errorPct: ((state.benchOdoM - state.benchTruthM) / state.benchTruthM) * 100 }
        : null,
      doppler: state.doppler,
      screenHeld: state.screenHeld,
      power: state.power,
      recording: recorder.recording,
      recordedFixes: recorder.count,
      marks: recorder.marks,
      queued: state.queued,
      counted: state.counted,
      cash: state.cash,
      tariff: TARIFF,
      chainagePct: chainagePct(),
      tick: state.tick,
    };
  }

  // The number every tap is stamped with: counted metres plus the distance held
  // mid-chord, as a ratchet. See odometerReading() in protocol/meter.mjs.
  function reading() {
    return Math.round(odometerReading(state.odo));
  }

  function chainagePct() {
    if (!state.fix) return 0;
    // Nearest stage, not map-matched. Enough to place a marker on a schematic.
    let best = null;
    for (const s of STOPS) {
      const d = haversineMetres({ lat: s.lat, lon: s.lon }, state.fix);
      if (!best || d < best.d) best = { d, s };
    }
    return best ? best.s.chainM / ROUTE_LENGTH_M : 0;
  }

  function log(kind, text, extra = {}) {
    const event = { seq: state.events.length + 1, at: Date.now(), kind, text, ...extra };
    state.events = [event, ...state.events].slice(0, EVENT_LIMIT);
    // Fire and forget: the tape is evidence, but a slow disk must never hold up
    // a door decision.
    db().then((database) => database.add('deviceEvents', {
      at: event.at, kind, text, tripId: state.tripId, ...extra,
    })).catch(() => {});
    return event;
  }

  // ------------------------------------------------------------- persistence

  async function persistOdometer() {
    const database = await db();
    await database.put('meter', {
      metres: state.odo.metres,
      unverifiedMetres: state.odo.unverifiedMetres,
      at: Date.now(),
    }, 'odometer');
  }

  async function persistLeg(leg) {
    const database = await db();
    await database.put('legs', leg);
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    if (state.booted) return snapshot();
    installRandomSource();
    // Before any key is used or any frame is sent: which bus is this.
    state.vehicle = await loadVehicle();
    state.vehicleId = state.vehicle.id;
    state.capacity = state.vehicle.capacity;
    const database = await db();

    // Vehicle key. Generated once, on first power-up, and never leaves the box.
    // It is what makes a leg receipt attributable to this vehicle rather than to
    // anyone who can post JSON at the backend.
    let keys = await database.get('meter', 'vehicleKeys');
    if (!keys) {
      keys = createKeypair();
      await database.put('meter', keys, 'vehicleKeys');
    }
    state.vehicleKeys = keys;

    const saved = await database.get('meter', 'odometer');
    state.odo = initialOdometer(saved?.metres ?? 0);
    state.odo.unverifiedMetres = saved?.unverifiedMetres ?? 0;

    state.tripId = (await database.get('meter', 'tripId')) ?? null;
    state.counted = state.tripId ? (await database.get('meter', `counted:${state.tripId}`)) ?? null : null;
    // A bus cuts the ignition at every terminus and the crew does not sign on
    // again each time, so the shift survives the restart with the odometer.
    const savedCrew = await database.get('meter', 'crew');
    state.crew = savedCrew ? { ...savedCrew, trips: savedCrew.trips ?? [] } : null;
    if (!state.tripId) {
      state.tripId = newId('T');
      await database.put('meter', state.tripId, 'tripId');
    }
    if (state.crew) await noteCrewTrip(state.tripId);

    const legs = await database.getAll('legs');
    state.onboard = legs.filter((l) => l.status === 'open');
    state.closed = legs
      .filter((l) => l.status === 'closed' && l.tripId === state.tripId)
      .sort((a, b) => b.alightAt - a.alightAt);
    state.accrued = state.closed.reduce((sum, l) => sum + l.amount, 0);
    state.queued = legs.filter((l) => l.status === 'closed' && !l.synced).length;

    const savedRegistry = (await database.get('meter', 'registry')) ?? [];
    for (const entry of savedRegistry) state.registry.set(entry.publicKey, entry);

    link = openLink(state.vehicleId, onLinkMessage, { unitId: `M${state.vehicleId}` });
    state.link = link.state();

    startPositioning();
    // The screen is held only while the box is not cooking. `state.power.sinking`
    // is a charger losing ground to the load, which on a phone bolted under a
    // seat is heat; letting the display go dark then is the one lever a browser
    // has over it, and it costs less than the throttled receiver it prevents.
    releaseScreen = holdScreenOn((held) => { state.screenHeld = held; }, { hold: () => !state.power.sinking });
    releasePower = watchPower((power) => {
      const wasSinking = state.power.sinking;
      state.power = power;
      if (power.sinking !== wasSinking) {
        log(power.sinking ? 'alarm' : 'boot', power.sinking
          ? 'Charger is losing ground — the box is hot. Screen released; the receiver keeps running.'
          : 'Charge recovered. Screen held again.');
        releaseScreen.reconsider?.();
      }
      evaluatePower();
      publish();
    });
    ticker = setInterval(tick, TICK_MS);

    state.booted = true;
    log('boot', `${state.vehicle.firmware} up. Trip ${state.tripId}.`);
    await closeExpired();
    publish();
    return snapshot();
  }

  function shutdown() {
    if (ticker) clearInterval(ticker);
    if (simTimer) clearInterval(simTimer);
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    link?.close();
    releaseScreen();
    releasePower();
    ticker = null;
    simTimer = null;
    watchId = null;
    link = null;
    state.booted = false;
  }

  // ------------------------------------------------------------ positioning

  function startPositioning() {
    if (!navigator.geolocation) {
      log('gps', 'No GNSS on this host. Run the bench drive instead.');
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        // The bench drive owns the odometer while it runs. Two position sources
        // at once would be two buses.
        if (!state.simulating) ingestFix(fixFromPosition(position));
      },
      (error) => log('gps', `GNSS error: ${error.message}`),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  }

  function ingestFix(fix) {
    const result = applyFix(state.odo, fix);
    state.odo = result.state;
    recorder.push(fix, result);
    if (result.accepted) state.doppler = Number.isFinite(fix.speed);
    if (result.accepted) {
      state.fix = fix;
      state.trace = [...state.trace, { ...fix, delta: result.deltaMetres }].slice(-TRACE_LIMIT);
      if (result.deltaMetres > 0) persistOdometer().catch(() => {});
    } else if (result.reason !== 'accuracy') {
      // Accuracy rejections are constant indoors and would drown the tape.
      log('gps', `Fix rejected: ${result.reason}.`);
    }
    return result;
  }

  /*
    Bench drive. Drives R11 end to end and back again the way Kathmandu traffic
    does, emitting fixes the odometer cannot tell from a receiver's. They go
    through the same gates as a real fix — no back door into the odometer,
    because a back door is the one thing that would make the meter
    untrustworthy. The drive knows its own true distance, so the console can
    show the meter's error against it while it runs.
  */
  function nextBenchLeg(forward, seed) {
    bench = { drive: benchLeg(forward, seed), index: 0, forward, seed, lastChain: 0 };
  }

  function simulate(on) {
    state.simulating = on;
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (!on) { log('sim', 'Bench drive stopped.'); publish(); return; }

    if (!bench) {
      nextBenchLeg(true, 1 + (Date.now() % 997));
      state.benchTruthM = 0;
      state.benchOdoM = 0;
    }
    log('sim', `Bench drive along R11 ${bench.forward ? 'outbound' : 'inbound'}: stop-and-go traffic, receiver noise, Doppler on.`);
    simTimer = setInterval(() => {
      if (bench.index >= bench.drive.fixes.length) {
        log('sim', `Reached ${bench.forward ? 'Koteshwor' : 'Ratna Park'}. Turning round.`);
        nextBenchLeg(!bench.forward, bench.seed + 1);
      }
      const scripted = bench.drive.fixes[bench.index];
      const chain = bench.drive.chains[bench.index];
      bench.index += 1;
      const before = odometerReading(state.odo);
      ingestFix({ ...scripted, at: Date.now(), source: 'bench' });
      state.benchTruthM += Math.max(0, chain - bench.lastChain);
      state.benchOdoM += odometerReading(state.odo) - before;
      bench.lastChain = chain;
      publish();
    }, TICK_MS);
    publish();
  }

  // ---------------------------------------------------------------- trace

  function startTrace() {
    recorder.start();
    recorder.mark('start', { odometerM: reading() });
    log('trace', 'Recording every receiver fix. Drop a mark at each known point.');
    publish();
  }

  function markTrace(label, truthM) {
    const entry = recorder.mark(label, { truthM, odometerM: reading() });
    if (entry) log('trace', `Mark "${label}" at ${entry.odometerM} m${Number.isFinite(truthM) ? ` (known: ${truthM} m)` : ''}.`);
    publish();
  }

  function stopTrace() {
    recorder.mark('end', { odometerM: reading() });
    recorder.stop();
    log('trace', `Recording stopped. ${recorder.count} fixes.`);
    publish();
    return recorder.toJSON({ vehicleId: state.vehicleId, firmware: state.vehicle.firmware, fusion: 'protocol/meter.mjs FUSION' });
  }

  // ---------------------------------------------------------------- doors

  function evaluateDoors() {
    for (const id of ['A', 'B']) {
      const door = state.doors[id];
      const decision = doorDecision({
        role: door.role,
        onboard: state.onboard.length,
        capacity: state.capacity,
        speedMps: state.odo.speedMps,
        override: state.override,
      });
      // A commanded-open door that the interlock refuses reads as LOCKED, not
      // as closed: the difference is the whole point of an interlock, and the
      // driver needs to see which one is happening.
      const next = door.commanded && decision.open
        ? DOOR_STATE.OPEN
        : door.commanded
          ? DOOR_STATE.LOCKED
          : decision.state === DOOR_STATE.LOCKED ? DOOR_STATE.LOCKED : DOOR_STATE.CLOSED;

      if (next !== door.state || decision.reason !== door.reason) {
        if (next === DOOR_STATE.LOCKED && decision.reason === 'at_capacity' && door.state !== DOOR_STATE.LOCKED) {
          log('door', `Door ${id} held: ${state.onboard.length} of ${state.capacity} aboard.`, { severity: 'warn' });
        }
        if (decision.reason === 'exit_only' && door.reason !== 'exit_only') {
          log('door', `Door ${id}: full at ${state.onboard.length} of ${state.capacity} — getting off only.`, { severity: 'warn', reason: 'exit_only' });
        }
        state.doors = { ...state.doors, [id]: { ...door, state: next, reason: decision.reason } };
      }
    }
  }

  function commandDoor(id, open) {
    const door = state.doors[id];
    if (!door) return;
    state.doors = { ...state.doors, [id]: { ...door, commanded: open } };
    log('door', `Door ${id} ${open ? 'open' : 'close'} commanded.`);
    evaluateDoors();
    publish();
  }

  function setOverride(on) {
    state.override = on;
    // An override is a safety action and an audit event at the same time. It is
    // never silent, and it is never only in the UI.
    log('override', on ? 'INTERLOCK OVERRIDDEN by crew.' : 'Interlock restored.', { severity: on ? 'alarm' : 'info' });
    evaluateDoors();
    publish();
  }

  function setCapacity(next) {
    state.capacity = Math.max(1, Math.round(next));
    log('config', `Capacity set to ${state.capacity}.`);
    evaluateDoors();
    publish();
  }

  // ----------------------------------------------------------------- legs

  function openLegFor(publicKey) {
    return state.onboard.find((l) => l.passengerPublicKey === publicKey) ?? null;
  }

  function remember(publicKey, hint = {}) {
    const existing = state.registry.get(publicKey);
    const entry = {
      publicKey,
      alias: hint.alias ?? existing?.alias ?? null,
      concession: hint.concession ?? existing?.concession ?? 'none',
      // A concession asserted by a phone is a hint until the backend confirms
      // it against the card that was checked. The console shows which it is.
      concessionVerified: existing?.concessionVerified ?? false,
      firstSeen: existing?.firstSeen ?? Date.now(),
      lastSeen: Date.now(),
      rides: existing?.rides ?? 0,
      spent: existing?.spent ?? 0,
    };
    state.registry.set(publicKey, entry);
    db().then((database) => database.put('meter', [...state.registry.values()], 'registry')).catch(() => {});
    return entry;
  }

  /*
    End of trip. Anyone still aboard never tapped out, and a ride with no end is
    charged as if it ran to the cap — the same rule every closed metro system
    uses, for the same reason: an unclosed leg must never be cheaper than a
    closed one, or tapping out becomes optional.
  */
  async function closeUnclosed(leg, why) {
    const distanceM = Math.max(0, reading() - (leg.boardOdoM ?? 0));
    const price = priceDistance(distanceM, { concession: leg.concession ?? 'none', unclosed: true });
    const closed = {
      ...leg,
      status: 'closed',
      alightDoorId: leg.boardDoorId,
      alightOdoM: Math.max(reading(), leg.boardOdoM ?? 0),
      alightAt: Math.max(nowS(), leg.boardAt ?? 0),
      alightFix: state.fix ?? null,
      distanceM,
      distanceSource: 'unclosed',
      estimated: true,
      distanceNote: why,
      amount: price.amount,
      unclosed: true,
      synced: 0,
    };
    closed.receipt = signLeg(
      buildLeg({
        vehicleId: closed.vehicleId,
        tripId: closed.tripId,
        legId: closed.legId,
        passengerPublicKey: closed.passengerPublicKey,
        boardDoorId: closed.boardDoorId,
        alightDoorId: closed.alightDoorId,
        boardOdoM: closed.boardOdoM ?? 0,
        alightOdoM: closed.alightOdoM,
        distanceM,
        distanceSource: 'unclosed',
        boardAt: closed.boardAt,
        alightAt: closed.alightAt,
        concession: closed.concession ?? 'none',
        amount: closed.amount,
        tariffCode: price.tariffCode,
      }),
      state.vehicleKeys.secretKey,
    );
    state.onboard = state.onboard.filter((l) => l.legId !== leg.legId);
    state.closed = [closed, ...state.closed];
    state.accrued += closed.amount;
    state.queued += 1;
    await persistLeg(closed);
    log('tap', `AUTO-CLOSE ${short(closed.passengerPublicKey)}: ${why}. Rs ${closed.amount}.`, { severity: 'warn' });
    return closed;
  }

  /*
    A ride whose boarding pass has expired can no longer be closed at a door,
    so it is closed here — at the cap, like any ride nobody tapped out of. The
    alternative is what this console used to show: someone "aboard" for three
    days, owing a fare for 35 km, holding a seat against the door interlock.
  */
  async function closeExpired() {
    if (!state.vehicleKeys) return 0;
    const cutoff = nowS() - PASS_MAX_AGE_S;
    const expired = state.onboard.filter((leg) => (leg.boardAt ?? 0) < cutoff);
    for (const leg of expired) await closeUnclosed(leg, 'pass expired without a tap-out');
    if (expired.length) { evaluateDoors(); publish(); }
    return expired.length;
  }

  // ----------------------------------------------------------------- the crew

  /*
    Sign a crew member on to this bus.

    The console checks the signature itself, with the tight window, because the
    one moment a screenshot of somebody else's sign-on could be held up to a
    camera is this one. The backend checks it again — the console is a phone in
    a bus and its word about a signature is exactly what the protocol exists to
    stop taking — but a conductor who scanned the wrong thing finds out here,
    in the depot, rather than a week later when the bonus does not arrive.
  */
  async function signOnCrew(text) {
    const verdict = verifySignOn(text, { vehicleId: state.vehicleId, now: nowS() });
    if (!verdict.ok) {
      log('crew', `Sign-on refused: ${verdict.message}`, { severity: 'warn' });
      publish();
      return verdict;
    }
    state.crew = {
      publicKey: verdict.signOn.crewPublicKey,
      signOn: String(text).trim(),
      signedOnAt: verdict.signOn.issuedAt,
      trips: [],
    };
    await noteCrewTrip(state.tripId);
    log('crew', `${short(verdict.signOn.crewPublicKey)} signed on.`);
    publish();
    return verdict;
  }

  async function signOffCrew() {
    if (!state.crew) return null;
    const who = state.crew.publicKey;
    state.crew = null;
    const database = await db();
    await database.put('meter', null, 'crew');
    log('crew', `${short(who)} signed off.`);
    publish();
    return who;
  }

  /*
    Add a trip to the list this shift's one sign-on covers, and write the whole
    thing through. A conductor works eight trips between signing on and going
    home; asking them to re-scan at every terminus is how a feature gets
    switched off in week one.
  */
  async function noteCrewTrip(tripId) {
    if (!state.crew || !tripId) return;
    if (!state.crew.trips.includes(tripId)) state.crew.trips = [...state.crew.trips, tripId];
    const database = await db();
    await database.put('meter', { ...state.crew, sent: false }, 'crew');
  }

  /*
    Did somebody pull the plug?

    Called whenever the battery state changes and once a second from the tick,
    because the interesting case is the one where nothing changes: the charger
    went away two minutes ago and has not come back.

    Nothing here refuses anything. The event is a mark on the tape — the same
    shape as the plausibility score — and its only consequence is that the trip
    it lands on does not earn its crew a bonus.
  */
  function evaluatePower() {
    const next = assessPower({
      charging: state.power.supported === true ? state.power.charging : null,
      lostAt: state.powerLostAt,
      pulled: state.powerPulled,
      lastMovedAt: state.lastMovedAt,
    }, { now: nowS() });
    state.powerLostAt = next.lostAt;
    state.powerPulled = next.pulled;
    if (next.event === 'power_lost') {
      log('power', 'The meter lost its 12 V feed with the bus moving.', {
        severity: 'alarm', power: 'power_lost', moving: true,
      });
    } else if (next.event === 'power_restored') {
      log('power', 'The 12 V feed is back.', { power: 'power_restored', moving: next.moving ?? null });
    }
  }

  async function endTrip() {
    const stranded = [...state.onboard];
    for (const leg of stranded) await closeUnclosed(leg, 'no tap-out by the end of the trip');

    // The trip closing is what makes its bonus assessable, and the backend
    // cannot know a trip ended until the bus says so. Queued rather than sent:
    // a terminus is exactly where there is no signal.
    const closing = state.tripId;
    const closingCount = state.counted;

    state.onboard = [];
    state.counted = null;
    state.cash = { tickets: 0, npr: 0 };
    state.tripId = newId('T');
    state.closed = [];
    state.accrued = 0;
    const database = await db();
    await database.put('meter', state.tripId, 'tripId');
    if (closing) {
      const queued = (await database.get('meter', 'closedTrips')) ?? [];
      if (!queued.includes(closing)) await database.put('meter', [...queued, closing], 'closedTrips');
      // The door count goes up with the close, so the trip is judged with it.
      if (closingCount !== null) {
        const counts = (await database.get('meter', 'tripCounts')) ?? [];
        await database.put('meter', [...counts.filter((c) => c.tripId !== closing), { tripId: closing, counted: closingCount }], 'tripCounts');
      }
      await database.delete('meter', `counted:${closing}`);
    }
    // A shift outlives a trip, so the crew carries over and the new trip is
    // added to the list their one sign-on covers.
    if (state.crew) await noteCrewTrip(state.tripId);
    log('trip', `Trip closed. ${stranded.length} unclosed leg(s) settled at the cap. New trip ${state.tripId}.`);
    evaluateDoors();
    publish();
    return state.tripId;
  }

  /*
    The door counter.

    A break-beam at the step, wired to the box, calls this once per body. It is
    deliberately dumb: it does not know who tapped, only that somebody came
    through. The count is compared with the trip's record (rides plus cash
    tickets) at the backend, and that comparison is what the crew bonus rides
    on (cleanTripVerdict in protocol/crew.mjs).
  */
  async function countBoarding(n = 1) {
    state.counted = (state.counted ?? 0) + Math.max(0, Math.round(n));
    const database = await db();
    await database.put('meter', state.counted, `counted:${state.tripId}`);
    publish();
    return state.counted;
  }

  // --------------------------------------------------------------- the tick

  function tick() {
    state.tick += 1;
    if (state.tick % 60 === 0) closeExpired().catch(() => {});
    state.link = link?.state() ?? LINK.DETACHED;
    // What the plug detector needs to tell a working bus from a parked one.
    if (state.odo.speedMps > CREEP_SPEED_MPS) state.lastMovedAt = nowS();
    evaluatePower();
    evaluateDoors();

    let flags = 0;
    if (state.doors.A.state === DOOR_STATE.OPEN) flags |= FLAG.BOARDING_DOOR_OPEN;
    if (state.doors.B.state === DOOR_STATE.OPEN) flags |= FLAG.ALIGHTING_DOOR_OPEN;
    if (state.odo.speedMps > CREEP_SPEED_MPS) flags |= FLAG.MOVING;
    if (state.odo.quality === FIX_QUALITY.GOOD) flags |= FLAG.FIX_VALID;
    if (state.onboard.length >= state.capacity) flags |= FLAG.AT_CAPACITY;
    if (state.override) flags |= FLAG.OVERRIDE;
    if (state.queued > 0) flags |= FLAG.OFFLINE_QUEUE;
    if (state.tamper) flags |= FLAG.TAMPER;

    state.frame = encodeFrame({
      flags,
      occupancy: state.onboard.length,
      capacity: state.capacity,
      odometerMetres: reading(),
      latMicro: state.fix ? toMicro(state.fix.lat) : 0,
      lonMicro: state.fix ? toMicro(state.fix.lon) : 0,
      speedCmS: Math.round(state.odo.speedMps * 100),
      unixSeconds: nowS(),
      openLegs: state.onboard.length,
      accrued: state.accrued,
    });
    state.frameHex = frameToHex(state.frame);

    // The terminals render occupancy and the odometer from this, so it goes out
    // every second whether or not anything changed. A terminal that reconnects
    // mid-trip is correct within one second and needs no catch-up protocol.
    link?.send('state', {
      vehicleId: state.vehicleId,
      // The odometer's name. Door terminals stamp this onto the passes they
      // issue instead of their own unit id whenever the meter is live, which is
      // what lets a ride that starts at one door and ends at the other be
      // priced from one odometer rather than two.
      unitId: `M${state.vehicleId}`,
      // The key the backend holds for this bus. A door paired to any other key
      // signs receipts that can never settle, so it has to be told.
      vehiclePublicKey: state.vehicleKeys?.publicKey ?? null,
      tripId: state.tripId,
      odometerM: reading(),
      onboard: state.onboard.length,
      capacity: state.capacity,
      doors: { A: state.doors.A.state, B: state.doors.B.state },
      quality: state.odo.quality,
      speedKmh: Number((state.odo.speedMps * 3.6).toFixed(1)),
      accrued: state.accrued,
      atCapacity: state.onboard.length >= state.capacity,
    });

    publish();
  }

  // ------------------------------------------------------------- link inbox

  /*
    Legs opened and closed by door terminals. The meter is the aggregator, not
    the gatekeeper: a terminal that priced a ride offline has already priced it,
    and the meter's job is to hold the roster, run the interlock and keep the
    tape. Re-deciding a settled fare here would mean two different answers to
    the same question depending on who had signal.
  */
  async function onBoarded(message) {
    if (state.onboard.some((l) => l.legId === message.legId)) return;
    remember(message.passengerPublicKey, { concession: message.concession, alias: message.alias });
    const leg = {
      legId: message.legId,
      status: 'open',
      tripId: message.tripId ?? state.tripId,
      vehicleId: state.vehicleId,
      passengerPublicKey: message.passengerPublicKey,
      alias: message.alias ?? null,
      concession: message.concession ?? 'none',
      boardDoorId: message.doorId,
      boardUnitId: message.unitId,
      boardOdoM: message.boardOdoM ?? 0,
      boardAt: message.boardAt ?? nowS(),
      boardFix: message.fix ?? null,
      // The pass is carried through, not dropped. This row and the issuing
      // terminal's row are the same row — `legs` is keyed by legId — so writing
      // it back without the pass would erase the one thing the other door needs
      // to close the ride.
      passQr: message.passQr ?? null,
      // The passenger's signed tap: their consent to this ride, and the one
      // thing the backend needs besides the receipt before it moves money.
      tapQr: message.tapQr ?? null,
      remote: true,
      synced: 0,
    };
    state.onboard = [...state.onboard, leg];
    await persistLeg(leg);
    log('tap', `IN  ${short(leg.passengerPublicKey)} at door ${leg.boardDoorId} (unit ${leg.boardUnitId}) · ${state.onboard.length}/${state.capacity} aboard.`);
    evaluateDoors();
    publish();
  }

  async function onAlighted(message) {
    const open = state.onboard.find((l) => l.legId === message.legId);
    state.onboard = state.onboard.filter((l) => l.legId !== message.legId);
    const closed = {
      ...(open ?? {}),
      legId: message.legId,
      status: 'closed',
      tripId: message.tripId ?? state.tripId,
      vehicleId: state.vehicleId,
      passengerPublicKey: message.passengerPublicKey,
      alightDoorId: message.doorId,
      alightUnitId: message.unitId,
      alightAt: nowS(),
      alightFix: message.fix ?? null,
      distanceM: message.distanceM ?? 0,
      distanceSource: message.distanceSource ?? 'gps',
      amount: message.amount ?? 0,
      receipt: message.receipt ?? null,
      tapQr: open?.tapQr ?? message.tapQr ?? null,
      remote: true,
      synced: 0,
    };
    state.closed = [closed, ...state.closed].slice(0, 200);
    state.accrued += closed.amount;
    state.queued += 1;
    const profile = state.registry.get(closed.passengerPublicKey);
    if (profile) {
      state.registry.set(closed.passengerPublicKey, {
        ...profile, rides: profile.rides + 1, spent: profile.spent + closed.amount, lastSeen: Date.now(),
      });
    }
    await persistLeg(closed);
    log('tap', `OUT ${short(closed.passengerPublicKey)} at door ${closed.alightDoorId} · ${(closed.distanceM / 1000).toFixed(2)} km via ${closed.distanceSource} · Rs ${closed.amount}.`);
    evaluateDoors();
    publish();
  }

  async function onLinkMessage(message) {
    if (message.kind === 'cash') {
      // A fare taken in cash at a door. Counted here for the console; the
      // ticket itself is uploaded by the door that issued it.
      state.cash = { tickets: state.cash.tickets + 1, npr: state.cash.npr + (message.amount ?? 0) };
      log('tap', `CASH at door ${message.doorId} · ${message.fromStop} → ${message.toStop} · Rs ${message.amount}.`);
      publish();
      return undefined;
    }
    if (message.kind === 'boarded') return onBoarded(message);
    if (message.kind === 'alighted') return onAlighted(message);
    return undefined;
  }

  // --------------------------------------------------------------- exports

  function subscribe(fn) {
    subscribers.add(fn);
    fn(snapshot());
    return () => subscribers.delete(fn);
  }

  // The queue badge is the honest count from disk rather than a running tally
  // in memory: the terminals write legs to the same store, and a number that
  // only counted this tab's own work would understate what is unsettled.
  async function refreshQueue() {
    const database = await db();
    const rows = await database.getAll('legs');
    state.queued = rows.filter((row) => row.status === 'closed' && !row.synced).length;
    publish();
    return state.queued;
  }

  /*
    What a technician shows a door terminal to provision it. The vehicle secret
    key is in here, which is why it is shown as a QR on a screen in a depot and
    never sent anywhere: the pairing happens over a camera, device to device,
    with no third party in the path.
  */
  /*
    What an inspector scans off this screen: who has a ride open, how many cash
    tickets this trip, and the door count, signed with the vehicle key
    (protocol/inspect.mjs). Fresh for a few minutes; the inspector asks for a
    new one at the next stop.
  */
  function rosterPayload() {
    if (!state.vehicleKeys) return null;
    return signRoster(buildRoster({
      vehicleId: state.vehicleId,
      tripId: state.tripId ?? 'T0',
      aboard: state.onboard.map((leg) => leg.passengerPublicKey),
      cash: state.cash.tickets,
      counted: state.counted,
      issuedAt: nowS(),
    }), state.vehicleKeys.secretKey);
  }

  function pairingPayload() {
    if (!state.vehicleKeys) return null;
    return JSON.stringify({
      v: 'BHPAIR1',
      vehicleId: state.vehicleId,
      // The whole vehicle, not just its plate. A door phone paired from this
      // code is provisioned for the bus in one gesture — the capacity it shows,
      // the route it names and the plate it signs for all come from the meter
      // that is actually bolted into the vehicle, rather than being typed twice.
      vehicle: state.vehicle,
      tripId: state.tripId,
      publicKey: state.vehicleKeys.publicKey,
      secretKey: state.vehicleKeys.secretKey,
    });
  }

  return {
    boot,
    shutdown,
    subscribe,
    snapshot,
    pairingPayload,
    rosterPayload,
    refreshQueue,
    commandDoor,
    setOverride,
    setCapacity,
    endTrip,
    signOnCrew,
    signOffCrew,
    simulate,
    ingestFix,
    countBoarding,
    startTrace,
    markTrace,
    stopTrace,
    markTamper(on) { state.tamper = on; log('tamper', on ? 'Enclosure switch tripped.' : 'Enclosure secure.', { severity: on ? 'alarm' : 'info' }); publish(); },
    decodeFrame,
    get vehicleId() { return state.vehicleId; },
  };
}

export function short(publicKey) {
  return publicKey ? `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}` : '—';
}
