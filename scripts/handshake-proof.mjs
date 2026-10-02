// Step 1 proof: a passenger device and a conductor device complete a fare payment
// with no network available to either one. Nothing in this file opens a socket.
//
// Run: node scripts/handshake-proof.mjs

import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { useRandomSource } from '../protocol/random.mjs';
import { createKeypair, buildToken, signToken, verifyQr } from '../protocol/token.mjs';
import { offlineAllowance, canPayOffline } from '../protocol/policy.mjs';

useRandomSource((length) => new Uint8Array(nodeRandomBytes(length)));

const FARE_TABLE = { RATNAPARK__KOTESHWOR: 25 };
const CONDUCTOR_ID = 'BA2KHA4412';

// --- passenger device ------------------------------------------------------
const passenger = {
  keys: createKeypair(),
  sequenceNumber: 0,
  unsettledTotal: 0,
  lastSettlementAt: Math.floor(Date.now() / 1000) - 3600,
};

function passengerPay({ boardingStop, alightingStop }) {
  const fare = FARE_TABLE[`${boardingStop}__${alightingStop}`];
  const allowance = offlineAllowance(passenger);
  const check = canPayOffline(fare, allowance);
  if (!check.allowed) throw new Error(check.message);
  passenger.sequenceNumber += 1;
  const token = buildToken({
    passengerPublicKey: passenger.keys.publicKey,
    conductorId: CONDUCTOR_ID,
    amount: fare,
    boardingStop,
    alightingStop,
    sequenceNumber: passenger.sequenceNumber,
  });
  passenger.unsettledTotal += fare;
  return signToken(token, passenger.keys.secretKey);
}

// --- conductor device ------------------------------------------------------
// Stands in for the SQLite trip ledger on the conductor phone.
const conductor = { ledger: [], seenSequences: new Map() };

function seenFor(publicKey) {
  if (!conductor.seenSequences.has(publicKey)) conductor.seenSequences.set(publicKey, new Set());
  return conductor.seenSequences.get(publicKey);
}

function conductorScan(qrText) {
  const peek = qrText.split('|')[1];
  const result = verifyQr(qrText, { conductorId: CONDUCTOR_ID, seenSequences: seenFor(peek) });
  if (!result.ok) return result;
  seenFor(result.token.passengerPublicKey).add(result.token.sequenceNumber);
  conductor.ledger.push(result.token);
  return result;
}

// --- run -------------------------------------------------------------------
function line(label, value) {
  console.log(`${label.padEnd(22)} ${value}`);
}

console.log('\nBHADA — offline handshake proof (no network on either device)\n');

const qr = passengerPay({ boardingStop: 'RATNAPARK', alightingStop: 'KOTESHWOR' });
line('QR payload bytes', qr.length);
line('QR payload', `${qr.slice(0, 64)}...`);

const accepted = conductorScan(qr);
line('conductor verdict', accepted.ok ? 'ACCEPTED' : `REFUSED (${accepted.reason})`);
line('fare collected', `Rs ${accepted.token.amount}`);
line('route', `${accepted.token.boardingStop} to ${accepted.token.alightingStop}`);
line('ledger entries', conductor.ledger.length);

console.log('\nAttack: same QR presented twice');
const replay = conductorScan(qr);
line('conductor verdict', replay.ok ? 'ACCEPTED' : `REFUSED (${replay.reason})`);
line('reason shown', replay.message);
line('ledger entries', conductor.ledger.length);

console.log('\nAttack: fare amount edited in the QR text');
const tampered = qr.replace('|25|', '|5|');
const forged = conductorScan(tampered);
line('conductor verdict', forged.ok ? 'ACCEPTED' : `REFUSED (${forged.reason})`);
line('reason shown', forged.message);
line('ledger entries', conductor.ledger.length);

console.log('\nAttack: ticket signed by a different phone, claiming our public key');
const impostor = createKeypair();
const stolenIdentity = buildToken({
  passengerPublicKey: passenger.keys.publicKey,
  conductorId: CONDUCTOR_ID,
  amount: 25,
  boardingStop: 'RATNAPARK',
  alightingStop: 'KOTESHWOR',
  sequenceNumber: 99,
});
const spoofed = conductorScan(signToken(stolenIdentity, impostor.secretKey));
line('conductor verdict', spoofed.ok ? 'ACCEPTED' : `REFUSED (${spoofed.reason})`);
line('ledger entries', conductor.ledger.length);

console.log('\nOffline spend cap');
passenger.unsettledTotal = 490;
try {
  passengerPay({ boardingStop: 'RATNAPARK', alightingStop: 'KOTESHWOR' });
  line('cap enforced', 'NO — this is a bug');
} catch (error) {
  line('cap enforced', error.message);
}

console.log('\nSecond passenger, same trip');
const other = { keys: createKeypair(), sequenceNumber: 1 };
const otherQr = signToken(
  buildToken({
    passengerPublicKey: other.keys.publicKey,
    conductorId: CONDUCTOR_ID,
    amount: 25,
    boardingStop: 'RATNAPARK',
    alightingStop: 'KOTESHWOR',
    sequenceNumber: other.sequenceNumber,
  }),
  other.keys.secretKey,
);
const second = conductorScan(otherQr);
line('conductor verdict', second.ok ? 'ACCEPTED' : `REFUSED (${second.reason})`);
line('passengers on trip', conductor.ledger.length);
line('total collected', `Rs ${conductor.ledger.reduce((sum, entry) => sum + entry.amount, 0)}`);
console.log('');
