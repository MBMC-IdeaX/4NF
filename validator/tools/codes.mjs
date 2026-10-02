// Bench codes: a pairing code for a bench bus, and ride codes for a bench rider.
//
//   node validator/tools/codes.mjs pair [VEHICLEID]
//   node validator/tools/codes.mjs ride [VEHICLEID]
//
// Keys are kept in .bench/codes.json so the same rider can board and alight.
// This is for a bench only. On a bus the pairing code comes off the meter's
// screen and the ride code off the passenger's own phone.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { useRandomSource } from '../../protocol/random.mjs';
import { createKeypair } from '../../protocol/token.mjs';
import { buildTap, signTap } from '../../protocol/leg.mjs';

useRandomSource((length) => new Uint8Array(randomBytes(length)));

const file = path.resolve('.bench', 'codes.json');
let saved = {};
try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { saved = {}; }
const [what = 'ride', vehicleArg] = process.argv.slice(2);
const vehicleId = (vehicleArg ?? saved.vehicleId ?? 'BA2KHA4412').toUpperCase();

if (what === 'pair') {
  const keys = createKeypair();
  saved = { ...saved, vehicleId, vehicle: keys };
  console.log(JSON.stringify({ v: 'BHPAIR1', publicKey: keys.publicKey, secretKey: keys.secretKey, vehicleId }));
} else {
  saved.rider = saved.rider ?? createKeypair();
  saved.vehicleId = vehicleId;
  console.log(signTap(buildTap({ passengerPublicKey: saved.rider.publicKey, vehicleId, doorId: 'A' }), saved.rider.secretKey));
}
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(saved, null, 2));
