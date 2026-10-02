// The backend, in the browser.
//
// The same migrations Supabase runs, applied to PGlite (Postgres compiled to
// WebAssembly), and the same settleBatch() the sync Edge Function runs, through
// the same ledger the proofs use (scripts/lib/pg-core.mjs). A laptop with its
// Wi-Fi off can therefore settle a bus's rides on real Postgres, through the real
// settle_leg(), and show every wallet move. Only /demo loads this: it is about
// 16 MB, and no phone ever downloads it.

import { openBackendWith, handleSync } from '../../scripts/lib/pg-core.mjs';

// Bundled into this chunk (about 250 KB of SQL) rather than one file each, so
// the service worker has one name to leave out of every phone's precache.
const FILES = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true });

// What every new wallet starts with in the demonstration. The live function's
// SIGNUP_CREDIT_NPR plays the same part.
export const DEMO_CREDIT_NPR = 200;

export async function startBackend({ onStep } = {}) {
  onStep?.('Loading Postgres');
  const { PGlite } = await import('@electric-sql/pglite');
  const migrations = Object.entries(FILES).map(([path, sql]) => ({ file: path.split('/').pop(), sql }));
  onStep?.(`Applying ${migrations.length} migrations`);
  const started = performance.now();
  const { db, migrations: applied } = await openBackendWith({ PGlite, migrations });
  const version = (await db.query('select version() as v')).rows[0].v.split(' ').slice(0, 2).join(' ');

  return {
    version,
    migrations: applied,
    bootMs: Math.round(performance.now() - started),
    // One sync request, answered exactly as the Edge Function answers it.
    async handle(body) {
      return handleSync(db, body, { signupCredit: DEMO_CREDIT_NPR, autoRegisterVehicles: true });
    },
    // A wallet that existed before today — Gita's, the conductor's — made the
    // way the backend makes every wallet.
    async registerWallet(publicKey, credit) {
      return (await db.query('select register_device($1, $2) as r', [publicKey, credit])).rows[0].r;
    },
    // What the backend counted for a trip, as the bonus rule reads it.
    async evidence(tripId) {
      return (await db.query('select trip_evidence($1) as e', [tripId])).rows[0].e;
    },
    async balances(keys) {
      if (keys.length === 0) return new Map();
      const rows = (await db.query('select public_key, balance from passengers where public_key = any($1)', [keys])).rows;
      return new Map(rows.map((row) => [row.public_key, Number(row.balance)]));
    },
    async takings(plate) {
      const row = (await db.query(
        `select count(*)::int as rides, coalesce(sum(amount), 0)::int as rupees,
                coalesce(sum(distance_m), 0)::bigint as metres,
                count(*) filter (where distance_source = 'unclosed')::int as unclosed,
                count(*) filter (where plausibility is not null)::int as flagged
           from legs where vehicle_plate = $1`,
        [plate],
      )).rows[0];
      return { rides: row.rides, rupees: row.rupees, km: Number(row.metres) / 1000, unclosed: row.unclosed, flagged: row.flagged };
    },
  };
}
