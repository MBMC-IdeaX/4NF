import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { FleetSimulationEngine } from '../../src/lib/fleet-simulator.js';
import { useRandomSource } from '../../protocol/random.mjs';
import { createKeypair } from '../../protocol/token.mjs';
import { buildLeg, signLeg } from '../../protocol/leg.mjs';
import { TARIFF, priceDistance } from '../../protocol/meter.mjs';
import { openBackend, handleSync } from '../../scripts/lib/pg-backend.mjs';

useRandomSource((n) => new Uint8Array(randomBytes(n)));
const mockStorage = `data:text/javascript,${encodeURIComponent('export const db = async () => globalThis.workflowDB; export const currentTripId = async () => "TESTTRIP";')}`;
async function clientModule(path, substitutions = {}) {
  const url = new URL(path, import.meta.url);
  let source = await readFile(url, 'utf8');
  source = source.replace(/from ['"]([^'"]+)['"]/g, (whole, specifier) => {
    if (specifier.includes('storage/db')) return `from '${mockStorage}'`;
    if (substitutions[specifier]) return `from '${substitutions[specifier]}'`;
    if (specifier.startsWith('.')) return `from '${new URL(specifier, url).href}'`;
    return whole;
  }).replaceAll('import.meta.env', 'globalThis.workflowEnv');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
function memoryDB() {
  const books = new Map();
  const book = (name) => { if (!books.has(name)) books.set(name, new Map()); return books.get(name); };
  const database = {
    get: async (name, key) => structuredClone(book(name).get(key)),
    getAll: async (name) => [...book(name).values()].map((row) => structuredClone(row)),
    put: async (name, row, key = row.legId ?? row.nonce ?? row.seq) => { book(name).set(key, structuredClone(row)); },
    transaction(names) {
      const objectStore = (name) => ({ get: (key) => database.get(name, key), put: (row, key) => database.put(name, row, key) });
      return { objectStore, store: objectStore(names), done: Promise.resolve() };
    },
  };
  return database;
}

test('simulation follows uneven chainage, pauses at stops, and has no import timer', () => {
  let now = 1000;
  const routes = [{ id: 'R', distanceKm: 10, stops: [{ km: 0, lat: 0, lon: 0 }, { km: 1, lat: 1, lon: 1 }, { km: 10, lat: 10, lon: 10 }], buses: [{ id: 'BUS1', direction: 'forward', progress: 0.5, capacity: 20, occupiedSeats: 10 }] }];
  const engine = new FleetSimulationEngine({ routes, now: () => now, random: () => 0.9 });
  assert.equal(engine.timer, null);
  assert.equal(engine.getSnapshot().allBuses[0].lat, 5);
  const initial = engine.getSnapshot().allBuses[0];
  now += 3600000;
  engine.tick();
  const resumed = engine.getSnapshot().allBuses[0];
  assert.ok((resumed.progress - initial.progress) * 10000 <= 42 * 1000 / 3600 * 2);
  assert.equal(resumed.occupiedSeats, initial.occupiedSeats);
  const unsubscribe = engine.subscribe(() => {});
  assert.ok(engine.timer);
  unsubscribe();
  assert.equal(engine.timer, null);
  const bus = engine.routes[0].buses[0];
  bus.progress = 0.0999;
  now += 1500;
  engine.updateBusPhysics(bus, engine.routes[0], 2);
  assert.equal(bus.progress, 0.1);
  assert.equal(bus.speedKmh, 0);
  assert.equal(bus.occupiedSeats, 12);
});

test('rider scheduler registers a metered-only day key and a later companion', async () => {
  globalThis.workflowDB = memoryDB();
  globalThis.workflowEnv = { VITE_SYNC_URL: '/sync' };
  const identityUrl = new URL('../../src/device/identity.js', import.meta.url);
  // Keep one module instance for the outbox and upload path.
  let identitySource = await readFile(identityUrl, 'utf8');
  identitySource = identitySource.replace("'../storage/db'", `'${mockStorage}'`).replace(/from '(\.\.\/\.\.\/protocol\/[^']+)'/g, (_, path) => `from '${new URL(path, identityUrl).href}'`);
  const identitySpecifier = `data:text/javascript;base64,${Buffer.from(identitySource).toString('base64')}`;
  const identity = await import(identitySpecifier);
  const fleetMock = `data:text/javascript,${encodeURIComponent('export const currentVehicle = () => ({ id: "DEMOBUS01" });')}`;
  const sync = await clientModule('../../src/device/sync.js', { './identity': identitySpecifier, './fleet': fleetMock });
  const outbox = await clientModule('../../src/device/outbox.js', { './identity': identitySpecifier });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return { ok: true, json: async () => ({ linkResults: body.keyLinks.map(() => ({ ok: true })), results: [] }) };
  };
  try {
    assert.equal(await outbox.pendingPassenger(), 1);
    await sync.syncPassenger();
    assert.equal(await outbox.pendingPassenger(), 0);
    await identity.noteCompanions(1);
    assert.equal(await outbox.pendingPassenger(), 1);
    await sync.syncPassenger();
    assert.equal(requests[1].keyLinks.length, 1);
    assert.equal(await outbox.pendingPassenger(), 0);
    const stored = await globalThis.workflowDB.get('identity', 'me');
    await identity.loadIdentity({ now: (stored.day + 1) * 86400 });
    const tomorrow = await globalThis.workflowDB.get('identity', 'me');
    assert.equal(identity.pendingKeyLinks(tomorrow).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('receipt authentication rejects forged arithmetic and waits for trusted registry keys', async () => {
  globalThis.workflowEnv = {};
  const auth = await clientModule('../../src/device/receipt-auth.js');
  const bus = createKeypair(); const passenger = createKeypair();
  const priced = priceDistance(1000);
  const leg = buildLeg({ vehicleId: 'DEMOBUS01', tripId: 'TESTTRIP', legId: 'TESTLEG', passengerPublicKey: passenger.publicKey, boardDoorId: 'A', alightDoorId: 'B', boardOdoM: 0, alightOdoM: 1000, distanceM: 1000, distanceSource: 'odometer', boardAt: 100, alightAt: 200, concession: 'none', amount: priced.amount, tariffCode: TARIFF.code });
  const receipt = signLeg(leg, bus.secretKey);
  const context = { passengerPublicKey: passenger.publicKey, vehicleId: leg.vehicleId, legId: leg.legId };
  assert.equal(auth.authenticateRecord(receipt, leg, null, context).reason, 'verification_pending');
  assert.equal(auth.authenticateRecord(receipt, leg, bus.publicKey, context).ok, true);
  const forged = signLeg(leg, createKeypair().secretKey);
  assert.equal(auth.authenticateRecord(forged, leg, bus.publicKey, context).reason, 'bad_signature');
  assert.equal(auth.authenticateRecord(receipt, leg, bus.publicKey, { ...context, legId: 'OTHER' }).reason, 'record_mismatch');
});

test('HTTP-success event failures are explicit and retrying acknowledged events is duplicate-safe', async () => {
  const { db } = await openBackend();
  const bus = createKeypair();
  const payload = { devicePublicKey: bus.publicKey, meter: { vehicleId: 'DEMOBUS01', publicKey: bus.publicKey, capacity: 30 }, doorEvents: [{ eventId: 'DEVICE:1', at: '2026-10-03T00:00:00Z', kind: 'locked' }], meterEvents: [{ eventId: 'DEVICE:2', at: '2026-10-03T00:00:00Z', kind: 'power_lost', moving: true }] };
  try {
    const [status, first] = await handleSync(db, payload);
    assert.equal(status, 200);
    assert.equal(first.doorEventsResult.ok, true);
    assert.equal(first.meterEventsResult.ok, true);
    await handleSync(db, payload);
    assert.equal((await db.query("select count(*)::integer as n from door_events where event_id = 'DEVICE:1'")).rows[0].n, 1);
    assert.equal((await db.query("select count(*)::integer as n from meter_events where event_id = 'DEVICE:2'")).rows[0].n, 1);
    const [, failed] = await handleSync(db, { ...payload, doorEvents: [{ ...payload.doorEvents[0], eventId: 'DEVICE:3', at: 'invalid date' }] });
    assert.equal(failed.doorEventsResult.ok, false);
    assert.equal(failed.doorEventsResult.reason, 'server_error');
    assert.equal(failed.meterEventsResult.ok, true);
  } finally { await db.close(); }
});

async function syncFixture() {
  globalThis.workflowDB = memoryDB();
  globalThis.workflowEnv = { VITE_SYNC_URL: '/sync' };
  const identityUrl = new URL('../../src/device/identity.js', import.meta.url);
  let source = await readFile(identityUrl, 'utf8');
  source = source.replace("'../storage/db'", `'${mockStorage}'`).replace(/from '(\.\.\/\.\.\/protocol\/[^']+)'/g, (_, path) => `from '${new URL(path, identityUrl).href}'`);
  const identitySpecifier = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const fleetMock = `data:text/javascript,${encodeURIComponent('export const currentVehicle = () => ({ id: "DEMOBUS01" });')}`;
  const sync = await clientModule('../../src/device/sync.js', { './identity': identitySpecifier, './fleet': fleetMock });
  const outbox = await clientModule('../../src/device/outbox.js', { './identity': identitySpecifier });
  return { sync, outbox, database: globalThis.workflowDB };
}

test('meter retains failed tape, advances only acknowledged cursors, and shares one upload lock', async () => {
  const { sync, database, outbox } = await syncFixture();
  await database.put('deviceEvents', { seq: 1, at: 1000, kind: 'door', text: 'locked' });
  await database.put('deviceEvents', { seq: 2, at: 2000, kind: 'power', power: 'power_lost' });
  assert.equal(await outbox.pendingVehicleEvidence({ includeMeter: true }), 2);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ doorEventsResult: { ok: false, reason: 'server_error' }, meterEventsResult: { ok: true }, meterResult: { ok: true } }) }; };
  try {
    const args = { vehicleId: 'DEMOBUS01', publicKey: 'BUSKEY', capacity: 42 };
    const first = sync.syncMeter(args); const second = sync.syncMeter(args);
    assert.equal(first, second);
    await assert.rejects(first, /not acknowledged/);
    assert.equal(calls, 1);
    assert.equal(await database.get('meter', 'doorTapeCursor'), undefined);
    assert.equal(await database.get('meter', 'meterTapeCursor'), 2);
    assert.equal(await outbox.pendingVehicleEvidence({ includeMeter: true }), 1);
    globalThis.fetch = async (_, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(payload.doorEvents[0].eventId, 'BUSKEY:1');
      assert.equal(payload.meterEvents.length, 0);
      return { ok: true, json: async () => ({ doorEventsResult: { ok: true }, meterResult: { ok: true } }) };
    };
    await sync.syncMeter(args);
    assert.equal(await database.get('meter', 'doorTapeCursor'), 1);
    assert.equal(await outbox.pendingVehicleEvidence({ includeMeter: true }), 0);
  } finally { globalThis.fetch = original; }
});

test('301 cash tickets drain in bounded batches before trip close and preserve partial progress', async () => {
  const { sync, database } = await syncFixture();
  for (let i = 0; i < 301; i++) await database.put('legs', { legId: `CASH${i}`, status: 'cash', cashQr: `CASH${i}`, synced: 0 });
  await database.put('meter', ['TCASH'], 'closedTrips');
  const original = globalThis.fetch;
  const sizes = []; let failSecond = true;
  globalThis.fetch = async (_, options) => {
    const payload = JSON.parse(options.body);
    sizes.push(payload.cashTickets?.length ?? 0);
    if (sizes.length === 2 && failSecond) throw new Error('radio lost');
    if (payload.closedTrips?.length) assert.equal((await database.getAll('legs')).filter((row) => !row.synced).length, 0);
    return { ok: true, json: async () => ({ meterResult: { ok: true }, cashResults: (payload.cashTickets ?? []).map((ticketId) => ({ ticketId, ok: true })), tripResults: (payload.closedTrips ?? []).map((tripId) => ({ tripId, ok: true })) }) };
  };
  try {
    const args = { vehicleId: 'DEMOBUS01', publicKey: 'BUSKEY', capacity: 42 };
    await assert.rejects(sync.syncMeter(args), /Partial upload saved/);
    assert.equal((await database.getAll('legs')).filter((row) => row.synced).length, 150);
    assert.deepEqual(await database.get('meter', 'closedTrips'), ['TCASH']);
    failSecond = false;
    await sync.syncMeter(args);
    assert.equal((await database.getAll('legs')).filter((row) => row.synced).length, 301);
    assert.deepEqual(await database.get('meter', 'closedTrips'), []);
    assert.deepEqual(sizes, [150, 150, 150, 1, 0]);
  } finally { globalThis.fetch = original; }
});

test('temporary claim errors and unknown-leg races retain evidence; documented refusals are final', async () => {
  const { sync, database } = await syncFixture();
  await database.put('meter', [{ legId: 'CLAIM1', claim: 'SIGNEDCLAIM', sent: 0 }], 'passengerClaims');
  const original = globalThis.fetch;
  let reason = 'server_error';
  globalThis.fetch = async (_, options) => {
    const payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ linkResults: payload.keyLinks.map(() => ({ ok: true })), disputeResults: [{ legId: 'CLAIM1', ok: false, reason }], results: [] }) };
  };
  try {
    await assert.rejects(sync.syncPassenger(), /Backend could not finish/);
    assert.equal((await database.get('meter', 'passengerClaims'))[0].sent, 0);
    reason = 'unknown_leg'; await sync.syncPassenger();
    assert.equal((await database.get('meter', 'passengerClaims'))[0].sent, 0);
    reason = 'phone_was_alive'; await sync.syncPassenger();
    const row = (await database.get('meter', 'passengerClaims'))[0];
    assert.equal(row.sent, 1); assert.equal(row.outcome, reason); assert.equal(row.claim, 'SIGNEDCLAIM');
  } finally { globalThis.fetch = original; }
});


test('a stalled request times out and preserves its queued claim', { timeout: 25000 }, async () => {
  const { sync, database } = await syncFixture();
  await database.put('meter', [{ legId: 'TIMEOUT1', claim: 'SIGNEDCLAIM', sent: 0 }], 'passengerClaims');
  const original = globalThis.fetch;
  globalThis.fetch = async (_, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  try {
    await assert.rejects(sync.syncPassenger(), (error) => error.name === 'AbortError');
    assert.equal((await database.get('meter', 'passengerClaims'))[0].sent, 0);
  } finally { globalThis.fetch = original; }
});
