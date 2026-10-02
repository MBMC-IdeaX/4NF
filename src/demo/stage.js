// A whole one-door bus in one browser tab, for showing people.
//
// Nothing here is a mock of Bhada. The meter is src/device/meter.js, the door is
// src/device/terminal.js, the upload is src/device/sync.js and the backend is
// settleBatch() over the real migrations on Postgres in the browser. What the
// stage adds is only what a room with no bus in it needs:
//
//   - people: keypairs held here, each signing a BT1 exactly as the ride card
//     does; a family whose two children ride on the mother's wallet with keys
//     derived from her seed; a conductor who signs on with a CR1;
//   - a road: the meter's own bench drive along R11, fed faster than real time,
//     with the page's clock moved forward by the same amount, so every
//     timestamp the door signs and the backend checks describes a real
//     40-minute trip rather than one that took ninety seconds;
//   - a door counter: the meter's countBoarding(), pressed for every body that
//     comes through the door — including the one who does not tap;
//   - no internet: every request that leaves the laptop is refused and counted,
//     and the uploads are answered by the in-browser backend once the presenter
//     says the signal is back.
//
// It keeps its own IndexedDB database, deleted at every start, so a real door
// or passenger on the same browser is never touched.

import { setDatabaseName } from '../storage/db';
import { buildTap, signTap, buildGroup } from '../../protocol/leg.mjs';
import { createKeypair } from '../../protocol/token.mjs';
import { createMasterSeed, deriveDailyKeypair, deriveCompanionKeypair, dayIndex, buildLink, signLink } from '../../protocol/pseudonym.mjs';
import { buildSignOn, signSignOn } from '../../protocol/crew.mjs';
import { verifyRoster, checkRider, tallyInspection } from '../../protocol/inspect.mjs';
import { STOPS } from '../lib/nepali';
import { startBackend, DEMO_CREDIT_NPR } from './backend';

const DEMO_DB = 'bhada-demo';
const SYNC_URL = import.meta.env.VITE_SYNC_URL ?? '';

// The people, by seat in the grid. Gita and her two children share a wallet.
export const PEOPLE = [
  'Amrita', 'Bishal', 'Chandra', 'Dipa', 'Hari', 'Kamal', 'Laxmi', 'Manoj', 'Nabin', 'Puja',
  'Rajan', 'Sita', 'Suman', 'Tara', 'Gita', 'Gita’s son', 'Gita’s daughter', 'Hajurama', 'Bikash', 'Sabina',
];
export const ID = { GITA: 14, SON: 15, DAUGHTER: 16, GRANDMOTHER: 17, DODGER: 18 };

function wipe(name) {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createStage({ onChange } = {}) {
  await wipe(DEMO_DB);
  setDatabaseName(DEMO_DB);
  globalThis.__BHADA_LOCAL_ONLY__ = true;

  /*
    The demonstration's clock. The bus drives forty minutes of R11 in about
    fifteen seconds, so the page's clock moves forward by the same amount: the
    door stamps a real ride time, the backend's plausibility check sees a bus
    at bus speeds, and the 300-second tap window is applied to real gaps.
  */
  const realNow = Date.now.bind(Date);
  let skewMs = 0;
  Date.now = () => realNow() + skewMs;

  const [{ meter, benchLeg }, { terminal }, sync, { installRandomSource }] = await Promise.all([
    import('../device/meter'),
    import('../device/terminal'),
    import('../device/sync'),
    import('../device/identity'),
  ]);
  installRandomSource();

  const listeners = new Set(onChange ? [onChange] : []);

  // Gita's phone: a wallet, a seed, today's key and two companions.
  const gita = { root: createKeypair(), seed: createMasterSeed() };
  const today = dayIndex(Math.floor(Date.now() / 1000));
  const familyKeys = [
    deriveDailyKeypair(gita.seed, today),
    deriveCompanionKeypair(gita.seed, today, 1),
    deriveCompanionKeypair(gita.seed, today, 2),
  ];
  const conductor = { name: 'Ram', keys: createKeypair() };

  const keyFor = (index) => (index === ID.GITA ? familyKeys[0] : index === ID.SON ? familyKeys[1] : index === ID.DAUGHTER ? familyKeys[2] : createKeypair());
  const state = {
    signal: false,
    internetRequests: 0,
    backendRequests: 0,
    backend: null,
    backendStep: 'Not started',
    passengers: PEOPLE.map((name, index) => ({
      id: index,
      name,
      keys: keyFor(index),
      wallet: index === ID.SON || index === ID.DAUGHTER ? ID.GITA : index,
      status: 'waiting',
      fare: null,
      km: null,
      balance: null,
    })),
    feed: [],
    rush: null,
    inspection: null,
    crew: { name: conductor.name, bonus: null, counted: null },
    settlement: null,
    replay: null,
    warping: false,
  };

  const emit = () => { for (const fn of listeners) fn({ ...state }); };
  const note = (entry) => {
    state.feed = [{ at: realNow(), ...entry }, ...state.feed].slice(0, 60);
    emit();
  };

  /*
    The laptop's own network card, as far as the page is concerned. Requests to
    this origin are the laptop serving itself and go through. The uploads to the
    sync function are answered by the in-browser backend, but only once the
    presenter has said the signal is back. Anything else is the internet, and
    is refused and counted.
  */
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const sameOrigin = url.startsWith('/') || url.startsWith(window.location.origin) || url.startsWith('blob:') || url.startsWith('data:');
    if (SYNC_URL && url === SYNC_URL) {
      if (!state.signal || !state.backend) {
        state.internetRequests += 1;
        emit();
        throw new TypeError('No signal');
      }
      state.backendRequests += 1;
      const body = JSON.parse(init.body);
      if (body.legs?.length && !state.firstUpload) state.firstUpload = body;
      const [status, answer] = await state.backend.handle(body);
      emit();
      return new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } });
    }
    if (sameOrigin) return realFetch(input, init);
    state.internetRequests += 1;
    emit();
    throw new TypeError('This demonstration is offline');
  };

  const backendReady = startBackend({ onStep: (step) => { state.backendStep = step; emit(); } })
    .then((backend) => {
      state.backend = backend;
      state.backendStep = `${backend.version} · ${backend.migrations.length} migrations · ${(backend.bootMs / 1000).toFixed(1)} s`;
      emit();
      return backend;
    })
    .catch((error) => {
      state.backendStep = `Postgres could not start: ${error.message}`;
      emit();
      return null;
    });

  const unit = meter();
  await unit.boot();

  // The first signature a page checks pays for the JIT; pay it off stage.
  {
    const warm = createKeypair();
    const { verifyTap } = await import('../../protocol/leg.mjs');
    for (let i = 0; i < 20; i += 1) {
      verifyTap(signTap(buildTap({ passengerPublicKey: warm.publicKey, vehicleId: 'WARMUP0', doorId: 'ANY' }), warm.secretKey), { vehicleId: 'WARMUP0' });
    }
  }

  // One door, in and out: the bus Nepal actually runs.
  const door = terminal('A');
  await door.boot();
  const vehicleId = unit.snapshot().vehicleId;

  // The conductor signs on for the shift from their own phone.
  await unit.signOnCrew(signSignOn(buildSignOn({ crewPublicKey: conductor.keys.publicKey, vehicleId }), conductor.keys.secretKey));

  // ----------------------------------------------------------------- helpers

  const person = (id) => state.passengers[id];
  const code = (p) => signTap(buildTap({ passengerPublicKey: p.keys.publicKey, vehicleId, doorId: 'ANY' }), p.keys.secretKey);

  function apply(p, result) {
    if (!p) return;
    if (result.ok && result.action === 'in') p.status = 'aboard';
    else if (result.ok && result.action === 'out') {
      p.status = 'done';
      p.fare = result.price?.amount ?? result.leg?.amount ?? null;
      p.km = (result.leg?.distanceM ?? 0) / 1000;
    } else if (result.reason === 'at_capacity') p.status = 'held';
  }

  async function present(text, who, p = null) {
    const started = performance.now();
    const result = await door.present({ text });
    const ms = performance.now() - started;
    apply(p, result);
    // The counter at the step: one body per person who actually came aboard.
    if (result.ok && result.action === 'in') await unit.countBoarding(1);
    note({ who, result, ms });
    return { result, ms };
  }

  const board = (id) => {
    const p = person(id);
    p.lastCode = code(p);
    return present(p.lastCode, p.name, p);
  };
  const alight = (id) => present(code(person(id)), person(id).name, person(id));

  // Where the bus is, by the stops on the route.
  function stopHere() {
    const at = unit.snapshot().odometerM ?? 0;
    return [...STOPS].reverse().find((s) => s.chainM <= at + 100) ?? STOPS[0];
  }

  // ------------------------------------------------------------------ road

  let drive = null;
  let seed = 7;

  async function driveFor(metres, { realMs = 3500 } = {}) {
    state.warping = true;
    emit();
    const start = unit.snapshot().odometerM;
    const target = start + metres;
    const began = performance.now();
    while (unit.snapshot().odometerM < target) {
      if (!drive || drive.index >= drive.fixes.length) {
        drive = { fixes: benchLeg(true, seed++).fixes, index: 0 };
      }
      const done = (unit.snapshot().odometerM - start) / metres;
      const elapsed = (performance.now() - began) / realMs;
      const batch = elapsed > done ? 12 : 3;
      for (let i = 0; i < batch && drive.index < drive.fixes.length; i += 1) {
        // One second of bus time per fix, on the page's clock too.
        skewMs += 1000;
        unit.ingestFix({ ...drive.fixes[drive.index], at: Date.now(), source: 'bench' });
        drive.index += 1;
      }
      await sleep(30);
    }
    state.warping = false;
    emit();
    await sleep(1100);
  }

  // ---------------------------------------------------------------- scenes

  async function rush(ids) {
    const began = performance.now();
    let count = 0;
    for (const id of ids) {
      const { result } = await board(id);
      if (result.ok) count += 1;
      state.rush = { count, ms: performance.now() - began };
      emit();
      await sleep(600);
    }
  }

  // Hajurama has no phone and pays the conductor in coins.
  async function cashRider(id, toStop = 'KOTESHWOR') {
    const p = person(id);
    const result = await door.issueCash({ fromStop: stopHere().code, toStop });
    await unit.countBoarding(1);
    if (result.ok) {
      p.status = 'cash';
      p.fare = result.ticket.amount;
      p.km = result.ticket.distanceM / 1000;
    }
    note({ who: `${p.name} (cash)`, result, ms: 0 });
    return result;
  }

  // Gita holds up one code for three people.
  async function familyCode() {
    const ids = [ID.GITA, ID.SON, ID.DAUGHTER];
    const text = buildGroup(ids.map((id) => code(person(id))));
    const started = performance.now();
    const result = await door.present({ text });
    const ms = performance.now() - started;
    result.results?.forEach((r, i) => apply(person(ids[i]), r));
    for (let i = 0; i < (result.boarded ?? 0); i += 1) await unit.countBoarding(1);
    note({ who: 'Gita + 2 children', result, ms });
    return result;
  }

  // Somebody slips aboard in the crush without tapping. The door counter sees
  // a body; the door sees no code.
  async function dodger(id) {
    const p = person(id);
    p.status = 'dodger';
    await unit.countBoarding(1);
    // Not a door event: the door never saw him. Only the counter did.
    note({ who: `${p.name} (no tap)`, counterOnly: true, result: { ok: false, reason: 'no_tap_counted', message: 'Counted at the step, no ride code' }, ms: 0 });
  }

  async function screenshot(fromId, byName) {
    const p = person(fromId);
    return present(p.lastCode ?? code(p), byName);
  }

  async function forged() {
    const victim = person(1);
    const thief = createKeypair();
    return present(signTap(buildTap({ passengerPublicKey: victim.keys.publicKey, vehicleId, doorId: 'ANY' }), thief.secretKey), 'Forged code');
  }

  async function wrongBus(id) {
    const p = person(id);
    return present(signTap(buildTap({ passengerPublicKey: p.keys.publicKey, vehicleId: 'BA3KHA0001', doorId: 'ANY' }), p.keys.secretKey), `${p.name}, other bus’s code`);
  }

  function setCapacity(n) {
    unit.setCapacity(n);
    note({ who: 'Meter', result: { ok: true, action: 'config', message: `Permit capacity ${n}` }, ms: 0 });
  }

  /*
    An inspector boards. Their phone verifies the meter's signed roster against
    the bus's public key from the register it downloaded this morning, counts
    heads, and checks passengers' live codes.
  */
  async function inspect(checkIds, extraHeads = 0) {
    const text = unit.rosterPayload();
    const verdict = verifyRoster(text, { vehiclePublicKey: unit.snapshot().vehiclePublicKey });
    const snap = unit.snapshot();
    const heads = snap.onboard.length + snap.cash.tickets + extraHeads;
    const checks = verdict.ok
      ? checkIds.map((id) => ({ name: person(id).name, ...checkRider(verdict.roster, code(person(id))) }))
      : [];
    state.inspection = { ok: verdict.ok, reason: verdict.reason, tally: verdict.ok ? tallyInspection(verdict.roster, heads) : null, checks, rosterChars: text.length };
    emit();
    return state.inspection;
  }

  // Caught: the conductor sells the dodger a cash ticket on the spot.
  async function settleDodger(id) {
    const p = person(id);
    const result = await door.issueCash({ fromStop: STOPS[0].code, toStop: 'KOTESHWOR' });
    if (result.ok) {
      p.status = 'caught';
      p.fare = result.ticket.amount;
      p.km = result.ticket.distanceM / 1000;
    }
    note({ who: `${p.name} (caught, pays cash)`, result, ms: 0 });
    if (state.inspection) state.inspection = { ...state.inspection, resolved: true };
    emit();
    return result;
  }

  async function endTrip() {
    const closing = unit.snapshot();
    state.crew.counted = closing.counted;
    state.crew.recorded = closing.closed.length + closing.onboard.length + closing.cash.tickets;
    state.crew.tripId = closing.tripId;
    await unit.endTrip();
    const stranded = state.passengers.filter((p) => p.status === 'aboard');
    for (const p of stranded) {
      p.status = 'unclosed';
      p.fare = closing.tariff?.unclosedLegFare ?? 25;
    }
    note({ who: 'Meter', result: { ok: true, action: 'config', message: `Trip closed · ${stranded.length} never tapped out, charged the cap` }, ms: 0 });
    return stranded.length;
  }

  const walletKey = (p) => (p.wallet === ID.GITA ? gita.root.publicKey : p.keys.publicKey);

  // The signal returns: Gita's phone and the meter upload, as they would.
  async function signalBack() {
    state.signal = true;
    emit();
    const backend = await backendReady;
    if (!backend) throw new Error('The in-browser backend did not start.');

    // Wallets that exist before today: Gita's and the conductor's.
    await backend.registerWallet(gita.root.publicKey, DEMO_CREDIT_NPR);
    await backend.registerWallet(conductor.keys.publicKey, 0);
    // Gita's phone links today's key and both companions to her wallet.
    const link = (key) => signLink(buildLink({ rootPublicKey: gita.root.publicKey, pseudonymPublicKey: key.publicKey, day: today }), gita.root.secretKey, key.secretKey);
    await backend.handle({ devicePublicKey: gita.root.publicKey, keyLinks: familyKeys.map(link) });

    const keys = [...new Set(state.passengers.map(walletKey)), conductor.keys.publicKey];
    const before = await backend.balances(keys);

    const snap = unit.snapshot();
    const result = await sync.syncMeter({ vehicleId, publicKey: snap.vehiclePublicKey, capacity: snap.capacity, firmware: 'bhada-demo' });
    await unit.refreshQueue?.();

    const after = await backend.balances(keys);
    for (const p of state.passengers) {
      const key = walletKey(p);
      if (after.has(key) && p.status !== 'waiting' && p.status !== 'held') {
        p.balance = { before: before.get(key) ?? DEMO_CREDIT_NPR, after: after.get(key), shared: p.wallet !== p.id };
      }
    }
    const trip = (result.tripResults ?? []).find((r) => r?.tripId === state.crew.tripId) ?? (result.tripResults ?? [])[0] ?? null;
    state.crew.bonus = {
      outcome: trip?.outcome ?? trip?.reason ?? 'none',
      amount: trip?.amount ?? 0,
      reasons: trip?.reasons ?? [],
      before: before.get(conductor.keys.publicKey) ?? 0,
      after: after.get(conductor.keys.publicKey) ?? 0,
    };
    state.settlement = {
      ...result,
      takings: await backend.takings(vehicleId),
      evidence: state.crew.tripId ? await backend.evidence(state.crew.tripId) : null,
    };
    emit();
    return state.settlement;
  }

  async function replayUpload() {
    const backend = await backendReady;
    if (!state.firstUpload || !backend) return null;
    const keys = [...new Set(state.passengers.map(walletKey)), conductor.keys.publicKey];
    const before = await backend.balances(keys);
    const [, answer] = await backend.handle(state.firstUpload);
    const after = await backend.balances(keys);
    const moved = keys.reduce((sum, key) => sum + Math.abs((after.get(key) ?? 0) - (before.get(key) ?? 0)), 0);
    state.replay = {
      sent: (state.firstUpload.legs ?? []).length + (state.firstUpload.cashTickets ?? []).length,
      replays: [...(answer.legResults ?? []), ...(answer.cashResults ?? [])].filter((r) => r?.reason === 'replay').length,
      moved,
    };
    emit();
    return state.replay;
  }

  return {
    state: () => ({ ...state }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    meter: unit,
    door,
    vehicleId,
    person,
    present,
    board,
    alight,
    driveFor,
    rush,
    cashRider,
    familyCode,
    dodger,
    screenshot,
    forged,
    wrongBus,
    setCapacity,
    inspect,
    settleDodger,
    endTrip,
    signalBack,
    replayUpload,
    backendReady,
  };
}
