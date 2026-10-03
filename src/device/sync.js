// Pushing queued fares to the backend when a device finds a network.
//
// Both roles use this. The passenger uploads what it signed; the conductor
// uploads what it collected. Whichever reaches a network first settles the
// fare, and the other one's upload is answered with `replay` — which is the
// correct answer, not an error.

import { db, currentTripId } from '../storage/db';
import { currentVehicle } from './fleet';
import { loadIdentity, keyLinkFor, accountLinkFor, companionLinksFor } from './identity';

const ENDPOINT = import.meta.env.VITE_SYNC_URL ?? '';
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export function syncConfigured() {
  return Boolean(ENDPOINT);
}

/*
  How many signed items go in one request.

  The backend refuses a batch of more than MAX_BATCH (500) items and will not
  read a body over 1 MB, and a refused upload is retried unchanged — so a door
  phone that queued 600 rides through a day with no signal would be refused on
  every attempt, for ever. Uploads go in chunks of this size instead: 150 signed
  receipts with their taps and concession cards stay far inside both limits.
*/
export const UPLOAD_CHUNK = 150;

export function chunked(items, size = UPLOAD_CHUNK) {
  const out = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

export function online() {
  return navigator.onLine;
}

async function post(payload) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ANON_KEY ? { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Sync refused with ${response.status}.`);
  return response.json();
}

/*
  A fare is cleared from the queue when the server has ruled on it, whether it
  settled it or rejected it as a replay. Anything else — a network error, a
  server error — leaves the row queued so the next attempt retries it.
*/
function isFinal(result) {
  return result?.ok === true || result?.reason === 'replay';
}

const CLAIMS_KEY = 'passengerClaims';

/*
  Dead-phone claims, waiting for a network.

  A claim is filed on a phone that has just come back from flat, so it is queued
  rather than sent, exactly like a fare. It is cleared on any final answer — a
  refund, a refusal, a replay — because every one of those is the backend having
  ruled, and re-arguing a settled claim is not a thing a device gets to do.
*/
async function pendingClaims(database) {
  const rows = (await database.get('meter', CLAIMS_KEY)) ?? [];
  return rows.filter((row) => !row.sent);
}

async function clearClaims(database, sent, results) {
  if (sent.length === 0) return 0;
  const byLeg = new Map((results ?? []).map((result) => [result?.legId, result]));
  const rows = (await database.get('meter', CLAIMS_KEY)) ?? [];
  let cleared = 0;
  const next = rows.map((row) => {
    const result = byLeg.get(row.legId);
    // Anything but a transport failure is final: the claim was judged.
    if (!sent.some((s) => s.legId === row.legId) || !result) return row;
    cleared += 1;
    return { ...row, sent: 1, outcome: result.reason ?? (result.ok ? 'refunded' : 'refused'), refund: result.refund ?? 0 };
  });
  await database.put('meter', next, CLAIMS_KEY);
  return cleared;
}

export async function syncPassenger() {
  if (!syncConfigured()) throw new Error('No sync endpoint configured. Set VITE_SYNC_URL.');
  const identity = await loadIdentity();
  const database = await db();
  const queued = (await database.getAll('payments')).filter((row) => !row.settled);
  const claims = await pendingClaims(database);
  // Today's day-key needs filing even on a day this phone owes nothing. On a
  // metered bus the door uploads the ride, not the passenger, so if the link
  // waited for the passenger to have a fare of their own to send it would
  // arrive after the leg it was needed for — and that leg settles against a
  // wallet nobody can find.
  const linkPending = Boolean(identity.masterSeed) && identity.day !== identity.linkedDay;
  if (queued.length === 0 && claims.length === 0 && !linkPending) {
    return { settled: 0, rejected: 0, cleared: 0, refunded: 0 };
  }

  const response = await post({
    devicePublicKey: identity.publicKey,
    tickets: queued.map((row) => row.qrText),
    disputes: claims.map((row) => row.claim),
    // Today's key, and which wallet it spends from. Sent every time rather than
    // tracked: it is one short string, the backend answers `already_registered`
    // for a day it has seen, and a device that guessed wrong about what the
    // backend knows would have its fares refused as an unknown passenger.
    keyLinks: [keyLinkFor(identity), ...companionLinksFor(identity)].filter(Boolean),
  });
  await clearClaims(database, claims, response.disputeResults);

  // The backend has this day-key on file now, so it is not sent again until the
  // date rolls over in Kathmandu.
  if (response.linkResults?.[0]?.ok) {
    const store = await database.get('identity', 'me');
    await database.put('identity', { ...store, linkedDay: identity.day }, 'me');
  }

  if (queued.length === 0) {
    return { settled: 0, rejected: 0, cleared: 0, refunded: response.refunded ?? 0 };
  }

  const byNonce = new Map(response.results.map((result) => [result?.nonce, result]));
  const tx = database.transaction(['payments', 'identity'], 'readwrite');
  const payments = tx.objectStore('payments');
  let cleared = 0;
  let clearedValue = 0;

  for (const row of queued) {
    if (!isFinal(byNonce.get(row.nonce))) continue;
    await payments.put({ ...row, settled: 1 });
    cleared += 1;
    clearedValue += row.amount;
  }

  // The offline allowance only frees up for fares the server has actually
  // ruled on. Freeing it optimistically would let a device spend past the cap.
  const store = tx.objectStore('identity');
  const current = await store.get('me');
  await store.put(
    {
      ...current,
      unsettledTotal: Math.max(0, current.unsettledTotal - clearedValue),
      lastSettlementAt: Math.floor(Date.now() / 1000),
    },
    'me',
  );
  await tx.done;

  return { settled: response.settled, rejected: response.rejected, cleared, refunded: response.refunded ?? 0 };
}

/*
  Join this phone's wallet to the signed-in login.

  The access token travels in the body, not the Authorization header, because
  the header carries the project key the function is called with; the
  function asks Supabase Auth who the token belongs to.
*/
// With `move`, a login whose money is on another phone carries it to this one
// (move_wallet, migration 0029). The old phone's later rides are refused.
export async function linkWalletToAccount({ accessToken, userId, move = false }) {
  if (!syncConfigured()) throw new Error('No sync endpoint configured. Set VITE_SYNC_URL.');
  const identity = await loadIdentity();
  const response = await post({
    devicePublicKey: identity.publicKey,
    accountLink: { link: accountLinkFor(identity, userId), accessToken, ...(move ? { move: true } : {}) },
    keyLinks: [keyLinkFor(identity), ...companionLinksFor(identity)].filter(Boolean),
  });
  return response.accountResult ?? { ok: false, reason: 'server_error' };
}

export async function walletKey() {
  const identity = await loadIdentity();
  return identity.rootPublicKey;
}

export async function syncConductor() {
  if (!syncConfigured()) throw new Error('No sync endpoint configured. Set VITE_SYNC_URL.');
  const identity = await loadIdentity();
  const tripId = await currentTripId();
  const database = await db();
  const queued = (await database.getAll('ledger')).filter((row) => !row.synced);
  if (queued.length === 0) return { settled: 0, rejected: 0, cleared: 0 };

  const total = { settled: 0, rejected: 0, cleared: 0 };
  for (const [index, batch] of chunked(queued).entries()) {
    let response;
    try {
      response = await post({
        devicePublicKey: identity.publicKey,
        tripId,
        tickets: batch.map((row) => row.qrText).filter(Boolean),
      });
    } catch (problem) {
      // What already went up is settled and cleared; the rest waits for the
      // next attempt. Only a first chunk that fails is a failed sync.
      if (index === 0) throw problem;
      break;
    }

    const byNonce = new Map(response.results.map((result) => [result?.nonce, result]));
    const tx = database.transaction('ledger', 'readwrite');
    const store = tx.objectStore('ledger');
    for (const row of batch) {
      if (!isFinal(byNonce.get(row.nonce))) continue;
      await store.put({ ...row, synced: 1 });
      total.cleared += 1;
    }
    await tx.done;
    total.settled += response.settled ?? 0;
    total.rejected += response.rejected ?? 0;
  }

  return total;
}

/*
  The meter's own upload.

  Three things go up together, on purpose: the vehicle's key so the backend can
  verify anything at all, the signed leg receipts, and the door tape. Sending
  them separately would mean a bus that gets thirty seconds of signal under a
  flyover uploads its fares and loses its overload record, which is exactly the
  half a dishonest operator would choose.
*/
const DOOR_KINDS = { door: 'locked', override: 'override_on', tamper: 'tamper' };

// The box's own power tape rides along beside the door tape, in its own book:
// door_events is the interlock record a regulator reads, and a charger that
// went away is a fact about the box rather than about a door.
function meterEventKind(event) {
  return event.kind === 'power' ? (event.power ?? null) : null;
}

function doorEventKind(event) {
  if (event.kind === 'override') return event.text?.includes('restored') ? 'override_off' : 'override_on';
  if (event.kind === 'tamper') return 'tamper';
  // A one-door bus at its permit refuses boarding and keeps its door open for
  // people getting off: on the regulator's tape that is `refused`, not `locked`.
  if (event.kind === 'door') return event.reason === 'exit_only' ? 'refused' : event.severity === 'warn' ? 'locked' : 'unlocked';
  return null;
}

/*
  What a device holding legs owes the backend: every closed receipt, with the
  passenger's tap beside it when this device has it, and — for rides this
  device opened but another door closed — the tap on its own. The backend
  settles a receipt only once the tap is on file, so a receipt answered
  `awaiting_tap` stays queued here and goes up again next time.
*/
async function pendingLegs(database) {
  const rows = await database.getAll('legs');
  const receipts = rows.filter((row) => row.status === 'closed' && !row.synced && row.receipt);
  const taps = rows.filter((row) => row.tapQr && !row.tapFiled && !(row.status === 'closed' && row.receipt));
  // Fares taken in cash at this door (CT1, protocol/cash.mjs): recorded, never
  // charged, and cleared once the backend has them.
  const cash = rows.filter((row) => row.status === 'cash' && !row.synced && row.cashQr);
  return { receipts, taps, cash };
}

async function uploadLegs(database, payload) {
  const { receipts, taps, cash } = await pendingLegs(database);
  const items = [
    ...receipts.map((row) => ({ receipt: row })),
    ...taps.map((row) => ({ tap: row })),
  ];
  // A meter with nothing queued still makes one call: it is how a new box gets
  // its key on file and how the door tape goes up.
  const batches = items.length > 0 ? chunked(items) : [[]];

  const total = { settled: 0, rejected: 0, awaiting: 0, cleared: 0, taps: 0, cash: 0, crewResults: [], tripResults: [], countResults: [] };
  for (const [index, batch] of batches.entries()) {
    // The tape, the crew and the closed trips ride with the first chunk only;
    // later chunks carry the vehicle key so every receipt can be verified.
    const extra = index === 0
      ? payload
      : { devicePublicKey: payload.devicePublicKey, ...(payload.meter ? { meter: payload.meter } : {}) };
    let result;
    try {
      result = await uploadLegBatch(
        database,
        extra,
        batch.filter((item) => item.receipt).map((item) => item.receipt),
        batch.filter((item) => item.tap).map((item) => item.tap),
        // Cash tickets ride with the first chunk, beside the trip closes they
        // count toward.
        index === 0 ? cash.slice(0, UPLOAD_CHUNK) : [],
      );
    } catch (problem) {
      // The first chunk carried the tape; if it failed, nothing moved and the
      // caller must keep its cursors. A later chunk failing leaves its rides
      // queued for next time, and what already went up stays settled.
      if (index === 0) throw problem;
      break;
    }
    total.settled += result.settled;
    total.rejected += result.rejected;
    total.awaiting += result.awaiting;
    total.cleared += result.cleared;
    total.taps += result.taps;
    total.crewResults.push(...result.crewResults);
    total.tripResults.push(...result.tripResults);
    total.countResults.push(...result.countResults);
    total.cash += result.cash;
    if (index === 0) total.meterResult = result.meterResult;
  }
  return total;
}

async function uploadLegBatch(database, payload, receipts, taps, cash = []) {
  const response = await post({
    ...payload,
    legs: receipts.map((row) => ({
      receipt: row.receipt,
      tap: row.tapQr ?? null,
      // Only the backend holds the register of issuing offices, so the card
      // travels with the receipt rather than being judged at the door.
      attestation: row.attestationQr ?? null,
    })),
    taps: taps.map((row) => ({ legId: row.legId, tap: row.tapQr })),
    ...(cash.length > 0 ? { cashTickets: cash.map((row) => row.cashQr) } : {}),
  });

  const byLeg = new Map((response.legResults ?? []).map((result) => [result?.legId, result]));
  const byTap = new Map((response.tapResults ?? []).map((result) => [result?.legId, result]));
  const tx = database.transaction('legs', 'readwrite');
  const store = tx.objectStore('legs');
  let cleared = 0;
  let awaiting = 0;
  for (const row of receipts) {
    const result = byLeg.get(row.legId);
    if (result?.reason === 'awaiting_tap') awaiting += 1;
    if (!isFinal(result)) continue;
    await store.put({ ...row, synced: 1, tapFiled: 1 });
    cleared += 1;
  }
  for (const row of taps) {
    if (byTap.get(row.legId)?.ok) await store.put({ ...row, tapFiled: 1 });
  }
  // A cash ticket is done once it is on file, whether this upload put it there
  // or an earlier one did.
  const byTicket = new Map((response.cashResults ?? []).map((result) => [result?.ticketId, result]));
  let cashRecorded = 0;
  for (const row of cash) {
    const result = byTicket.get(row.legId);
    if (result?.ok || result?.reason === 'replay') {
      await store.put({ ...row, synced: 1 });
      cashRecorded += 1;
    }
  }
  await tx.done;

  return {
    settled: response.legsSettled ?? 0,
    rejected: (response.legsRejected ?? 0) - awaiting,
    awaiting,
    cleared,
    taps: taps.length,
    // The meter's own verdicts travel back untouched: the caller decides what
    // to clear from the crew and trip queues, exactly as it does for legs.
    crewResults: response.crewResults ?? [],
    // What the backend said about this phone being the bus (0034).
    meterResult: response.meterResult ?? null,
    tripResults: response.tripResults ?? [],
    countResults: response.countResults ?? [],
    cash: cashRecorded,
  };
}

export async function syncMeter({ vehicleId, publicKey, capacity, firmware }) {
  if (!syncConfigured()) throw new Error('No sync endpoint configured. Set VITE_SYNC_URL.');
  const database = await db();

  const events = await database.getAll('deviceEvents');
  const lastSent = (await database.get('meter', 'doorTapeCursor')) ?? 0;
  const tape = events
    .filter((event) => event.seq > lastSent && doorEventKind(event))
    .slice(0, 200);

  const lastPower = (await database.get('meter', 'meterTapeCursor')) ?? 0;
  const powerTape = events
    .filter((event) => event.seq > lastPower && meterEventKind(event))
    .slice(0, 200);

  /*
    Who is working, and which trips have closed.

    Both go up with the fares for the same reason the door tape does: a bus that
    gets thirty seconds of signal under a flyover would otherwise upload the
    rides and lose the record of who ran them, which is the half that decides
    whether anyone gets paid.
  */
  const crew = await database.get('meter', 'crew');
  const closedTrips = (await database.get('meter', 'closedTrips')) ?? [];
  // What the door counter saw on each closed trip, sent with the closes so a
  // trip is never judged without its count (migration 0030).
  const tripCounts = (await database.get('meter', 'tripCounts')) ?? [];

  // Even with nothing queued this call is worth making: it is how a brand new
  // box gets its key on file.
  const result = await uploadLegs(database, {
    devicePublicKey: publicKey,
    // The owner's one-time setup code (0034), sent until the backend has bound
    // this phone's key to the bus; after that it is spent and ignored.
    meter: { vehicleId, publicKey, capacity, firmware, ...(currentVehicle().enrolCode ? { enrolCode: currentVehicle().enrolCode } : {}) },
    doorEvents: tape.map((event) => ({
      at: new Date(event.at).toISOString(),
      kind: doorEventKind(event),
      tripId: event.tripId ?? null,
      note: event.text,
    })),
    meterEvents: powerTape.map((event) => ({
      at: new Date(event.at).toISOString(),
      kind: meterEventKind(event),
      tripId: event.tripId ?? null,
      moving: event.moving ?? null,
      note: event.text,
    })),
    ...(crew?.signOn && crew.trips?.length > 0
      ? { crew: { signOn: crew.signOn, tripIds: crew.trips } }
      : {}),
    ...(tripCounts.length > 0 ? { tripCounts } : {}),
    ...(closedTrips.length > 0 ? { closedTrips } : {}),
  });

  if (tape.length > 0) {
    await database.put('meter', tape[tape.length - 1].seq, 'doorTapeCursor');
  }
  if (powerTape.length > 0) {
    await database.put('meter', powerTape[powerTape.length - 1].seq, 'meterTapeCursor');
  }
  /*
    A trip is cleared once the backend has ruled on it, whether it paid the
    bonus or recorded why it did not — both are answers. `no_crew` is an answer
    too: a trip run with nobody signed on earns nothing and re-asking will not
    change that. Anything else leaves the trip queued for the next attempt.
  */
  if (closedTrips.length > 0) {
    const ruled = new Set((result.tripResults ?? [])
      .filter((r) => r?.ok === true || r?.reason === 'replay' || r?.reason === 'no_crew')
      .map((r) => r.tripId));
    const left = closedTrips.filter((tripId) => !ruled.has(tripId));
    await database.put('meter', left, 'closedTrips');
  }
  if (tripCounts.length > 0) {
    const onFile = new Set((result.countResults ?? []).filter((r) => r?.ok).map((r) => r.tripId));
    await database.put('meter', tripCounts.filter((entry) => !onFile.has(entry.tripId)), 'tripCounts');
  }
  // Trips the backend has on file do not need re-noting. A refusal is kept, so
  // a stale sign-on is retried until the crew scans a fresh one or signs off.
  if (crew?.trips?.length > 0) {
    const noted = new Set((result.crewResults ?? [])
      .filter((r) => r?.ok === true)
      .map((r) => r.tripId));
    const left = crew.trips.filter((tripId) => !noted.has(tripId));
    if (left.length !== crew.trips.length) {
      await database.put('meter', { ...crew, trips: left }, 'crew');
    }
  }
  // What the backend said about this phone being the bus, for the Crew app to
  // show: bound, still waiting for a setup code, or refused.
  if (result.meterResult) {
    await database.put('meter', { ...result.meterResult, at: Date.now() }, 'unitStatus');
  }
  return { ...result, tape: tape.length, powerTape: powerTape.length };
}

// A door phone's own upload. Two door phones with no signal between them each
// hold half of some rides — one has the tap, the other the receipt — and either
// may be the first to find a network.
export async function syncTerminal({ vehiclePublicKey }) {
  if (!syncConfigured()) throw new Error('No sync endpoint configured. Set VITE_SYNC_URL.');
  const database = await db();
  const { receipts, taps, cash } = await pendingLegs(database);
  if (receipts.length === 0 && taps.length === 0 && cash.length === 0) return { settled: 0, rejected: 0, awaiting: 0, cleared: 0, taps: 0, cash: 0 };
  return uploadLegs(database, { devicePublicKey: vehiclePublicKey });
}
