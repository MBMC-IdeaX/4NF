// Step 2 proof: the real migration SQL, run against a real Postgres, settling
// real signed tokens. PGlite is Postgres compiled to WASM, so this is the same
// plpgsql that will run on Supabase — not a mock of it.
//
// Run: node scripts/reconcile-proof.mjs

import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { useRandomSource } from '../protocol/random.mjs';
import { createKeypair, buildToken, signToken, verifyQr } from '../protocol/token.mjs';

useRandomSource((length) => new Uint8Array(nodeRandomBytes(length)));

const PLATE = 'BA2KHA4412';
const TRIP = 'T7QK2X';

const db = new PGlite();
for (const file of ['0001_bhada.sql', '0002_seed.sql']) {
  const path = fileURLToPath(new URL(`../supabase/migrations/${file}`, import.meta.url));
  await db.exec(await readFile(path, 'utf8'));
}

function line(label, value) {
  console.log(`${label.padEnd(26)} ${value}`);
}

console.log('\nBHADA — backend reconcile proof (real Postgres, real migration)\n');

const fares = await db.query('select count(*)::int as n from fares');
const endToEnd = await db.query(
  'select amount from fares where boarding_stop = $1 and alighting_stop = $2',
  ['RATNAPARK', 'KOTESHWOR'],
);
line('fare table rows', fares.rows[0].n);
line('Ratna Park to Koteshwor', `Rs ${endToEnd.rows[0].amount}`);

// --- a passenger device, offline -------------------------------------------
const passenger = { keys: createKeypair(), sequenceNumber: 0 };
await db.query('insert into passengers (public_key, balance) values ($1, $2)', [
  passenger.keys.publicKey,
  200,
]);
await db.query('insert into trips (id, vehicle_plate) values ($1, $2)', [TRIP, PLATE]);
line('passenger balance', 'Rs 200');

function issue(amount, sequenceNumber) {
  return signToken(
    buildToken({
      passengerPublicKey: passenger.keys.publicKey,
      conductorId: PLATE,
      amount,
      boardingStop: 'RATNAPARK',
      alightingStop: 'KOTESHWOR',
      sequenceNumber,
    }),
    passenger.keys.secretKey,
  );
}

/*
  What the sync endpoint does with one queued fare. The device sends the signed
  QR text, not a summary of it, so the backend verifies the passenger's own
  signature rather than trusting whichever device uploaded the batch.
*/
async function sync(qrText, settledBy) {
  const verdict = verifyQr(qrText, { maxAgeSeconds: 30 * 24 * 60 * 60 });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  const t = verdict.token;
  const settled = await db.query('select settle_fare($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as r', [
    t.passengerPublicKey,
    t.conductorId,
    TRIP,
    t.amount,
    t.boardingStop,
    t.alightingStop,
    t.sequenceNumber,
    t.nonce,
    new Date(t.timestamp * 1000).toISOString(),
    new Date().toISOString(),
    settledBy,
  ]);
  return settled.rows[0].r;
}

console.log('\nConductor syncs the trip');
const first = issue(25, 1);
line('fare 1', JSON.stringify(await sync(first, 'conductor')));
const second = issue(25, 2);
line('fare 2', JSON.stringify(await sync(second, 'conductor')));

console.log('\nPassenger phone syncs the same fares later');
line('fare 1 again', JSON.stringify(await sync(first, 'passenger')));
line('fare 2 again', JSON.stringify(await sync(second, 'passenger')));

console.log('\nAttack: fare amount edited before upload');
line('edited to Rs 5', JSON.stringify(await sync(first.replace('|25|', '|5|'), 'conductor')));

console.log('\nAttack: another key signs a token claiming our account');
const impostor = createKeypair();
const forged = signToken(
  buildToken({
    passengerPublicKey: passenger.keys.publicKey,
    conductorId: PLATE,
    amount: 25,
    boardingStop: 'RATNAPARK',
    alightingStop: 'KOTESHWOR',
    sequenceNumber: 50,
  }),
  impostor.secretKey,
);
line('forged token', JSON.stringify(await sync(forged, 'conductor')));

console.log('\nBalance runs out');
for (const sequenceNumber of [3, 4, 5, 6, 7, 8, 9]) {
  const outcome = await sync(issue(25, sequenceNumber), 'conductor');
  line(`fare ${sequenceNumber}`, JSON.stringify(outcome));
}

console.log('\nLedger state');
const total = await db.query(
  'select count(*)::int as n, coalesce(sum(amount),0)::int as collected from transactions',
);
const wallet = await db.query('select balance from passengers where public_key = $1', [
  passenger.keys.publicKey,
]);
line('transactions settled', total.rows[0].n);
line('value moved', `Rs ${total.rows[0].collected}`);
line('passenger balance', `Rs ${wallet.rows[0].balance}`);

const trip = await db.query('select * from trip_totals where trip_id = $1', [TRIP]);
line('trip passengers', trip.rows[0].passengers);
line('trip collected', `Rs ${trip.rows[0].collected}`);
console.log('');

await db.close();
