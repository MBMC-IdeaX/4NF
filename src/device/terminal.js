// A door terminal.
//
// On a production bus this is a validator bolted to the doorframe, sharing the
// meter's enclosure and its key over a foot of RS-485. In this build it is a
// phone, and there are two of them: one at the boarding door, one at the
// alighting door. That is not a compromise made for the demo — it is the
// configuration a Nepali operator can actually afford, because the two phones
// are the two phones the conductor and the helper already own.
//
// The hard constraint it is built around: those two devices must be able to
// complete a ride between them with no server, no wifi and no sight of each
// other. They manage it because the boarding snapshot travels on the passenger,
// signed with the vehicle key, as a BO1 pass. The alighting terminal verifies
// that signature, reads the odometer and position out of it, and prices the ride
// on the spot. The network, when there is one, only makes the console prettier.

import { db } from '../storage/db';
import { installRandomSource } from './identity';
import { openLink, LINK } from './link';
import {
  initialOdometer, applyFix, odometerReading, priceDistance, resolveDistance, haversineMetres, TARIFF,
  CURRENT_TARIFF, stageNear, stageAlong,
} from '../../protocol/meter.mjs';
import { MAX_CORRIDOR_HOLD_NPR, calculateExitReconciliation } from '../../protocol/policy.mjs';
import { fixFromPosition, holdScreenOn } from './positioning';
import { readNfc, nfcSupported } from './nfc';
import {
  buildPass, signPass, verifyPass, buildLeg, signLeg, verifyTap, buildTap, signTap, toMicro, fromMicro, PASS_MAX_AGE_S,
  splitGroup, GROUP_VERSION,
} from '../../protocol/leg.mjs';
import { createKeypair } from '../../protocol/token.mjs';
import { buildCashTicket, signCashTicket } from '../../protocol/cash.mjs';
import { DOORS } from './meter';
import { DEFAULT_VEHICLE, loadVehicle, provisionVehicle } from './fleet';
import { stageMetres, STOPS } from '../lib/nepali';

const TICK_MS = 1000;
const EVENT_LIMIT = 60;

// Past this much disagreement between a passenger's phone clock and the door's,
// the tap still boards but the door says so in its log.
const CLOCK_SKEW_WARN_S = 60;

let instances = new Map();

export function terminal(doorId = 'A') {
  const key = String(doorId).toUpperCase();
  if (!instances.has(key)) instances.set(key, createTerminal(key));
  return instances.get(key);
}

function nowS() {
  return Math.floor(Date.now() / 1000);
}

function newId(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function createTerminal(doorId) {
  const subscribers = new Set();
  const door = DOORS[doorId] ?? DOORS.A;
  let link = null;
  let ticker = null;
  let watchId = null;
  let releaseScreen = () => {};
  let stopNfc = () => {};

  const state = {
    booted: false,
    doorId,
    role: door.role,
    unitId: null,
    vehicleId: DEFAULT_VEHICLE.id,
    vehicleKeys: null,   // paired from the meter. no key, no tickets.
    tripId: null,
    odo: initialOdometer(0),
    fix: null,
    // What the meter last told us. A terminal never invents occupancy: if the
    // meter has not spoken it says so, because a guessed passenger count is
    // worse than an absent one when a door interlock depends on it.
    busState: null,
    busStateAt: 0,
    cards: [],
    issued: 0,
    closed: 0,
    collected: 0,
    events: [],
    link: LINK.DETACHED,
    last: null,
    // Open legs this terminal knows about, keyed by passenger. Its own come
    // from issuing them; the other door's arrive over the vehicle bus. When
    // there is no vehicle bus the passenger's own phone carries the pass
    // instead, which is the offline path and the reason the pass is signed.
    openLegs: new Map(),
    // Tap nonces this door has spent. A tap lives two minutes, so this only has
    // to outlive a screenshot being passed along a queue.
    seenNonces: new Set(),
  };

  /*
    Whose odometer to believe.

    A bus has one odometer, and when the meter is reporting, that is the number
    both doors must use — otherwise a ride that starts at the front and ends at
    the rear is measured against two different rulers and cannot be priced from
    distance at all. When the meter is silent the terminal falls back to its own
    integration, stamps its own unit id on the pass, and the alighting side sees
    the mismatch and prices from the endpoints instead.
  */
  function odometerSource() {
    const fresh = state.busState && Date.now() - state.busStateAt < 5000;
    if (fresh) return { unitId: state.busState.unitId ?? `M${state.vehicleId}`, metres: state.busState.odometerM, fromMeter: true };
    return { unitId: state.unitId, metres: Math.round(odometerReading(state.odo)), fromMeter: false };
  }

  function snapshot() {
    const fresh = state.busState && Date.now() - state.busStateAt < 5000;
    return {
      booted: state.booted,
      doorId: state.doorId,
      door,
      role: state.role,
      unitId: state.unitId,
      vehicleId: state.vehicleId,
      paired: Boolean(state.vehicleKeys),
      vehiclePublicKey: state.vehicleKeys?.publicKey ?? null,
      tripId: state.tripId,
      odometerM: Math.round(odometerReading(state.odo)),
      quality: state.odo.quality,
      accuracy: state.fix?.accuracy ?? null,
      fix: state.fix,
      speedKmh: Number((state.odo.speedMps * 3.6).toFixed(1)),
      bus: fresh ? state.busState : null,
      busStale: Boolean(state.busState) && !fresh,
      // Paired to a key that is not this bus's meter: a reset or replaced meter,
      // or a door carried over from another bus. Every receipt it signs would be
      // refused at settlement, so the door says so instead of failing quietly.
      keyMismatch: Boolean(state.vehicleKeys && state.busState?.vehiclePublicKey
        && state.busState.vehiclePublicKey !== state.vehicleKeys.publicKey),
      issued: state.issued,
      closed: state.closed,
      collected: state.collected,
      events: state.events,
      link: state.link,
      last: state.last,
      tariff: TARIFF,
      openLegs: [...state.openLegs.values()],
      cards: state.cards,
      nfc: nfcSupported(),
    };
  }

  function publish() {
    const snap = snapshot();
    for (const fn of subscribers) fn(snap);
  }

  function log(text, severity = 'info') {
    state.events = [{ at: Date.now(), text, severity }, ...state.events].slice(0, EVENT_LIMIT);
  }

  /*
    A tap that verified, from a phone whose clock is a long way from this one.

    The Web Geolocation API hands back the device's own clock on every fix, not
    the receiver's satellite time, so a terminal has no better clock to correct
    against — it can only notice. TAP_MAX_AGE_S is wide enough that a drifted
    phone still boards; this puts the number in the door's own event tape, so a
    fleet seeing a run of them knows the handsets need a network minute and not
    that the passengers are cheating.
  */
  function noteClockSkew(skewS) {
    if (!Number.isFinite(skewS) || Math.abs(skewS) < CLOCK_SKEW_WARN_S) return;
    const minutes = Math.round(Math.abs(skewS) / 60);
    log(`Passenger phone clock is ${minutes} min ${skewS < 0 ? 'behind' : 'ahead'}. Tap accepted.`, 'warn');
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    if (state.booted) return snapshot();
    installRandomSource();
    // Which bus this door is on, before it signs anything for it.
    state.vehicleId = (await loadVehicle()).id;
    const database = await db();

    let unitId = await database.get('meter', `unitId:${doorId}`);
    if (!unitId) {
      unitId = newId(`U${doorId}`);
      await database.put('meter', unitId, `unitId:${doorId}`);
    }
    state.unitId = unitId;

    // A terminal on the same device as the meter shares its key directly; a
    // separate phone has to be paired. Both paths end at the same place.
    state.vehicleKeys = (await database.get('meter', 'pairing'))
      ?? (await database.get('meter', 'vehicleKeys'))
      ?? null;
    state.tripId = (await database.get('meter', 'tripId')) ?? null;

    const savedOdo = await database.get('meter', `odometer:${doorId}`);
    state.odo = initialOdometer(savedOdo?.metres ?? 0);

    state.cards = (await database.get('meter', 'cards')) ?? [];
    for (const row of await database.getAll('legs')) {
      if (row.status === 'open' && row.passQr) {
        state.openLegs.set(row.passengerPublicKey, { legId: row.legId, passQr: row.passQr, tapQr: row.tapQr ?? null, boardAt: row.boardAt, alias: row.alias, concession: row.concession, passengerPublicKey: row.passengerPublicKey });
      }
    }

    link = openLink(state.vehicleId, onLinkMessage, {
      unitId: state.unitId,
      // A unit that has just come within earshot may have been boarding people
      // for twenty minutes while this door could not hear it. Tell it what is
      // open here, and it will do the same — so a passenger who boarded at the
      // front during the dead patch can still be let off at the back.
      onPeer: () => {
        const open = [...state.openLegs.values()].filter((leg) => leg.passQr);
        if (open.length > 0) link?.send('open-legs', { legs: open.slice(0, 60) });
      },
    });
    startPositioning();
    // A door terminal that sleeps misses taps and fixes alike.
    releaseScreen = holdScreenOn();
    // Tap-and-go, where the handset has it. The camera button stays exactly
    // where it was; this only removes the aiming from the fast path.
    stopNfc = readNfc({
      onText: (text) => { present({ text }).catch(() => {}); },
      onCard: (cardUid) => { tapCardUid(cardUid).catch(() => {}); },
      onError: (error) => log(`NFC: ${error.message}`, 'warn'),
    });
    ticker = setInterval(() => {
      state.link = link?.state() ?? LINK.DETACHED;
      publish();
    }, TICK_MS);

    state.booted = true;
    log(`Unit ${state.unitId} at door ${doorId} ready.`);
    publish();
    return snapshot();
  }

  function shutdown() {
    if (ticker) clearInterval(ticker);
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    link?.close();
    releaseScreen();
    stopNfc();
    stopNfc = () => {};
    ticker = null;
    watchId = null;
    link = null;
    state.booted = false;
  }

  /*
    Pairing. The technician shows the meter's provisioning QR to the terminal
    once; after that the terminal can sign for the vehicle and never needs the
    meter again. The secret travels device-to-device over a camera, not over a
    network, which is the only reason it is acceptable to move it at all.
  */
  async function pair(text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, message: 'That is not a pairing code.' };
    }
    if (payload.v !== 'BHPAIR1' || !payload.publicKey || !payload.secretKey) {
      return { ok: false, message: 'Pairing code is for something else.' };
    }
    const keys = { publicKey: payload.publicKey, secretKey: payload.secretKey };
    const database = await db();
    await database.put('meter', keys, 'pairing');
    if (payload.tripId) {
      await database.put('meter', payload.tripId, 'tripId');
      state.tripId = payload.tripId;
    }
    state.vehicleKeys = keys;
    // Pairing provisions the door for the bus as well as handing it the key.
    // A phone carried over from another vehicle adopts this one here, which is
    // the moment it stops signing for the bus it left.
    if (payload.vehicle?.id || payload.vehicleId) {
      const provisioned = await provisionVehicle(payload.vehicle ?? { id: payload.vehicleId });
      if (provisioned.ok) state.vehicleId = provisioned.vehicle.id;
    }
    log(`Paired to vehicle ${state.vehicleId}.`);
    publish();
    return { ok: true, message: `Paired to ${state.vehicleId}.` };
  }

  // ------------------------------------------------------------ positioning

  function startPositioning() {
    if (!navigator.geolocation) {
      log('No GNSS on this device — distance will fall back to stages.', 'warn');
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (position) => ingestFix(fixFromPosition(position)),
      (error) => log(`GNSS: ${error.message}`, 'warn'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  }

  function ingestFix(fix) {
    const result = applyFix(state.odo, fix);
    state.odo = result.state;
    if (result.accepted) {
      state.fix = fix;
      if (result.deltaMetres > 0) {
        db().then((d) => d.put('meter', { metres: state.odo.metres, at: Date.now() }, `odometer:${doorId}`)).catch(() => {});
      }
    }
    publish();
    return result;
  }

  // ------------------------------------------------------------------ taps

  function requireKeys() {
    if (!state.vehicleKeys) {
      return { ok: false, reason: 'unpaired', message: 'This terminal is not paired to a vehicle yet.' };
    }
    return null;
  }

  /*
    Board. Issues the pass and hands it straight back — the passenger's phone
    stores it, and if the passenger has no phone the terminal shows the QR for
    them to photograph. Nothing is charged here. A fare that is quoted before the
    distance is known is a fare that is guessed.
  */
  async function board({ passengerPublicKey, tapQr, concession = 'none', alias = null, attestationQr = null }) {
    const missing = requireKeys();
    if (missing) return missing;

    let key = passengerPublicKey;
    if (tapQr) {
      const verdict = verifyTap(tapQr, { vehicleId: state.vehicleId, seenNonces: state.seenNonces });
      if (!verdict.ok) {
        log(`Refused: ${verdict.reason}.`, 'warn');
        state.last = { ...verdict, at: Date.now() };
        publish();
        return verdict;
      }
      key = verdict.tap.passengerPublicKey;
      state.seenNonces.add(verdict.tap.nonce);
      noteClockSkew(verdict.skewS);
    }
    if (!key) return { ok: false, reason: 'no_passenger', message: 'No pass presented.' };
    // No tap, no ride. The tap is the passenger's own signature on "I boarded";
    // the backend will not settle a leg without it, so a terminal that issued a
    // pass without one would be issuing a ride nobody can be billed for.
    if (!tapQr) return { ok: false, reason: 'no_tap', message: 'Show the ride code on your phone.' };

    // Anti-replay lock: a passenger key already on record onboard this bus cannot tap in a second time.
    // Defeats screenshot forwarding ("one pass for two friends").
    if (state.openLegs.has(key)) {
      log(`Refused: Passenger ${key.slice(0, 6)}… already riding onboard. Replay blocked.`, 'warn');
      state.last = {
        ok: false,
        reason: 'already_riding',
        message: 'This pass is already active onboard this bus. Tapping in twice is not permitted.',
        at: Date.now(),
      };
      publish();
      return state.last;
    }

    // Capacity is the meter's call, not the terminal's. When the meter is
    // reachable and says the bus is full, the terminal refuses to issue — the
    // door interlock and the fare system agreeing is the whole feature.
    if (state.busState && state.busState.atCapacity) {
      log(`Bus full (${state.busState.onboard}/${state.busState.capacity}). Boarding refused.`, 'alarm');
      state.last = {
        ok: false,
        reason: 'at_capacity',
        message: `Bus is full — ${state.busState.onboard} of ${state.busState.capacity}. Next bus.`,
        at: Date.now(),
      };
      publish();
      return state.last;
    }

    const legId = newId('L');
    const source = odometerSource();
    const pass = buildPass({
      vehicleId: state.vehicleId,
      tripId: state.tripId ?? 'T0',
      legId,
      passengerPublicKey: key,
      boardDoorId: state.doorId,
      unitId: source.unitId,
      boardOdoM: source.metres,
      boardLatMicro: state.fix ? toMicro(state.fix.lat) : 0,
      boardLonMicro: state.fix ? toMicro(state.fix.lon) : 0,
      boardAt: nowS(),
      concession,
    });
    const passQr = signPass(pass, state.vehicleKeys.secretKey);

    const row = {
      legId,
      status: 'open',
      tripId: pass.tripId,
      vehicleId: state.vehicleId,
      passengerPublicKey: key,
      alias,
      concession,
      boardDoorId: state.doorId,
      boardUnitId: source.unitId,
      boardOdoM: pass.boardOdoM,
      boardAt: pass.boardAt,
      boardFix: state.fix,
      passQr,
      tapQr,
      // The concession card, carried with the ride rather than checked here. A
      // door has no register of campuses and does not need one: the signature
      // and the expiry are all it could check, and the discount only costs the
      // operator anything once the backend settles it.
      attestationQr,
      synced: 0,
    };
    const database = await db();
    await database.put('legs', row);

    state.openLegs.set(key, { legId, passQr, tapQr, boardAt: pass.boardAt, alias, concession, passengerPublicKey: key });
    state.issued += 1;
    log(`IN  ${key.slice(0, 6)}… · odo ${pass.boardOdoM} m (${source.fromMeter ? 'meter' : 'this unit'}) · pass ${legId}.`);
    link?.send('boarded', {
      legId,
      passQr,
      tapQr,
      passengerPublicKey: key,
      doorId: state.doorId,
      unitId: source.unitId,
      concession,
      alias,
      boardOdoM: pass.boardOdoM,
      boardAt: pass.boardAt,
      fix: state.fix,
      tripId: pass.tripId,
    });

    state.last = { ok: true, action: 'in', legId, passQr, pass, at: Date.now() };
    publish();
    return state.last;
  }

  /*
    Alight. Everything needed to price the ride is in the pass plus this
    terminal's own position, so this path never touches the network and never
    asks the meter a question it might not be able to answer.
  */
  async function alight({ passQr }) {
    const missing = requireKeys();
    if (missing) return missing;

    const database = await db();
    const verdict = verifyPass(passQr, {
      vehiclePublicKey: state.vehicleKeys.publicKey,
      vehicleId: state.vehicleId,
    });
    if (!verdict.ok) {
      log(`Refused: ${verdict.reason}.`, 'warn');
      state.last = { ...verdict, at: Date.now() };
      publish();
      return state.last;
    }
    const { pass } = verdict;

    const already = await database.get('legs', pass.legId);
    if (already?.status === 'closed') {
      state.last = { ok: false, reason: 'replay', message: 'This ride was already closed.', at: Date.now() };
      log('Refused: pass already used.', 'warn');
      publish();
      return state.last;
    }

    const boardFix = pass.boardLatMicro || pass.boardLonMicro
      ? { lat: fromMicro(pass.boardLatMicro), lon: fromMicro(pass.boardLonMicro) }
      : null;

    // Odometer readings only compare within one unit. A pass issued against the
    // vehicle's meter and read back against the same meter is a real distance;
    // a pass issued against the other door phone's own integration is not, and
    // subtracting one from the other would be arithmetic on two rulers.
    const source = odometerSource();
    const sameUnit = pass.unitId === source.unitId;

    const measured = resolveDistance({
      boardOdoM: sameUnit ? pass.boardOdoM : NaN,
      alightOdoM: sameUnit ? source.metres : NaN,
      boardFix,
      alightFix: state.fix,
      stageMetres: nearestStageMetres(boardFix, state.fix),
      // The route this vehicle runs, as published chainage. When the odometer
      // could not supply a figure, the ride is measured along the road rather
      // than across it — the difference under a flyover is the whole fare.
      route: STOPS,
    });
    // The fare is the stage fare between where the passenger got on and where
    // they got off. GPS finds both stages: the boarding fix is signed into the
    // pass, the exit stage is the one this door is nearest now — or, with no
    // fix, the stage the measured distance reaches from the boarding stage.
    // Without a boarding stage the ride falls back to the distance tariff.
    const boardStage = stageNear(CURRENT_TARIFF, boardFix);
    const alightStage = boardStage ? (stageNear(CURRENT_TARIFF, state.fix) ?? stageAlong(CURRENT_TARIFF, boardStage, measured.metres)) : null;
    const staged = Boolean(boardStage && alightStage);
    const price = staged
      ? priceDistance(measured.metres, { concession: pass.concession, tariff: CURRENT_TARIFF, boardStage, alightStage })
      : priceDistance(measured.metres, { concession: pass.concession });
    const reconciliation = calculateExitReconciliation({
      holdAmount: MAX_CORRIDOR_HOLD_NPR,
      actualFare: price.amount,
    });

    const closed = {
      legId: pass.legId,
      status: 'closed',
      tripId: pass.tripId,
      vehicleId: pass.vehicleId,
      passengerPublicKey: pass.passengerPublicKey,
      concession: pass.concession,
      boardDoorId: pass.boardDoorId,
      boardUnitId: pass.unitId,
      boardOdoM: pass.boardOdoM,
      boardAt: pass.boardAt,
      boardFix,
      alightDoorId: state.doorId,
      alightUnitId: source.unitId,
      alightOdoM: source.metres,
      alightAt: nowS(),
      alightFix: state.fix,
      distanceM: Math.round(measured.metres),
      distanceSource: measured.source,
      estimated: measured.estimated,
      distanceNote: measured.note ?? (sameUnit ? null : 'boarded against another odometer — priced from endpoints'),
      amount: price.amount,
      boardStage,
      alightStage,
      price,
      reconciliation,
      passQr,
      // The consent that opened this ride, if this terminal has seen it —
      // issued here, or mirrored from the other door over the vehicle bus. If
      // not, the boarding door files it on its own upload.
      tapQr: already?.tapQr ?? state.openLegs.get(pass.passengerPublicKey)?.tapQr ?? null,
      attestationQr: already?.attestationQr ?? null,
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
        boardOdoM: closed.boardOdoM,
        alightOdoM: closed.alightOdoM,
        distanceM: closed.distanceM,
        distanceSource: closed.distanceSource,
        boardAt: closed.boardAt,
        alightAt: closed.alightAt,
        concession: closed.concession,
        amount: closed.amount,
        tariffCode: price.tariffCode,
        ...(staged ? { boardStage, alightStage } : {}),
      }),
      state.vehicleKeys.secretKey,
    );

    await database.put('legs', closed);
    state.openLegs.delete(closed.passengerPublicKey);
    state.closed += 1;
    state.collected += closed.amount;
    log(`OUT ${closed.passengerPublicKey.slice(0, 6)}… · ${(closed.distanceM / 1000).toFixed(2)} km (${closed.distanceSource}) · Rs ${closed.amount} (Refund Rs ${reconciliation.refundAmount}).`);
    link?.send('alighted', {
      legId: closed.legId,
      passengerPublicKey: closed.passengerPublicKey,
      doorId: state.doorId,
      unitId: source.unitId,
      amount: closed.amount,
      distanceM: closed.distanceM,
      distanceSource: closed.distanceSource,
      tripId: closed.tripId,
      receipt: closed.receipt,
      reconciliation,
      tapQr: closed.tapQr,
      fix: state.fix,
    });

    state.last = { ok: true, action: 'out', leg: closed, price, receipt: closed.receipt, reconciliation, at: Date.now() };
    publish();
    return state.last;
  }

  /*
    A passenger paying cash.

    The conductor picks where they are going; the door prices it by the same
    tariff as everyone else — the stage distance between the two stops — and
    signs a CT1 cash ticket with the vehicle key. No wallet moves. The ticket is
    the bus's statement that it took this much cash for this ride, which is
    what the crew hands in at the end of the day and what the door counter's
    tally is checked against.
  */
  async function issueCash({ toStop, fromStop = null }) {
    const missing = requireKeys();
    if (missing) return missing;
    const from = fromStop ?? nearestStop(state.fix)?.code ?? STOPS[0].code;
    const metres = stageMetres(from, toStop);
    if (!Number.isFinite(metres) || metres <= 0) {
      return { ok: false, reason: 'bad_stops', message: 'Pick a stop further along the route.' };
    }
    const price = priceDistance(metres);
    const ticket = buildCashTicket({
      vehicleId: state.vehicleId,
      tripId: state.tripId ?? 'T0',
      doorId: state.doorId,
      fromStop: from,
      toStop,
      distanceM: Math.round(metres),
      amount: price.amount,
      tariffCode: price.tariffCode,
      issuedAt: nowS(),
    });
    const cashQr = signCashTicket(ticket, state.vehicleKeys.secretKey);
    const database = await db();
    await database.put('legs', {
      legId: ticket.ticketId,
      status: 'cash',
      tripId: ticket.tripId,
      vehicleId: ticket.vehicleId,
      fromStop: from,
      toStop,
      distanceM: ticket.distanceM,
      amount: ticket.amount,
      issuedAt: ticket.issuedAt,
      cashQr,
      synced: 0,
    });
    state.collected += ticket.amount;
    log(`CASH ${from} → ${toStop} · ${(ticket.distanceM / 1000).toFixed(1)} km · Rs ${ticket.amount}.`);
    link?.send('cash', { ticketId: ticket.ticketId, doorId: state.doorId, fromStop: from, toStop, amount: ticket.amount, tripId: ticket.tripId });
    state.last = { ok: true, action: 'cash', ticket, cashQr, price, at: Date.now() };
    publish();
    return state.last;
  }

  function nearestStop(fix) {
    if (!fix) return null;
    return STOPS.reduce((best, s) => {
      const d = haversineMetres({ lat: s.lat, lon: s.lon }, fix);
      return !best || d < best.d ? { d, code: s.code } : best;
    }, null);
  }

  function nearestStageMetres(a, b) {
    if (!a || !b) return null;
    const near = (fix) => STOPS.reduce((best, s) => {
      const d = haversineMetres({ lat: s.lat, lon: s.lon }, fix);
      return !best || d < best.d ? { d, s } : best;
    }, null);
    const from = near(a);
    const to = near(b);
    return from && to ? stageMetres(from.s.code, to.s.code) : null;
  }

  /*
    One button, either action. The terminal decides which by looking at what was
    presented: a BO1 is somebody leaving, anything else is somebody arriving.
    A passenger never has to choose the right button on a moving bus.
  */
  async function present({ text, concession, alias }) {
    const trimmed = String(text ?? '').trim();
    if (trimmed.startsWith('BO1|')) return alight({ passQr: trimmed });

    /*
      A family on one phone. Each code in the group is presented exactly as if
      it had been shown alone, so each person boards, alights, is refused or is
      held on their own merits — a full bus can let two of three on — and the
      door reports the group as one verdict for the crew.
    */
    if (trimmed.startsWith(`${GROUP_VERSION}~`)) {
      const codes = splitGroup(trimmed);
      if (!codes) {
        state.last = { ok: false, reason: 'unreadable', message: 'That family code is damaged.', at: Date.now() };
        publish();
        return state.last;
      }
      const results = [];
      for (const code of codes) results.push(await present({ text: code, concession, alias }));
      const boarded = results.filter((r) => r.ok && r.action === 'in').length;
      const alighted = results.filter((r) => r.ok && r.action === 'out');
      const refused = results.filter((r) => !r.ok);
      state.last = {
        ok: boarded + alighted.length > 0,
        action: 'group',
        size: codes.length,
        boarded,
        alighted: alighted.length,
        amount: alighted.reduce((sum, r) => sum + (r.leg?.amount ?? 0), 0),
        refused: refused.length,
        reason: boarded + alighted.length > 0 ? null : refused[0]?.reason ?? 'unreadable',
        results,
        at: Date.now(),
      };
      log(`GROUP of ${codes.length}: ${boarded} in, ${alighted.length} out, ${refused.length} refused.`);
      publish();
      return state.last;
    }

    if (!trimmed.startsWith('BT1|')) {
      return { ok: false, reason: 'unreadable', message: 'Nothing recognisable was presented.' };
    }
    const verdict = verifyTap(trimmed, { vehicleId: state.vehicleId, seenNonces: state.seenNonces });
    if (!verdict.ok) {
      log(`Refused: ${verdict.reason}.`, 'warn');
      state.last = { ...verdict, at: Date.now() };
      publish();
      return state.last;
    }
    const key = verdict.tap.passengerPublicKey;
    noteClockSkew(verdict.skewS);

    // Whoever already has a ride open is getting off. Nobody taps the wrong
    // button, because there is only one. The tap is spent either way, so a
    // screenshot of someone's code cannot close their ride for them later.
    let open = state.openLegs.get(key);
    // A ride whose pass has expired cannot be closed at a door any more — the
    // meter closes it at the cap. Treating it as open would refuse this
    // passenger on every tap, forever; this tap is a new ride.
    if (open && open.boardAt && nowS() - open.boardAt > PASS_MAX_AGE_S) {
      state.openLegs.delete(key);
      open = null;
    }
    if (open) {
      state.seenNonces.add(verdict.tap.nonce);
      return alight({ passQr: open.passQr });
    }
    return board({ passengerPublicKey: key, tapQr: trimmed, concession, alias });
  }

  /*
    Issuing a card at the door, for a rider with no smartphone.

    A rider with a phone never needs this: the Bhada app on their phone holds
    their key and shows the ride code. A card is for everyone else. On real
    hardware it is an NFC card whose key is generated inside its secure element
    and never leaves it; in this build the terminal stands in for the card and
    holds the key on the card's behalf, which is the one place the demo is
    weaker than the design and is labelled as such on screen. The alias is a
    label for the crew's benefit and never leaves the vehicle.
  */
  /*
    Issue a rider card.

    A card is a key this terminal holds on the rider's behalf. That is the whole
    design, and it is deliberate: a card chip that can compute an Ed25519
    signature itself costs three to five dollars, which is unarguable against a
    Rs 15 bus fare, while a blank NFC tag with nothing on it but a serial costs
    about twenty cents. So the serial is the card, and the key that stands for it
    lives here, mapped to that serial.

    What that buys: a commuter with no smartphone, no bank and no literacy in
    English gets the same signed tap a phone produces, and the verification path
    at the door is the same one — not a shortcut around it.

    What it costs, stated plainly: a terminal holding the key can sign a tap that
    rider never made. A phone's key is the rider's alone and this is not. That is
    the trade a twenty-cent card forces, and the mitigation is the same one the
    rest of the system uses — the vehicle cannot settle a leg without also being
    the party that holds the receipt, and both sides of that are on the operator's
    own tape where a pattern shows.
  */
  async function enrol({ alias, concession = 'none', cardUid = null }) {
    if (cardUid && state.cards.some((c) => c.cardUid === cardUid)) {
      return { ok: false, reason: 'already_enrolled', message: 'That card is already issued to somebody.' };
    }
    const keys = createKeypair();
    const card = { alias: alias || `Card ${state.cards.length + 1}`, concession, cardUid, publicKey: keys.publicKey, secretKey: keys.secretKey, enrolledAt: Date.now() };
    state.cards = [...state.cards, card];
    const database = await db();
    await database.put('meter', state.cards, 'cards');
    log(`Enrolled ${card.alias} (${keys.publicKey.slice(0, 6)}…).`);
    publish();
    return card;
  }

  async function forgetCards() {
    state.cards = [];
    const database = await db();
    await database.put('meter', [], 'cards');
    publish();
  }

  // Tapping a card is tapping the passenger's own phone: the card signs a BT1
  // exactly as the app would, so the terminal's verification path is the same
  // one a real passenger goes through rather than a demo shortcut around it.
  // A physical card, arriving by its serial rather than by being picked off a
  // list. Unknown serials are refused rather than enrolled on the spot: a card
  // that issues itself at the door is a card anybody can mint.
  async function tapCardUid(cardUid) {
    const card = state.cards.find((c) => c.cardUid === cardUid);
    if (!card) {
      log(`Unknown card ${cardUid}.`, 'warn');
      state.last = { ok: false, reason: 'unknown_card', message: 'This card is not issued. Take it to the booth.', at: Date.now() };
      publish();
      return state.last;
    }
    return tapCard(card);
  }

  async function tapCard(card) {
    const tapQr = signTap(
      buildTap({
        passengerPublicKey: card.publicKey,
        vehicleId: state.vehicleId,
        doorId: state.doorId,
      }),
      card.secretKey,
    );
    return present({ text: tapQr, concession: card.concession, alias: card.alias });
  }

  function onLinkMessage(message) {
    /*
      Another door catching this one up after a spell with no bus between them.

      Idempotent by construction: a leg this door already knows about is left
      alone, and one it does not is added exactly as a live `boarded` would have
      added it. Nothing is priced here — the pass carries the odometer reading
      the ride opened at, and the alighting door does the arithmetic when the
      passenger actually gets off.
    */
    if (message.kind === 'open-legs' && Array.isArray(message.legs)) {
      for (const leg of message.legs) {
        if (!leg?.passengerPublicKey || !leg.passQr) continue;
        if (state.openLegs.has(leg.passengerPublicKey)) continue;
        state.openLegs.set(leg.passengerPublicKey, leg);
      }
      log(`Caught up: ${message.legs.length} open ride(s) from another door.`);
      publish();
      return;
    }

    // The other door boarding someone. Caching the pass here is what lets a
    // passenger tap out at a terminal that never saw them get on, as long as
    // the vehicle bus is up. With the bus down the pass on their own phone is
    // the fallback, and nothing about the pricing changes either way.
    if (message.kind === 'boarded' && message.passQr && message.unitId !== state.unitId) {
      state.openLegs.set(message.passengerPublicKey, {
        legId: message.legId,
        passQr: message.passQr,
        tapQr: message.tapQr ?? null,
        boardAt: message.boardAt,
        alias: message.alias,
        concession: message.concession,
        passengerPublicKey: message.passengerPublicKey,
      });
      db().then((d) => d.put('legs', {
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
        passQr: message.passQr,
        tapQr: message.tapQr ?? null,
        mirrored: true,
        synced: 0,
      })).catch(() => {});
      publish();
      return;
    }
    if (message.kind === 'alighted' && message.unitId !== state.unitId) {
      state.openLegs.delete(message.passengerPublicKey);
      publish();
      return;
    }
    if (message.kind === 'state') {
      state.busState = message;
      state.busStateAt = Date.now();
      if (message.tripId && message.tripId !== state.tripId) {
        state.tripId = message.tripId;
        db().then((d) => d.put('meter', message.tripId, 'tripId')).catch(() => {});
      }
      publish();
    }
  }

  function subscribe(fn) {
    subscribers.add(fn);
    fn(snapshot());
    return () => subscribers.delete(fn);
  }

  return {
    boot, shutdown, subscribe, snapshot,
    board, alight, present, tapCard, tapCardUid, enrol, forgetCards, pair, ingestFix, issueCash,
  };
}
