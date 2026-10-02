// The backend, locally: every migration on PGlite (Postgres compiled to WASM),
// and the same request handling as supabase/functions/sync/index.ts.
//
// Two callers. `npm run sync:local` serves it over HTTP, as the demo-day
// fallback when the hosted function is unreachable. `npm run proof:legs` calls
// it directly, so the logic the fallback serves is the logic the proof checks.
//
// The verification itself is not here and not in the Edge Function either: both
// call settleBatch() from protocol/settle.mjs, and each supplies only a ledger.
// The ledger and the migration runner live in pg-core.mjs, which /demo also runs
// in a browser; this file only reads the migrations off the disk.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { openBackendWith } from './pg-core.mjs';

export { handleSync } from './pg-core.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

export async function openBackend({ dataDir } = {}) {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  const migrations = await Promise.all(files.map(async (file) => ({ file, sql: await readFile(`${MIGRATIONS}${file}`, 'utf8') })));
  return openBackendWith({ PGlite, migrations, dataDir });
}
