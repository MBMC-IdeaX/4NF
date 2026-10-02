// Collecting a fare on the conductor phone. Signature first, then the ledger
// write. No network at any point.

import { db, currentTripId } from '../storage/db';
import { verifyQr } from '../../protocol/token.mjs';

export async function collectFare(qrText, { conductorId }) {
  // Verify before touching the database: nothing about an unverified ticket
  // should influence a lookup.
  const verdict = verifyQr(qrText, { conductorId });
  if (!verdict.ok) return verdict;

  const token = verdict.token;
  const tripId = await currentTripId();
  const database = await db();

  try {
    const tx = database.transaction('ledger', 'readwrite');
    const store = tx.objectStore('ledger');
    const alreadySeen = await store
      .index('passengerSequence')
      .get([token.passengerPublicKey, token.sequenceNumber]);
    if (alreadySeen) {
      await tx.done.catch(() => {});
      return {
        ok: false,
        reason: 'replay',
        message: 'This ticket was already collected. Ask for a new one.',
        token,
      };
    }
    // The raw signed string is kept, not just the parsed fields: the backend
    // must be able to re-verify the passenger's signature itself rather than
    // take this device's word for what the ticket said.
    await store.put({
      ...token,
      qrText,
      tripId,
      collectedAt: Math.floor(Date.now() / 1000),
      synced: 0,
    });
    await tx.done;
    return { ok: true, token, tripId };
  } catch (error) {
    // Two scans of the same code can race past the read above; the unique index
    // is what actually stops the double entry, so report it as the replay it is.
    if (error?.name === 'ConstraintError') {
      return {
        ok: false,
        reason: 'replay',
        message: 'This ticket was already collected. Ask for a new one.',
        token,
      };
    }
    return { ok: false, reason: 'ledger_error', message: error.message, token };
  }
}

export async function tripTally() {
  const tripId = await currentTripId();
  const database = await db();
  const rows = await database.getAllFromIndex('ledger', 'trip', tripId);
  rows.sort((a, b) => b.collectedAt - a.collectedAt);
  return {
    tripId,
    passengers: rows.length,
    total: rows.reduce((sum, row) => sum + row.amount, 0),
    recent: rows.slice(0, 12),
  };
}
