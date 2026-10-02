// Getting the rides off the bus and into the database.
//
// The validator decides every ride on its own, offline, and keeps it in SQLite.
// This is the other half: whenever the bus has an internet connection — a 4G
// dongle, the conductor's hotspot, depot Wi-Fi at the terminus — the rides go up
// to the same sync Edge Function the phones use, in the same signed batches, and
// settle there against real wallets.
//
//   Pi ──HTTPS POST (JSON)──▶ supabase/functions/sync ──▶ settleBatch() ──▶ settle_leg()
//
// Why this is safe on a bad connection:
//   - Store and forward. Nothing is deleted until the backend has ruled on it.
//   - Idempotent. Sending the same receipt twice is answered `replay`, never a
//     second charge, so a timeout half way through is simply retried.
//   - Chunked. sync.js sends at most 150 receipts per request, so a box that was
//     offline all week drains its queue instead of being refused for ever.
//   - No secrets on the wire. Every receipt is signed by the vehicle key and every
//     ride carries the passenger's own BT1 signature; the backend verifies both.
//     The only credential is the public anon key the website already ships.
//
// Two roles. A `door` validator on a bus with a meter uploads its rides only; the
// meter announces the vehicle key. A `vehicle` validator is the bus's only unit
// — no phones at all — so it announces the key itself (register_meter, frozen on
// first sight) and sends its power tape with the rides, exactly as a phone meter
// does. Both go through src/device/sync.js; nothing here builds a request.

import { syncTerminal, syncMeter, syncConfigured } from '../src/device/sync.js';

export const INTERVAL_MS = 60 * 1000;
export const MAX_BACKOFF_MS = 10 * 60 * 1000;

// Settled rides kept on the card for this long, then removed. A BO1 pass is
// good for six hours, so a fortnight is far past any replay that could matter,
// and it keeps the card's writes small on a bus that runs for years.
export const KEEP_SETTLED_DAYS = 14;

function settled(row) {
  return row.status === 'closed' && row.synced && (row.tapFiled || !row.tapQr);
}

export async function queueSize(database) {
  const rows = await database.getAll('legs');
  return {
    receipts: rows.filter((row) => row.status === 'closed' && !row.synced && row.receipt).length,
    taps: rows.filter((row) => row.tapQr && !row.tapFiled && !(row.status === 'closed' && row.receipt)).length,
    open: rows.filter((row) => row.status === 'open').length,
  };
}

export async function pruneSettled(database, { now = Date.now(), days = KEEP_SETTLED_DAYS } = {}) {
  const cutoffS = Math.floor(now / 1000) - days * 24 * 60 * 60;
  let removed = 0;
  for (const row of await database.getAll('legs')) {
    if (settled(row) && Number(row.alightAt ?? 0) > 0 && row.alightAt < cutoffS) {
      await database.delete('legs', row.legId);
      removed += 1;
    }
  }
  return removed;
}

export function createUplink({ door, database, role = 'door', capacity = null, firmware = 'bhada-validator', now = () => Date.now(), log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  let failures = 0;
  const status = { lastOkAt: 0, lastTryAt: 0, lastError: null, lastResult: null, pruned: 0, nextAt: 0 };

  async function once() {
    status.lastTryAt = now();
    const snap = door.snapshot();
    if (!snap.vehiclePublicKey) return { skipped: 'unpaired' };
    if (!syncConfigured()) return { skipped: 'no_endpoint' };
    try {
      const result = role === 'vehicle'
        ? await syncMeter({ vehicleId: snap.vehicleId, publicKey: snap.vehiclePublicKey, capacity, firmware })
        : await syncTerminal({ vehiclePublicKey: snap.vehiclePublicKey });
      failures = 0;
      status.lastOkAt = now();
      status.lastError = null;
      status.lastResult = result;
      status.pruned += await pruneSettled(database, { now: now() });
      if (result.settled || result.cleared || result.awaiting) {
        log(`uplink: settled ${result.settled}, cleared ${result.cleared}, awaiting tap ${result.awaiting}`);
      }
      return result;
    } catch (error) {
      failures += 1;
      status.lastError = error.message;
      // No network is the normal state of a bus. Say so once, not every minute.
      if (failures === 1) log(`uplink: ${error.message} — rides stay queued`);
      return { error: error.message };
    }
  }

  // Every minute while it works; after a failure, twice as long each time up
  // to ten minutes, so a dead SIM does not burn the battery of a hotspot.
  function delay() {
    return failures === 0 ? INTERVAL_MS : Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** failures);
  }

  function schedule() {
    const wait = delay();
    status.nextAt = now() + wait;
    timer = setTimer(async () => {
      await once();
      schedule();
    }, wait);
  }

  return {
    once,
    delay,
    start() {
      if (timer) return;
      once().finally(schedule);
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
    online: () => now() - status.lastOkAt < 3 * INTERVAL_MS,
    status: () => ({ ...status, failures }),
  };
}

/*
  A validator that is the whole bus has nobody to pair it. On first boot it
  makes the vehicle key itself, the way a phone meter does, and pairs its own
  door to it. The key never leaves the box; the backend learns the public half
  from the first upload.
*/
export async function selfKey(door, { vehicleId, createKeypair }) {
  if (door.snapshot().paired) return { ok: true, created: false };
  const keys = createKeypair();
  const result = await door.pair(JSON.stringify({ v: 'BHPAIR1', publicKey: keys.publicKey, secretKey: keys.secretKey, vehicleId }));
  return { ...result, created: result.ok };
}
