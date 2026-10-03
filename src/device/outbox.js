// How much each device has waiting to go up. Read by the sync pill; written by
// the screens that collect fares, rides and claims.

import { loadIdentity, pendingKeyLinks } from './identity';
import { db } from '../storage/db';

export async function pendingPassenger() {
  const database = await db();
  const payments = (await database.getAll('payments')).filter((row) => !row.settled).length;
  const claims = ((await database.get('meter', 'passengerClaims')) ?? []).filter((row) => !row.sent).length;
  const receipts = ((await database.get('meter', 'passengerReceipts')) ?? []).filter((row) => !row.reconciled).length;
  return payments + claims + receipts + pendingKeyLinks(await loadIdentity()).length;
}

export async function pendingConductor() {
  const database = await db();
  return (await database.getAll('ledger')).filter((row) => !row.synced).length;
}

export async function pendingVehicleEvidence({ includeMeter = false } = {}) {
  const database = await db();
  const legs = (await database.getAll('legs')).filter((row) =>
    (row.receipt && !row.synced) || (row.cashQr && !row.synced) || (row.tapQr && !row.tapFiled));
  if (!includeMeter) return legs.length;
  const events = await database.getAll('deviceEvents');
  const doorCursor = (await database.get('meter', 'doorTapeCursor')) ?? 0;
  const powerCursor = (await database.get('meter', 'meterTapeCursor')) ?? 0;
  const tapes = events.filter((event) =>
    (['door', 'override', 'tamper'].includes(event.kind) && event.seq > doorCursor)
    || (event.kind === 'power' && event.seq > powerCursor)).length;
  const crew = await database.get('meter', 'crew');
  return legs.length + tapes + (crew?.trips?.length ?? 0)
    + ((await database.get('meter', 'closedTrips')) ?? []).length
    + ((await database.get('meter', 'tripCounts')) ?? []).length;
}
