// How much each device has waiting to go up. Read by the sync pill; written by
// the screens that collect fares, rides and claims.

import { db } from '../storage/db';

export async function pendingPassenger() {
  const database = await db();
  const payments = (await database.getAll('payments')).filter((row) => !row.settled).length;
  const claims = ((await database.get('meter', 'passengerClaims')) ?? []).filter((row) => !row.sent).length;
  return payments + claims;
}

export async function pendingConductor() {
  const database = await db();
  return (await database.getAll('ledger')).filter((row) => !row.synced).length;
}
