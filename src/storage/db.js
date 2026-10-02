// On-device store. Everything a phone needs to pay or collect a fare lives here,
// so both roles keep working with the radio switched off.

import { openDB } from 'idb';

const DB_NAME = 'bhada';
const DB_VERSION = 3;

let handle = null;
let name = DB_NAME;

/*
  A separate database, for a demonstration.

  /demo runs a whole bus in one tab — meter, both doors, passengers — and must
  not leave a single row in the store a real door or passenger uses on the same
  browser. It calls this once, before anything opens the database.
*/
export function setDatabaseName(next) {
  if (next === name) return;
  name = next;
  handle = null;
}

export function db() {
  if (!handle) {
    handle = openDB(name, DB_VERSION, {
      upgrade(database, from, to, tx) {
        if (from < 1) {
          database.createObjectStore('identity');

          // What this phone has paid, whether or not it has settled yet.
          database.createObjectStore('payments', { keyPath: 'nonce' });

          // What this phone has collected as a conductor.
          const ledger = database.createObjectStore('ledger', { keyPath: 'nonce' });
          // One passenger may not reuse a sequence number. Sequence numbers are
          // monotonic per passenger, so this holds across trips too, and it is
          // the backstop behind the in-transaction replay check.
          ledger.createIndex('passengerSequence', ['passengerPublicKey', 'sequenceNumber'], {
            unique: true,
          });
          ledger.createIndex('passenger', 'passengerPublicKey');
        }
        if (from < 2) {
          // A trip is a conductor's shift. Without it the running count never
          // resets and the tally is meaningless by the second trip.
          database.createObjectStore('meta');
          // The upgrade transaction is the fourth argument; `database.transaction`
          // is the method for opening a new one and has no stores to give here.
          tx.objectStore('ledger').createIndex('trip', 'tripId');
        }
        if (from < 3) {
          // The meter's own state. A bus loses power every time the engine is
          // cut; an odometer that forgets on every restart is not an odometer,
          // so the reading and the open legs are written through to disk.
          database.createObjectStore('meter');

          // One row per ride. `open` rows are passengers still aboard — they
          // are the roster, the occupancy count, and the door interlock input
          // all at once, which is why they live in one store rather than three.
          const legs = database.createObjectStore('legs', { keyPath: 'legId' });
          legs.createIndex('status', 'status');
          legs.createIndex('passenger', 'passengerPublicKey');
          legs.createIndex('trip', 'tripId');
          // A passenger may not have two rides open at once on one vehicle.
          legs.createIndex('openPassenger', ['status', 'passengerPublicKey'], { unique: false });

          // Everything the box did, in order, kept on the box. An operator
          // disputing a door lock or a fare needs the tape, not a summary.
          const events = database.createObjectStore('deviceEvents', { keyPath: 'seq', autoIncrement: true });
          events.createIndex('at', 'at');
          events.createIndex('kind', 'kind');
        }
      },
    });
  }
  return handle;
}

export async function currentTripId() {
  const database = await db();
  const existing = await database.get('meta', 'tripId');
  if (existing) return existing;
  const fresh = `T${Date.now().toString(36).toUpperCase()}`;
  await database.put('meta', fresh, 'tripId');
  return fresh;
}

export async function endTrip() {
  const database = await db();
  const fresh = `T${Date.now().toString(36).toUpperCase()}`;
  await database.put('meta', fresh, 'tripId');
  return fresh;
}

export async function resetDevice() {
  const database = await db();
  const tx = database.transaction(
    ['identity', 'payments', 'ledger', 'meta', 'meter', 'legs', 'deviceEvents'],
    'readwrite',
  );
  await Promise.all([
    tx.objectStore('identity').clear(),
    tx.objectStore('payments').clear(),
    tx.objectStore('ledger').clear(),
    tx.objectStore('meta').clear(),
    tx.objectStore('meter').clear(),
    tx.objectStore('legs').clear(),
    tx.objectStore('deviceEvents').clear(),
    tx.done,
  ]);
}
