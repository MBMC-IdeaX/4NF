// A local stand-in for the Supabase Edge Function, speaking the same contract
// against the same migrations. It exists so sync can be tested end to end
// without the cloud, and so the demo has a fallback if the hosted function is
// unreachable on the day.
//
// Stage-fare tickets, metered legs with their passenger taps, taps on their
// own, meter key registration and the door tape — everything the hosted
// function accepts, answered the same way, by scripts/lib/pg-backend.mjs (the
// same code `npm run proof:legs` checks). Swapping to Supabase later is one
// line in .env.local.
//
// Run: npm run sync:local

import { createServer } from 'node:http';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { useRandomSource } from '../protocol/random.mjs';
import { openBackend, handleSync } from './lib/pg-backend.mjs';

useRandomSource((length) => new Uint8Array(nodeRandomBytes(length)));

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = fileURLToPath(new URL('../.pgdata/', import.meta.url));

// Persisted to disk, so restarting the server does not silently forget that a
// fare was already settled — which would make replay protection look broken.
// New migrations are applied on start; old ones are not replayed.
const { db, migrations } = await openBackend({ dataDir: DATA_DIR });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function send(response, status, body) {
  response.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Read-only views, so the state can be inspected without psql.
const READS = {
  '/trips': 'select * from trip_totals order by first_fare desc',
  '/transactions': 'select nonce, passenger_public_key, vehicle_plate, amount, boarding_stop, alighting_stop, sequence_number, settled_at from transactions order by settled_at desc limit 100',
  '/passengers': 'select public_key, balance, last_settled_at from passengers',
  '/legs': 'select leg_id, vehicle_plate, passenger_public_key, distance_m, distance_source, amount, tariff_code, boarded_at, alighted_at from legs order by alighted_at desc limit 100',
  '/economics': 'select * from leg_economics order by day desc',
  '/overloads': 'select * from overload_log limit 100',
};

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, CORS);
    response.end();
    return;
  }
  const url = new URL(request.url, `http://localhost:${PORT}`);

  try {
    if (request.method === 'POST' && url.pathname === '/sync') {
      const [status, body] = await handleSync(db, await readBody(request));
      console.log(
        `sync  ${status}  fares ${body.settled ?? 0}/${(body.settled ?? 0) + (body.rejected ?? 0)}`
        + `  legs ${body.legsSettled ?? 0}/${(body.legsSettled ?? 0) + (body.legsRejected ?? 0)}`
        + `  taps ${(body.tapResults ?? []).filter((r) => r?.ok).length}/${(body.tapResults ?? []).length}`,
      );
      send(response, status, body);
      return;
    }
    if (request.method === 'GET' && READS[url.pathname]) {
      send(response, 200, (await db.query(READS[url.pathname])).rows);
      return;
    }
    send(response, 404, { error: `Try POST /sync, or GET ${Object.keys(READS).join(', ')}.` });
  } catch (error) {
    console.error(error);
    send(response, 500, { error: error.message });
  }
}).listen(PORT, () => {
  console.log(`Bhada local sync server on http://localhost:${PORT}`);
  console.log(`  migrations       ${migrations.length} (${migrations[0]} … ${migrations[migrations.length - 1]})`);
  console.log('  POST /sync       fares, metered legs, taps, meter keys, door tape');
  for (const path of Object.keys(READS)) console.log(`  GET  ${path.padEnd(12)} read-only`);
  console.log(`\nSet VITE_SYNC_URL=http://localhost:${PORT}/sync in .env.local`);
});
