// One-time carry-over into the Crew app's own database.
//
// Before the split, the conductor screen, the meter and the door all wrote to
// the one shared 'bhada' database on this origin. A fare collected then and
// not yet synced must still reach the backend, so on its first start the Crew
// app copies the bus-side stores across. The rider's wallet and receipts stay
// where they are: copying a signing key into a second app would let two apps
// spend from one sequence.
//
// The old rows are left in place. A fare sent twice is refused by nonce at the
// backend; a fare deleted before it was sent is gone.

import { openDB } from 'idb';
import { db } from './db';

const DONE_KEY = 'carriedOverFromShared';
const WHOLE_STORES = ['ledger', 'legs', 'deviceEvents'];
const RIDER_KEYS = /^passenger/;

export async function carryOverFromShared(oldName) {
  const target = await db();
  if (await target.get('meta', DONE_KEY)) return { copied: 0 };

  // Opening a database that does not exist creates it. Ask first; a browser
  // that cannot say has never had one worth copying from on this origin
  // (indexedDB.databases() predates the split everywhere it matters).
  const known = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
  if (!known.some((entry) => entry.name === oldName)) {
    await target.put('meta', Date.now(), DONE_KEY);
    return { copied: 0 };
  }

  const source = await openDB(oldName);
  let copied = 0;
  try {
    for (const store of WHOLE_STORES) {
      if (!source.objectStoreNames.contains(store)) continue;
      const rows = await source.getAll(store);
      const tx = target.transaction(store, 'readwrite');
      for (const row of rows) tx.store.put(row);
      await tx.done;
      copied += rows.length;
    }
    if (source.objectStoreNames.contains('meter')) {
      // Read everything before opening the write: a transaction left waiting
      // on another database commits itself half-done.
      const keys = (await source.getAllKeys('meter')).filter((key) => !RIDER_KEYS.test(String(key)));
      const values = await Promise.all(keys.map((key) => source.get('meter', key)));
      const tx = target.transaction('meter', 'readwrite');
      keys.forEach((key, i) => tx.store.put(values[i], key));
      await tx.done;
      copied += keys.length;
    }
  } finally {
    source.close();
  }
  await target.put('meta', Date.now(), DONE_KEY);
  return { copied };
}
