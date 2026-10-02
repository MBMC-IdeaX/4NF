// IndexedDB, as far as the door needs it, on SQLite.
//
// Stands in for src/storage/db.js on the Pi. The door, the fleet record, the
// identity module and sync.js all talk to the `idb` wrapper's small surface —
// get, put, add, getAll, getAllFromIndex, a transaction with objectStore() and
// done — and this answers the same calls with the same values, so none of them
// knows it is not in a browser.
//
// Why SQLite, and why like this. A bus cuts power at every terminus, with no
// warning and no shutdown. `node:sqlite` is built into Node, so there is no
// native module to rebuild for the Pi; WAL with synchronous=FULL means a put()
// that has returned has been fsynced, so a tap the door has acted on survives
// the plug being pulled a moment later. That is a property of SQLite and the
// storage under it, not a promise this file can make on its own: an SD card
// that lies about flushing its cache can still lose the last write. The setup
// notes in validator/README.md cover the card and the filesystem.
//
// Every value is stored as JSON, keyed by (store, key). Stores with a keyPath in
// the browser schema keep it here, so put() without a key works the same way.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// The keyPaths and indexes in src/storage/db.js, and nothing else.
const KEY_PATHS = { payments: 'nonce', ledger: 'nonce', legs: 'legId', deviceEvents: 'seq' };
const AUTO_INCREMENT = new Set(['deviceEvents']);
const INDEXES = {
  legs: { status: 'status', passenger: 'passengerPublicKey', trip: 'tripId' },
  ledger: { passenger: 'passengerPublicKey', trip: 'tripId' },
  deviceEvents: { at: 'at', kind: 'kind' },
};

let file = process.env.BHADA_DATA_DIR ? path.join(process.env.BHADA_DATA_DIR, 'validator.sqlite') : ':memory:';
let handle = null;

// Where the database lives. Called once at startup, before db(); a test calls
// it with ':memory:' to start clean.
export function configureStore({ file: next }) {
  handle?.close?.();
  handle = null;
  file = next;
}

function open() {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const sql = new DatabaseSync(file);
  if (file !== ':memory:') {
    sql.exec('PRAGMA journal_mode = WAL');
    sql.exec('PRAGMA synchronous = FULL');
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS kv (
    store TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (store, key)
  )`);
  sql.exec('CREATE TABLE IF NOT EXISTS seq (store TEXT PRIMARY KEY, last INTEGER NOT NULL)');
  return sql;
}

function keyText(key) {
  return typeof key === 'string' ? `s:${key}` : `j:${JSON.stringify(key)}`;
}

function objectStore(sql, name) {
  const keyPath = KEY_PATHS[name] ?? null;
  const getRow = sql.prepare('SELECT value FROM kv WHERE store = ? AND key = ?');
  const putRow = sql.prepare('INSERT INTO kv (store, key, value) VALUES (?, ?, ?) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value');
  const allRows = sql.prepare('SELECT key, value FROM kv WHERE store = ?');
  const deleteRow = sql.prepare('DELETE FROM kv WHERE store = ? AND key = ?');

  function nextSeq() {
    sql.prepare('INSERT INTO seq (store, last) VALUES (?, 1) ON CONFLICT (store) DO UPDATE SET last = last + 1').run(name);
    return sql.prepare('SELECT last FROM seq WHERE store = ?').get(name).last;
  }

  function write(value, key, { mustBeNew = false } = {}) {
    let stored = value;
    let id = key;
    if (keyPath) {
      if (stored?.[keyPath] === undefined && AUTO_INCREMENT.has(name)) stored = { ...stored, [keyPath]: nextSeq() };
      id = stored?.[keyPath];
    }
    if (id === undefined || id === null) throw new Error(`No key for a put into ${name}`);
    if (mustBeNew && getRow.get(name, keyText(id))) {
      const error = new Error(`Key already exists in ${name}`);
      error.name = 'ConstraintError';
      throw error;
    }
    putRow.run(name, keyText(id), JSON.stringify(stored));
    return id;
  }

  // Rows come back in key order, as IndexedDB returns them. Numeric keys sort
  // as numbers so the event tape reads in sequence.
  function all() {
    const rows = allRows.all(name).map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
    const numeric = rows.every((row) => row.key.startsWith('j:'));
    rows.sort((a, b) => (numeric ? JSON.parse(a.key.slice(2)) - JSON.parse(b.key.slice(2)) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return rows.map((row) => row.value);
  }

  return {
    async get(key) {
      const row = getRow.get(name, keyText(key));
      return row ? JSON.parse(row.value) : undefined;
    },
    async put(value, key) { return write(value, key); },
    async add(value, key) { return write(value, key, { mustBeNew: true }); },
    async delete(key) { deleteRow.run(name, keyText(key)); },
    async getAll() { return all(); },
    async clear() { sql.prepare('DELETE FROM kv WHERE store = ?').run(name); },
    async count() { return all().length; },
    index(indexName) {
      const field = INDEXES[name]?.[indexName];
      if (!field) throw new Error(`No index ${indexName} on ${name}`);
      return {
        async getAll(value) {
          const rows = all();
          return value === undefined ? rows : rows.filter((row) => JSON.stringify(row[field]) === JSON.stringify(value));
        },
      };
    },
  };
}

function wrap(sql) {
  const stores = new Map();
  const store = (name) => {
    if (!stores.has(name)) stores.set(name, objectStore(sql, name));
    return stores.get(name);
  };
  return {
    get: (name, key) => store(name).get(key),
    put: (name, value, key) => store(name).put(value, key),
    add: (name, value, key) => store(name).add(value, key),
    delete: (name, key) => store(name).delete(key),
    getAll: (name) => store(name).getAll(),
    clear: (name) => store(name).clear(),
    count: (name) => store(name).count(),
    getAllFromIndex: (name, index, value) => store(name).index(index).getAll(value),
    // Each write inside is its own durable commit. The callers only ever use a
    // transaction to group idempotent puts, so a crash half way leaves rows that
    // the next sync simply sends again.
    transaction(names) {
      return { objectStore: (name) => store(name), done: Promise.resolve() };
    },
    close: () => sql.close(),
  };
}

export function db() {
  if (!handle) handle = wrap(open());
  return Promise.resolve(handle);
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
  for (const name of ['identity', 'payments', 'ledger', 'meta', 'meter', 'legs', 'deviceEvents']) {
    await database.clear(name);
  }
}

// The browser build's switch for a demonstration database. The validator has
// one database, chosen with configureStore().
export function setDatabaseName() {}
