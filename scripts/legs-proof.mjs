// The distance path's backend, against real Postgres.
//
// Every migration this project ships, applied in order to PGlite (Postgres
// compiled to WASM), and every upload handled by scripts/lib/pg-backend.mjs —
// the same code `npm run sync:local` serves, written to answer exactly as the
// sync Edge Function does: verify the vehicle's receipt, verify the
// passenger's tap, record the tap, settle. The attacks are the ones that matter for money: a
// receipt with no consent behind it, and one genuine tap stretched to cover a
// ride the passenger never took.
//
// Run: npm run proof:legs

import { randomBytes as nodeRandomBytes, createHmac } from 'node:crypto';
import { useRandomSource } from '../protocol/random.mjs';
import { openBackend, handleSync } from './lib/pg-backend.mjs';
import { createKeypair, buildToken, signToken } from '../protocol/token.mjs';
import { buildAccountLink, signAccountLink } from '../protocol/account.mjs';
import { ESEWA, esewaForm, esewaMessage, readEsewaReturn, esewaSettled, khaltiSettled, khaltiInitiateBody } from '../protocol/gateway.mjs';
import { priceDistance, TARIFF } from '../protocol/meter.mjs';
import { buildLeg, signLeg, verifyLeg, buildTap, signTap } from '../protocol/leg.mjs';
import { buildDispute, signDispute } from '../protocol/dispute.mjs';
import { buildAttestation, signAttestation } from '../protocol/attest.mjs';
import { createMasterSeed, deriveDailyKeypair, deriveCompanionKeypair, buildLink, signLink, dayIndex } from '../protocol/pseudonym.mjs';
import { OVERDRAFT_NPR, CLEAN_TRIP_BONUS_NPR, CLEAN_TRIP_MIN_LEGS, RECORDED_SHARE_MIN_PCT } from '../protocol/policy.mjs';
import { buildSignOn, signSignOn } from '../protocol/crew.mjs';
import { buildCashTicket, signCashTicket } from '../protocol/cash.mjs';

useRandomSource((length) => new Uint8Array(nodeRandomBytes(length)));

const PLATE = 'BA2KHA4412';
const pad = (label) => `${label}`.padEnd(34, '.');
const line = (label, value) => console.log(`  ${pad(label)} ${value}`);
let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------------ database

const { db, migrations: files } = await openBackend();

console.log('\nBhada legs proof — every migration, real Postgres, real signatures\n');
line('migrations applied', files.join(', '));

// ------------------------------------------------------------------ fixtures

const vehicle = createKeypair();
const passenger = createKeypair();
const bystander = createKeypair();

async function sync(body) {
  const [status, response] = await handleSync(db, { devicePublicKey: 'proof', ...body }, { signupCredit: 0 });
  if (status !== 200) throw new Error(`sync answered ${status}: ${JSON.stringify(response)}`);
  return response;
}

await sync({ meter: { vehicleId: PLATE, publicKey: vehicle.publicKey, capacity: 42, firmware: 'proof' } });
const keyOnFile = (await db.query('select public_key from vehicles where plate = $1', [PLATE])).rows[0]?.public_key;
line('meter key on file', keyOnFile === vehicle.publicKey ? 'registered by the meter\'s own upload' : 'MISSING');
for (const key of [passenger.publicKey, bystander.publicKey]) {
  await db.query('insert into passengers (public_key, balance) values ($1, 200) on conflict do nothing', [key]);
}

const boardAt = Math.floor(Date.now() / 1000) - 900;
let legSeq = 0;

function receiptFor(person, { distanceM = 3300, at = boardAt, concession = 'none' } = {}) {
  legSeq += 1;
  const price = priceDistance(distanceM, { concession });
  return signLeg(buildLeg({
    vehicleId: PLATE,
    tripId: 'TPROOF',
    legId: `LPROOF${legSeq}`,
    passengerPublicKey: person.publicKey,
    boardDoorId: 'A',
    alightDoorId: 'B',
    boardOdoM: 1000,
    alightOdoM: 1000 + distanceM,
    distanceM,
    distanceSource: 'odometer',
    boardAt: at,
    alightAt: at + 600,
    concession,
    amount: price.amount,
    tariffCode: TARIFF.code,
  }), vehicle.secretKey);
}

function tapBy(person, signer = person, at = boardAt) {
  return signTap(buildTap({ passengerPublicKey: person.publicKey, vehicleId: PLATE, doorId: 'A', timestamp: at }), signer.secretKey);
}

// One receipt up, with its tap if the uploading device has it.
async function upload(receipt, tap, attestation) {
  const response = await sync({ legs: [tap ? { receipt, tap, attestation } : receipt] });
  return response.legResults[0];
}

// A tap on its own, from the door that saw the passenger board.
async function fileTap(legId, tap) {
  const response = await sync({ taps: [{ legId, tap }] });
  return response.tapResults[0];
}

async function balance(person) {
  return (await db.query('select balance from passengers where public_key = $1', [person.publicKey])).rows[0].balance;
}

// ------------------------------------------------------------------- honest

console.log('\n1. An honest ride settles once');
const honestTap = tapBy(passenger);
const honestReceipt = receiptFor(passenger);
const first = await upload(honestReceipt, honestTap);
check('receipt + passenger tap settles', first.ok === true, JSON.stringify(first));
line('passenger balance', `Rs ${await balance(passenger)}`);
const again = await upload(honestReceipt, honestTap);
check('the same leg again is a replay, not a second charge', again.reason === 'replay', again.reason);
check('balance moved once', (await balance(passenger)) === 200 - priceDistance(3300).amount);

// ------------------------------------------------------------------ attacks

console.log('\n2. A vehicle key alone cannot bill anyone');
const before = await balance(bystander);
const invented = receiptFor(bystander);
const noConsent = await upload(invented);
check('a receipt with no tap on file is held, not settled', noConsent.reason === 'awaiting_tap', noConsent.reason);
const forged = await upload(invented, tapBy(bystander, vehicle));
check('a tap signed by the operator, not the passenger, is refused', forged.reason === 'bad_tap', forged.reason);
const borrowed = await upload(invented, honestTap);
check('another passenger\'s tap does not transfer', borrowed.reason === 'tap_mismatch', borrowed.reason);
check('the bystander was not charged', (await balance(bystander)) === before, `Rs ${await balance(bystander)}`);

console.log('\n3. One tap opens one ride');
const stretched = receiptFor(passenger, { distanceM: 5200 });
const reuse = await upload(stretched, honestTap);
check('a genuine tap reused for a second receipt is refused', reuse.reason === 'tap_reused', reuse.reason);

console.log('\n4. Consent can arrive after the receipt');
// Two door phones with no signal between them: the alighting door uploads the
// receipt, the boarding door — which saw the tap — uploads it later.
const lateTap = tapBy(passenger, passenger, boardAt + 30);
const lateReceipt = receiptFor(passenger, { distanceM: 2100, at: boardAt + 30 });
const early = await upload(lateReceipt);
check('receipt first: held as awaiting_tap', early.reason === 'awaiting_tap', early.reason);
const lateLeg = verifyLeg(lateReceipt, { vehiclePublicKey: vehicle.publicKey }).leg;
const filed = await fileTap(lateLeg.legId, lateTap);
check('the tap is filed on its own', filed.ok === true, JSON.stringify(filed));
const retried = await upload(lateReceipt);
check('the retried receipt now settles', retried.ok === true, JSON.stringify(retried));

console.log('\n5. A ride nobody closed settles at the cap');
{
  const at = boardAt + 90;
  const unclosed = signLeg(buildLeg({
    vehicleId: PLATE, tripId: 'TPROOF', legId: 'LPROOFUNCLOSED', passengerPublicKey: passenger.publicKey,
    boardDoorId: 'A', alightDoorId: 'A', boardOdoM: 5000, alightOdoM: 5400, distanceM: 400,
    distanceSource: 'unclosed', boardAt: at, alightAt: at + 3600, concession: 'none',
    amount: priceDistance(400, { unclosed: true }).amount, tariffCode: TARIFF.code,
  }), vehicle.secretKey);
  const settledUnclosed = await upload(unclosed, tapBy(passenger, passenger, at));
  check('an unclosed leg with its tap settles at the cap', settledUnclosed.ok === true && settledUnclosed.amount === TARIFF.unclosedLegFare, JSON.stringify(settledUnclosed));
}

// ------------------------------------------------------- dead-phone claims

console.log('\n6. A dead phone can claim back what the cap overcharged');
{
  // The unclosed ride settled above: boarded at `boardAt + 90`, closed an hour
  // later at the Rs 25 cap for 400 m of measured distance. The passenger's own
  // phone recorded 400 m and then stopped, ten minutes into the ride.
  const at = boardAt + 90;
  const claimFor = (overrides = {}) => signDispute(buildDispute({
    passengerPublicKey: passenger.publicKey,
    vehicleId: PLATE,
    legId: 'LPROOFUNCLOSED',
    witnessM: 400,
    witnessAt: at + 600,
    ...overrides,
  }), passenger.secretKey);

  const forgedClaim = signDispute(buildDispute({
    passengerPublicKey: passenger.publicKey, vehicleId: PLATE, legId: 'LPROOFUNCLOSED',
    witnessM: 400, witnessAt: at + 600,
  }), bystander.secretKey);
  const forgedVerdict = (await sync({ disputes: [forgedClaim] })).disputeResults[0];
  check('a claim signed by another phone is refused', forgedVerdict.reason === 'bad_signature', forgedVerdict.reason);

  const notMine = signDispute(buildDispute({
    passengerPublicKey: bystander.publicKey, vehicleId: PLATE, legId: 'LPROOFUNCLOSED',
    witnessM: 400, witnessAt: at + 600,
  }), bystander.secretKey);
  const notMineVerdict = (await sync({ disputes: [notMine] })).disputeResults[0];
  check('a claim against somebody else\'s ride is refused', notMineVerdict.reason === 'not_your_leg', notMineVerdict.reason);

  const closedLeg = (await sync({ disputes: [claimFor({ legId: 'LPROOF1' })] })).disputeResults[0];
  check('a ride closed at a door cannot be claimed against', closedLeg.reason === 'not_disputable', closedLeg.reason);

  // A second unclosed ride, because a claim is filed against a leg once and
  // that is final: a passenger who could file, be refused, and file again would
  // simply tune the reading until it paid.
  const at2 = boardAt + 200;
  const secondUnclosed = signLeg(buildLeg({
    vehicleId: PLATE, tripId: 'TPROOF', legId: 'LPROOFUNCLOSED2', passengerPublicKey: passenger.publicKey,
    boardDoorId: 'A', alightDoorId: 'A', boardOdoM: 9000, alightOdoM: 9400, distanceM: 400,
    distanceSource: 'unclosed', boardAt: at2, alightAt: at2 + 3600, concession: 'none',
    amount: priceDistance(400, { unclosed: true }).amount, tariffCode: TARIFF.code,
  }), vehicle.secretKey);
  await upload(secondUnclosed, tapBy(passenger, passenger, at2));

  const tooLively = (await sync({ disputes: [signDispute(buildDispute({
    passengerPublicKey: passenger.publicKey, vehicleId: PLATE, legId: 'LPROOFUNCLOSED2',
    witnessM: 400, witnessAt: at2 + 3599,
  }), passenger.secretKey)] })).disputeResults[0];
  check('a phone still recording at the end of the ride gets nothing back', tooLively.reason === 'phone_was_alive', tooLively.reason);
  const afterRefusal = (await sync({ disputes: [signDispute(buildDispute({
    passengerPublicKey: passenger.publicKey, vehicleId: PLATE, legId: 'LPROOFUNCLOSED2',
    witnessM: 400, witnessAt: at2 + 600,
  }), passenger.secretKey)] })).disputeResults[0];
  check('a refused claim cannot be refiled with a better reading', afterRefusal.reason === 'replay', afterRefusal.reason);

  const chargedBefore = await balance(passenger);
  const honestClaim = claimFor();
  const paid = (await sync({ disputes: [honestClaim] })).disputeResults[0];
  const owed = TARIFF.unclosedLegFare - priceDistance(400).amount;
  check('the honest claim is refunded the difference', paid.ok === true && paid.refund === owed, JSON.stringify(paid));
  check('the refund reached the wallet', (await balance(passenger)) === chargedBefore + owed, `Rs ${await balance(passenger)}`);
  line('claimed back', `Rs ${owed} of the Rs ${TARIFF.unclosedLegFare} cap, priced at Rs ${priceDistance(400).amount} for 400 m`);

  const twice = (await sync({ disputes: [honestClaim] })).disputeResults[0];
  check('the same claim again is a replay, not a second refund', twice.reason === 'replay', twice.reason);
  check('the refund was paid once', (await balance(passenger)) === chargedBefore + owed, `Rs ${await balance(passenger)}`);

  const credits = await db.query("select count(*)::int as n from wallet_topups where source = 'refund'");
  check('the refund left one auditable credit', credits.rows[0].n === 1, `${credits.rows[0].n} row(s)`);
}

// ------------------------------------------------------ concession cards

console.log('\n7. A half fare has to be backed by somebody');
{
  const campus = createKeypair();
  const forger = createKeypair();
  const student = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 300) on conflict do nothing', [student.publicKey]);
  await db.query(
    `insert into concession_issuers (public_key, name, kind, concessions)
     values ($1, 'Padma Kanya Campus', 'campus', array['student'])
     on conflict (public_key) do nothing`,
    [campus.publicKey],
  );

  const cardFrom = (issuer, { concession = 'student', expiresAt = boardAt + 86400 } = {}) => signAttestation(
    buildAttestation({
      passengerPublicKey: student.publicKey,
      issuerPublicKey: issuer.publicKey,
      concession,
      issuedAt: boardAt - 86400,
      expiresAt,
    }),
    issuer.secretKey,
  );

  const full = priceDistance(3300).amount;
  const half = priceDistance(3300, { concession: 'student' }).amount;
  line('same ride, two fares', `full Rs ${full}, student Rs ${half}`);

  // 1. The claim nobody backs. This is the hole: before AT1 the phone said
  //    `student` and the backend charged Rs ${half}.
  let before = await balance(student);
  const bare = receiptFor(student, { concession: 'student' });
  const bareVerdict = await upload(bare, tapBy(student), null);
  check('a student claim with no card settles, but at the full fare',
    bareVerdict.ok === true && bareVerdict.amount === full, JSON.stringify(bareVerdict));
  check('and the wallet lost the full fare, not half', (await balance(student)) === before - full);
  check('the leg records that nothing backed it', bareVerdict.concessionVerified === false);

  // 2. A card somebody forged in their bedroom.
  before = await balance(student);
  const forged = receiptFor(student, { concession: 'student' });
  const forgedVerdict = await upload(forged, tapBy(student), cardFrom(forger));
  check('a card from an office nobody registered is charged the full fare',
    forgedVerdict.ok === true && forgedVerdict.amount === full, JSON.stringify(forgedVerdict));
  check('that wallet also lost the full fare', (await balance(student)) === before - full);

  // 3. An expired card. Still carried, still refused the discount, never refused
  //    the ride — the passenger is on a bus either way.
  before = await balance(student);
  const lapsed = receiptFor(student, { concession: 'student' });
  const lapsedVerdict = await upload(lapsed, tapBy(student), cardFrom(campus, { expiresAt: boardAt - 60 }));
  check('an expired card is charged the full fare, not refused',
    lapsedVerdict.ok === true && lapsedVerdict.amount === full, JSON.stringify(lapsedVerdict));

  // 4. Somebody else\'s card, which is the obvious way to try this on.
  before = await balance(student);
  const borrowedCard = signAttestation(buildAttestation({
    passengerPublicKey: passenger.publicKey,
    issuerPublicKey: campus.publicKey,
    concession: 'student',
    issuedAt: boardAt - 86400,
    expiresAt: boardAt + 86400,
  }), campus.secretKey);
  const borrowedVerdict = await upload(receiptFor(student, { concession: 'student' }), tapBy(student), borrowedCard);
  check('another passenger\'s card does not discount this ride',
    borrowedVerdict.ok === true && borrowedVerdict.amount === full, JSON.stringify(borrowedVerdict));

  // 5. The real thing.
  before = await balance(student);
  const real = receiptFor(student, { concession: 'student' });
  const realVerdict = await upload(real, tapBy(student), cardFrom(campus));
  check('a card from a registered campus is charged the student fare',
    realVerdict.ok === true && realVerdict.amount === half, JSON.stringify(realVerdict));
  check('and the wallet lost only the half fare', (await balance(student)) === before - half);
  check('the leg records that it was backed', realVerdict.concessionVerified === true);

  // 6. A revoked campus stops discounting from that moment, without rewriting
  //    the rides it already backed.
  await db.query('update concession_issuers set revoked_at = now() where public_key = $1', [campus.publicKey]);
  const afterRevoke = await upload(receiptFor(student, { concession: 'student' }), tapBy(student), cardFrom(campus));
  check('a revoked office stops backing new rides', afterRevoke.amount === full, JSON.stringify(afterRevoke));
  const stillBacked = await db.query(
    'select concession_verified from legs where leg_id = $1', [JSON.parse(JSON.stringify(realVerdict)).legId]);
  check('the ride it backed before is untouched', stillBacked.rows[0].concession_verified === true);

  const claims = await db.query("select * from concession_claims where concession = 'student'");
  line('operator sees', `${claims.rows[0].legs} student claims, ${claims.rows[0].backed} backed, ${claims.rows[0].unbacked} unbacked`);
  check('the operator view separates backed from unbacked', claims.rows[0].backed === 1 && claims.rows[0].unbacked === 5);
}

// -------------------------------------------------------- regulator's view

console.log('\n8. The regulator return computes from the same rows');
{
  await sync({
    meter: { vehicleId: PLATE, publicKey: vehicle.publicKey, capacity: 42, firmware: 'proof' },
    doorEvents: [
      { kind: 'locked', door: 'A', onboard: 42, capacity: 42, at: new Date(boardAt * 1000).toISOString(), note: 'bus full' },
      { kind: 'override_on', door: 'A', onboard: 45, capacity: 42, at: new Date((boardAt + 60) * 1000).toISOString(), note: 'crew override' },
    ],
  });

  const ret = await db.query('select * from dotm_daily_return where vehicle_plate = $1 order by service_date desc limit 1', [PLATE]);
  const day = ret.rows[0];
  line('return, one vehicle-day', `${day.rides} rides, ${day.passenger_km} passenger-km, Rs ${day.fare_npr}, peak ${day.peak_onboard}/${day.permitted_capacity}`);
  check('the return counts every settled ride', Number(day.rides) === 10, String(day.rides));
  check('and separates measured distance from estimated',
    Number(day.rides_measured) + Number(day.rides_estimated) === Number(day.rides)
      && Number(day.passenger_km_measured) <= Number(day.passenger_km),
    `${day.rides_measured} measured, ${day.rides_estimated} estimated`);
  check('concession rides are reported separately', Number(day.concession_rides) === 6, String(day.concession_rides));
  check('the interlock refusal is on the return', Number(day.interlock_refusals) === 1, String(day.interlock_refusals));
  check('so is the override', Number(day.override_events) === 1, String(day.override_events));

  const register = await db.query('select * from dotm_overload_register where vehicle_plate = $1', [PLATE]);
  const over = register.rows.find((r) => r.kind === 'override_on');
  check('the overload register shows how far over the permit it went', Number(over.over_by) === 3, `${over.over_by} over`);
  line('overload register', `${register.rows.length} event(s), worst ${Math.max(...register.rows.map((r) => Number(r.over_by)))} over capacity`);
}

// -------------------------------------------------------------- pseudonyms

console.log('\n9. A fleet owner cannot follow anyone home');
{
  /*
    The commute this stops being reconstructable: one wallet, two days, two
    different keys on the rides. The operator's copy of a leg carries the
    day-key; only passenger_keys knows they are the same person, and no operator
    can read it.
  */
  const seed = createMasterSeed();
  const root = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 400) on conflict do nothing', [root.publicKey]);

  const today = dayIndex(boardAt);
  const monday = deriveDailyKeypair(seed, today);
  const tuesday = deriveDailyKeypair(seed, today + 1);
  check('two days give two unrelated keys', monday.publicKey !== tuesday.publicKey);
  check('the same day always gives the same key',
    deriveDailyKeypair(seed, today).publicKey === monday.publicKey);

  const linkFor = (dayKey, wallet = root) => signLink(
    buildLink({ rootPublicKey: wallet.publicKey, pseudonymPublicKey: dayKey.publicKey, day: dayKey.day }),
    wallet.secretKey,
    dayKey.secretKey,
  );

  // A link the wallet never signed.
  const impostor = createKeypair();
  const forgedLink = signLink(
    buildLink({ rootPublicKey: root.publicKey, pseudonymPublicKey: monday.publicKey, day: monday.day }),
    impostor.secretKey,
    monday.secretKey,
  );
  const forgedVerdict = (await sync({ keyLinks: [forgedLink] })).linkResults[0];
  check('a link the wallet did not sign is refused', forgedVerdict.reason === 'bad_root_signature', forgedVerdict.reason);

  const filed = (await sync({ keyLinks: [linkFor(monday), linkFor(tuesday)] })).linkResults;
  check('both day-keys register against the wallet', filed.every((r) => r.ok === true), JSON.stringify(filed));

  // Somebody else trying to redirect this passenger's fares onto their wallet.
  const thief = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 0) on conflict do nothing', [thief.publicKey]);
  const stolen = signLink(
    buildLink({ rootPublicKey: thief.publicKey, pseudonymPublicKey: monday.publicKey, day: monday.day }),
    thief.secretKey,
    monday.secretKey,
  );
  const stolenVerdict = (await sync({ keyLinks: [stolen] })).linkResults[0];
  check('a pseudonym cannot be moved to another wallet', stolenVerdict.reason === 'pseudonym_taken', stolenVerdict.reason);

  // Two rides, two days, one wallet paying for both.
  const before = await balance(root);
  const rideOn = async (dayKey, at) => {
    legSeq += 1;
    const price = priceDistance(3300);
    const receipt = signLeg(buildLeg({
      vehicleId: PLATE, tripId: 'TPROOF', legId: `LPSEUDO${legSeq}`,
      passengerPublicKey: dayKey.publicKey, boardDoorId: 'A', alightDoorId: 'B',
      boardOdoM: 1000, alightOdoM: 1000 + 3300, distanceM: 3300, distanceSource: 'odometer',
      boardAt: at, alightAt: at + 600, concession: 'none', amount: price.amount, tariffCode: TARIFF.code,
    }), vehicle.secretKey);
    const tap = signTap(buildTap({
      passengerPublicKey: dayKey.publicKey, vehicleId: PLATE, doorId: 'A', timestamp: at,
    }), dayKey.secretKey);
    return upload(receipt, tap);
  };

  const mon = await rideOn(monday, boardAt);
  const tue = await rideOn(tuesday, boardAt + 300);
  const fare = priceDistance(3300).amount;
  check('a ride signed by a day-key settles', mon.ok === true && tue.ok === true, JSON.stringify([mon.reason, tue.reason]));
  check('both days came out of the one wallet', (await balance(root)) === before - 2 * fare, `Rs ${await balance(root)}`);

  // What the operator's own copy of those rides actually says.
  const seen = await db.query(
    'select distinct passenger_public_key from legs where leg_id in ($1, $2)',
    [mon.legId, tue.legId],
  );
  const keys = seen.rows.map((r) => r.passenger_public_key);
  check('the operator sees two unrelated keys, not one passenger', keys.length === 2);
  check('and never sees the wallet behind them', !keys.includes(root.publicKey), keys.join(', '));
  line('what the fleet can read', `${keys.length} day-keys, 0 links — the mapping is service-role only`);

  /*
    The hole rotation opens if nobody thinks about it: settlement registers
    whoever a receipt names, so a fresh key every day would draw the signup
    credit every day, and rotating faster would print money. A known pseudonym
    is not a new device.
  */
  const [, credited] = await handleSync(
    db,
    { devicePublicKey: 'proof', keyLinks: [linkFor(deriveDailyKeypair(seed, today + 2))] },
    { signupCredit: 2000 },
  );
  check('filing a new day-key is not a new signup', credited.linkResults[0].ok === true);
  const topups = await db.query(
    "select coalesce(sum(amount), 0)::int as rs from wallet_topups where source = 'demo' and public_key in (select pseudonym_public_key from passenger_keys where root_public_key = $1)",
    [root.publicKey],
  );
  check('no day-key was ever credited a signup bonus', topups.rows[0].rs === 0, `Rs ${topups.rows[0].rs}`);
  const walletRow = await db.query('select balance from passengers where public_key = $1', [root.publicKey]);
  check('the wallet is exactly what it started with, less two fares',
    walletRow.rows[0].balance === 400 - 2 * fare, `Rs ${walletRow.rows[0].balance}`);
}

// -------------------------------------------------- does a bus do this?

console.log('\n10. A receipt that no bus could have produced is scored, not refused');
{
  const rider = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 500) on conflict do nothing', [rider.publicKey]);

  const rideOf = async (distanceM, spanS, at) => {
    legSeq += 1;
    const price = priceDistance(distanceM);
    const receipt = signLeg(buildLeg({
      vehicleId: PLATE, tripId: 'TPROOF', legId: `LSPOOF${legSeq}`,
      passengerPublicKey: rider.publicKey, boardDoorId: 'A', alightDoorId: 'B',
      boardOdoM: 0, alightOdoM: distanceM, distanceM, distanceSource: 'odometer',
      boardAt: at, alightAt: at + spanS, concession: 'none',
      amount: price.amount, tariffCode: TARIFF.code,
    }), vehicle.secretKey);
    const tap = signTap(buildTap({
      passengerPublicKey: rider.publicKey, vehicleId: PLATE, doorId: 'A', timestamp: at,
    }), rider.secretKey);
    const verdict = await upload(receipt, tap);
    const row = await db.query('select plausibility, plausibility_flags from legs where leg_id = $1', [verdict.legId]);
    return { verdict, row: row.rows[0] };
  };

  // An ordinary ride: 3.3 km in eleven minutes, about 18 km/h.
  const honest = await rideOf(3300, 660, boardAt);
  check('an ordinary ride is not flagged', honest.verdict.ok === true && honest.row.plausibility === null,
    String(honest.row.plausibility));

  // The same eleven minutes, billed as 40 km. A bus that did this averaged
  // 218 km/h down Maitighar.
  const inflated = await rideOf(40000, 660, boardAt + 10);
  check('a ride billed faster than any bus can go is flagged', inflated.row.plausibility === 'high',
    String(inflated.row.plausibility));
  check('and the flag says what it found',
    inflated.row.plausibility_flags.some((f) => f.code === 'too_fast'),
    JSON.stringify(inflated.row.plausibility_flags.map((f) => f.code)));

  // Kilometres with no time on the clock at all.
  const instant = await rideOf(9000, 5, boardAt + 20);
  check('kilometres in five seconds is flagged', instant.row.plausibility === 'high',
    JSON.stringify(instant.row.plausibility_flags.map((f) => f.code)));

  // The point that matters: the passenger was still charged, every time.
  check('the fare settled anyway — a heuristic never refuses a ride',
    inflated.verdict.ok === true && instant.verdict.ok === true);
  check('and the money moved for all three',
    (await balance(rider)) === 500 - priceDistance(3300).amount - priceDistance(40000).amount - priceDistance(9000).amount,
    `Rs ${await balance(rider)}`);

  const rate = await db.query('select * from meter_plausibility where vehicle_plate = $1', [PLATE]);
  line('operator sees', `${rate.rows[0].flagged} of ${rate.rows[0].legs} legs flagged (${rate.rows[0].flagged_pct}%), ${rate.rows[0].flagged_high} high`);
  check('the operator reads a rate, not an incident', Number(rate.rows[0].flagged) === 2);
}

// ------------------------------------------------------------- overdraft

let overdraftLegs = 0;

console.log('\n11. Nobody is stranded over Rs 10');
{
  const broke = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 5) on conflict do nothing', [broke.publicKey]);

  const ride = async (at) => {
    legSeq += 1;
    const price = priceDistance(3300);
    const receipt = signLeg(buildLeg({
      vehicleId: PLATE, tripId: 'TPROOF', legId: `LBROKE${legSeq}`,
      passengerPublicKey: broke.publicKey, boardDoorId: 'A', alightDoorId: 'B',
      boardOdoM: 0, alightOdoM: 3300, distanceM: 3300, distanceSource: 'odometer',
      boardAt: at, alightAt: at + 660, concession: 'none',
      amount: price.amount, tariffCode: TARIFF.code,
    }), vehicle.secretKey);
    const tap = signTap(buildTap({
      passengerPublicKey: broke.publicKey, vehicleId: PLATE, doorId: 'A', timestamp: at,
    }), broke.secretKey);
    return upload(receipt, tap);
  };

  // Rs 5 in the wallet, an Rs 18 fare. Before the overdraft this passenger was
  // left at the stop.
  const first = await ride(boardAt);
  check('a ride is taken on credit rather than refused', first.ok === true, JSON.stringify(first));
  check('and the wallet shows the debt', (await balance(broke)) === 5 - priceDistance(3300).amount,
    `Rs ${await balance(broke)}`);

  // Rs -13, then -31, then -49: all inside the Rs 50 overdraft. The next Rs 18
  // would reach -67, and is refused.
  const second = await ride(boardAt + 20);
  const third = await ride(boardAt + 40);
  check('two more rides fit inside the overdraft', second.ok === true && third.ok === true,
    JSON.stringify([second.reason, third.reason]));
  const refused = await ride(boardAt + 60);
  check('the credit runs out rather than growing', refused.ok === false && refused.reason === 'insufficient_balance',
    JSON.stringify(refused));
  check('and the refusal says how far behind', refused.balance === -49 && refused.overdraft === 50 && refused.shortfall === 17,
    JSON.stringify(refused));
  check('the floor is the overdraft, never open-ended', (await balance(broke)) === -49, `Rs ${await balance(broke)}`);
  const column = await db.query(
    "select column_default from information_schema.columns where table_name = 'passengers' and column_name = 'overdraft_npr'");
  check('the database overdraft is the protocol one', Number(column.rows[0]?.column_default) === OVERDRAFT_NPR,
    `SQL ${column.rows[0]?.column_default}, protocol ${OVERDRAFT_NPR}`);

  // settle_leg is not the only thing that could move a balance, so the table
  // holds the floor too.
  const past = await db.query('update passengers set balance = -51 where public_key = $1', [broke.publicKey])
    .then(() => null, (e) => e.message);
  check('the table refuses a wallet past its overdraft', Boolean(past), past ?? 'accepted');

  const owing = await db.query('select owed from wallet_overdrafts where public_key = $1', [broke.publicKey]);
  line('carried as a debt', `Rs ${owing.rows[0].owed} owed`);
  check('the operator can see the float', Number(owing.rows[0].owed) === 49);

  // The debt comes out of the next top-up. Nothing else has to remember it.
  const topup = await db.query("select credit_wallet($1, 100, 'cash', 'proof:overdraft') as r", [broke.publicKey]);
  check('a top-up clears the debt first', topup.rows[0].r.ok === true && (await balance(broke)) === 51,
    `Rs ${await balance(broke)}`);
  const cleared = await db.query('select count(*)::int as n from wallet_overdrafts where public_key = $1', [broke.publicKey]);
  check('and the wallet leaves the overdraft list', cleared.rows[0].n === 0);
  overdraftLegs = 3;
}

// -------------------------------------------------------- operator signup

console.log('\n12. An owner can sign up and name their company');
{
  const as = (uid) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid ?? '']);
  const uid = '6f1c2a0e-5b3d-4c1e-9a7f-2d8e4b6c0a11';
  await db.query('insert into auth.users (id, email) values ($1, $2)', [uid, 'owner@proof.np']);

  await as(null);
  const anonymous = (await db.query("select register_operator('Nobody') as r")).rows[0].r;
  check('nobody signed in cannot register', anonymous.reason === 'not_signed_in', JSON.stringify(anonymous));

  await as(uid);
  const before = (await db.query('select my_operator() as r')).rows[0].r;
  check('a new owner starts unregistered', before.registered === false, JSON.stringify(before));

  const made = await db.query("select register_operator('Mayur Yatayat') as r").then((q) => q.rows[0].r, (e) => ({ error: e.message }));
  check('registering the company works', made.ok === true && made.created === true, JSON.stringify(made));
  check('and gets a readable id', /^MAYURYATAYAT-[0-9A-F]{5}$/.test(made.operator_id ?? ''), made.operator_id);

  const after = (await db.query('select my_operator() as r')).rows[0].r;
  check('the dashboard now finds the company', after.registered === true && after.name === 'Mayur Yatayat', JSON.stringify(after));

  const twice = (await db.query("select register_operator('Someone Else') as r")).rows[0].r;
  check('registering again keeps the first company', twice.created === false && twice.operator_id === made.operator_id, JSON.stringify(twice));
  await as(null);
}

// ------------------------------------------------------------------ routes

console.log('\n13. Every route has its stops in order and a fare for every pair');
{
  const routes = (await db.query('select * from route_directory order by id')).rows;
  line('routes', routes.map((r) => `${r.id} (${r.stops})`).join(', '));
  check('more than one route', routes.length >= 9, String(routes.length));
  check('every route has at least three stops', routes.every((r) => r.stops >= 3));

  const gaps = await db.query(`
    select route_id from route_stops group by route_id
    having min(ordinal) <> 1 or max(ordinal) <> count(*)`);
  check('stop order has no gaps on any route', gaps.rows.length === 0, JSON.stringify(gaps.rows));

  const r11 = await db.query(`
    select count(*)::int as n from route_stops rs join stops s on s.code = rs.stop_code
     where rs.route_id = 'R11' and s.ordinal = rs.ordinal`);
  check('R11 kept its seven stops in the same order', r11.rows[0].n === 7, String(r11.rows[0].n));

  const missing = await db.query(`
    select a.route_id, a.stop_code as board, b.stop_code as alight
      from route_stops a
      join route_stops b on b.route_id = a.route_id and b.ordinal > a.ordinal
      left join fares f on f.route_id = a.route_id and f.boarding_stop = a.stop_code and f.alighting_stop = b.stop_code
     where f.amount is null`);
  check('a stage fare exists for every ordered pair', missing.rows.length === 0, JSON.stringify(missing.rows.slice(0, 3)));

  const wrong = await db.query(`
    select f.* from fares f
      join route_stops a on a.route_id = f.route_id and a.stop_code = f.boarding_stop
      join route_stops b on b.route_id = f.route_id and b.stop_code = f.alighting_stop
     where f.amount <> least(25, 15 + (b.ordinal - a.ordinal - 1) * 5)`);
  check('every stage fare follows the published rule', wrong.rows.length === 0, JSON.stringify(wrong.rows.slice(0, 3)));

  const r11fares = await db.query("select count(*)::int as n from fares where route_id = 'R11'");
  check('R11 still has its 21 fares', r11fares.rows[0].n === 21, String(r11fares.rows[0].n));
}

// ----------------------------------------------------------- local time

console.log('\n14. The dashboard counts hours and days in Kathmandu time');
{
  const TPLATE = 'BA9KHA9999';
  await db.query("insert into vehicles (plate, operator_id, route_id) values ($1, 'SAJHA', 'R11')", [TPLATE]);
  const rider = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 0)', [rider.publicKey]);
  // 08:00 UTC is 13:45 in Kathmandu; 18:30 UTC is 00:15 the next day there.
  const fares = [['TZ1', '2026-09-01T08:00:00Z'], ['TZ2', '2026-09-01T18:30:00Z']];
  for (const [nonce, at] of fares) {
    await db.query(
      `insert into transactions (nonce, passenger_public_key, vehicle_plate, amount, boarding_stop, alighting_stop,
                                 sequence_number, issued_at, collected_at, settled_at, settled_by)
       values ($1, $2, $3, 20, 'RATNAPARK', 'KOTESHWOR', $4, $5, $5, $5, 'proof')`,
      [nonce, rider.publicKey, TPLATE, nonce === 'TZ1' ? 1 : 2, at],
    );
  }
  const hours = (await db.query('select hour from operator_hourly where vehicle_plate = $1 order by hour', [TPLATE])).rows.map((r) => r.hour);
  check('a fare at 08:00 UTC is charted at 13:00, and one at 18:30 UTC at 00:00', JSON.stringify(hours) === '[0,13]', JSON.stringify(hours));
  const days = (await db.query(
    "select to_char(day at time zone 'Asia/Kathmandu', 'YYYY-MM-DD') as d from operator_daily where vehicle_plate = $1 order by day", [TPLATE],
  )).rows.map((r) => r.d);
  check('and the late fare lands on the next Kathmandu day', JSON.stringify(days) === '["2026-09-01","2026-09-02"]', JSON.stringify(days));
  await db.query('delete from transactions where vehicle_plate = $1', [TPLATE]);
  await db.query('delete from vehicles where plate = $1', [TPLATE]);
}

// ------------------------------------------------------------- accounts

// Logins, as Supabase Auth would hold them. A proof plays one by setting the
// JWT claim; the sync function knows one by its access token.
const as = (uid) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid ?? '']);
const call = async (sql, args = []) => (await db.query(`select ${sql} as r`, args)).rows[0].r;
const tokenFor = (uid) => `local:${uid}`;
const ADMIN = '0a000000-0000-4000-8000-000000000001';
const RIDER = '0b000000-0000-4000-8000-000000000002';
const OTHER = '0c000000-0000-4000-8000-000000000003';
await db.query("insert into auth.users (id, email) values ($1, 'admin@proof.np'), ($2, 'rider@proof.np'), ($3, 'other@proof.np')",
  [ADMIN, RIDER, OTHER]);
await db.query('insert into platform_admins (user_id) values ($1)', [ADMIN]);

const APLATE = 'BA3KHA1001';
const aVehicle = createKeypair();
await sync({ meter: { vehicleId: APLATE, publicKey: aVehicle.publicKey, capacity: 40, firmware: 'proof' } });
let accountLegs = 0;

// A phone with a wallet and today's day-key, the way the app holds them.
const riderSeed = createMasterSeed();
const riderWallet = createKeypair();
const riderDay = deriveDailyKeypair(riderSeed, dayIndex());
const riderPk1 = signLink(buildLink({
  rootPublicKey: riderWallet.publicKey, pseudonymPublicKey: riderDay.publicKey, day: dayIndex(),
}), riderWallet.secretKey, riderDay.secretKey);

const linkFor = (uid, wallet = riderWallet, at = Math.floor(Date.now() / 1000)) =>
  signAccountLink(buildAccountLink({ userId: uid, walletPublicKey: wallet.publicKey, timestamp: at }), wallet.secretKey);
const linkWith = async (accountLink) => (await sync({ accountLink })).accountResult;

console.log('\n15. A login can only claim a wallet its phone holds');
{
  const forged = signAccountLink(buildAccountLink({ userId: RIDER, walletPublicKey: riderWallet.publicKey }), bystander.secretKey);
  check('a link not signed by the wallet is refused',
    (await linkWith({ link: forged, accessToken: tokenFor(RIDER) })).reason === 'bad_signature');
  check('a stale link is refused',
    (await linkWith({ link: linkFor(RIDER, riderWallet, Math.floor(Date.now() / 1000) - 3600), accessToken: tokenFor(RIDER) })).reason === 'stale');
  check('nobody signed in cannot link',
    (await linkWith({ link: linkFor(RIDER) })).reason === 'not_signed_in');
  check('a link made for one login cannot be used by another',
    (await linkWith({ link: linkFor(RIDER), accessToken: tokenFor(OTHER) })).reason === 'wrong_user');

  const linked = await linkWith({ link: linkFor(RIDER), accessToken: tokenFor(RIDER) });
  check('the phone links its wallet to its login', linked?.ok === true && linked.created === true, JSON.stringify(linked));
  const again = await linkWith({ link: linkFor(RIDER), accessToken: tokenFor(RIDER) });
  check('linking again changes nothing', again?.ok === true && again.created === false, JSON.stringify(again));
  check('one login holds one wallet',
    (await linkWith({ link: linkFor(RIDER, bystander), accessToken: tokenFor(RIDER) })).reason === 'account_has_wallet');
  check('one wallet belongs to one login',
    (await linkWith({ link: linkFor(OTHER), accessToken: tokenFor(OTHER) })).reason === 'wallet_taken');

  await as(RIDER);
  const me = await call('my_account()');
  check('the login now sees its wallet', me.linked === true && me.wallet === riderWallet.publicKey, JSON.stringify(me));
  await as(OTHER);
  check('another login sees none', (await call('my_account()')).linked === false);
  await as(null);
}

console.log('\n16. The statement adds up, across day-keys and both fare paths');
{
  await db.query("select credit_wallet($1, 500, 'cash', 'proof:statement')", [riderWallet.publicKey]);

  // A stage fare signed with today's key, uploaded with the key's PK1.
  const ticket = signToken(buildToken({
    passengerPublicKey: riderDay.publicKey, conductorId: APLATE, amount: 25,
    boardingStop: 'RATNAPARK', alightingStop: 'KOTESHWOR', sequenceNumber: 1,
  }), riderDay.secretKey);
  const stage = await sync({ keyLinks: [riderPk1], tickets: [ticket] });
  check('a stage fare signed with a day-key settles against the wallet', stage.results[0]?.ok === true, JSON.stringify(stage.results[0]));
  check('and the money came out of the wallet', (await balance(riderWallet)) === 475, `Rs ${await balance(riderWallet)}`);

  // A metered ride nobody closed, then the dead phone's claim on it.
  const at = boardAt + 400;
  accountLegs += 1;
  const cap = signLeg(buildLeg({
    vehicleId: APLATE, tripId: 'TACCT', legId: 'LACCTUNCLOSED', passengerPublicKey: riderDay.publicKey,
    boardDoorId: 'A', alightDoorId: 'A', boardOdoM: 0, alightOdoM: 400, distanceM: 400,
    distanceSource: 'unclosed', boardAt: at, alightAt: at + 3600, concession: 'none',
    amount: priceDistance(400, { unclosed: true }).amount, tariffCode: TARIFF.code,
  }), aVehicle.secretKey);
  const tap = signTap(buildTap({ passengerPublicKey: riderDay.publicKey, vehicleId: APLATE, doorId: 'A', timestamp: at }), riderDay.secretKey);
  const ride = (await sync({ keyLinks: [riderPk1], legs: [{ receipt: cap, tap }] })).legResults[0];
  check('the ride settles at the cap', ride?.ok === true, JSON.stringify(ride));
  const claim = signDispute(buildDispute({
    passengerPublicKey: riderDay.publicKey, vehicleId: APLATE, legId: 'LACCTUNCLOSED', witnessM: 400, witnessAt: at + 600,
  }), riderDay.secretKey);
  const refund = (await sync({ disputes: [claim] })).disputeResults[0];
  check('a dead-phone refund on a day-key ride is paid', refund?.ok === true, JSON.stringify(refund));
  const expected = 500 - 25 - TARIFF.unclosedLegFare + refund.refund;
  check('and lands in the wallet, not on the day-key', (await balance(riderWallet)) === expected, `Rs ${await balance(riderWallet)}`);

  await as(ADMIN);
  const adjusted = await call("admin_adjust_wallet($1, -5, 'Proof correction')", [riderWallet.publicKey]);
  check('an admin correction posts', adjusted.ok === true, JSON.stringify(adjusted));
  await as(RIDER);
  const statement = await call('my_statement()');
  const sum = statement.entries.reduce((s, e) => s + e.amount, 0);
  line('statement', statement.entries.map((e) => `${e.kind} ${e.amount}`).join(', '));
  check('the statement balance is the wallet balance', statement.balance === expected - 5, String(statement.balance));
  check('the entries add up to it', sum === statement.balance, `${sum} vs ${statement.balance}`);
  check('every kind of movement is there',
    ['topup', 'stage_fare', 'ride', 'refund', 'adjustment'].every((k) => statement.entries.some((e) => e.kind === k)),
    [...new Set(statement.entries.map((e) => e.kind))].join(','));
  check('each entry carries the balance after it', statement.entries[0].balance_after === statement.balance);
  await as(null);
}

console.log('\n17. A top-up request is loaded once, by an admin');
{
  await as(RIDER);
  check('an unknown method is refused', (await call("request_topup('paypal', 100, 'X1')")).reason === 'bad_method');
  check('only eSewa is accepted', (await call("request_topup('khalti', 100, 'X1')")).reason === 'bad_method'
    && (await call("request_topup('fonepay', 100, 'X1')")).reason === 'bad_method'
    && (await call("request_topup('imepay', 100, 'X1')")).reason === 'bad_method');
  check('an amount outside Rs 10-10000 is refused', (await call("request_topup('esewa', 5, 'X1')")).reason === 'bad_amount');
  check('a request needs the payment reference', (await call("request_topup('esewa', 100, '  ')")).reason === 'reference_required');
  const asked = await call("request_topup('esewa', 300, 'ESW-001')");
  check('a request is filed as pending', asked.ok === true && asked.status === 'pending', JSON.stringify(asked));
  check('the same payment reference cannot be used twice',
    (await call("request_topup('esewa', 300, 'ESW-001')")).reason === 'duplicate_reference');
  for (let i = 2; i <= 5; i += 1) await call(`request_topup('esewa', 50, 'ESW-00${i}')`);
  check('no more than five requests wait at once', (await call("request_topup('esewa', 50, 'ESW-006')")).reason === 'too_many_pending');
  const mine = await call('my_topup_requests()');
  check('the rider sees their requests', mine.length === 5 && mine.every((r) => r.status === 'pending'), String(mine.length));

  check('a rider cannot load their own request', (await call('admin_load_topup($1)', [asked.id])).reason === 'not_admin');

  await as(ADMIN);
  const before = await balance(riderWallet);
  const loaded = await call('admin_load_topup($1)', [asked.id]);
  check('an admin loads it', loaded.ok === true && loaded.balance === before + 300, JSON.stringify(loaded));
  check('loading it again is refused', (await call('admin_load_topup($1)', [asked.id])).reason === 'already_decided');
  check('and the money moved once', (await balance(riderWallet)) === before + 300);
  const second = mine.find((r) => r.reference === 'ESW-002');
  check('a rejection needs a reason', (await call("admin_reject_topup($1, '')", [second.id])).reason === 'reason_required');
  check('a rejection with one is recorded', (await call("admin_reject_topup($1, 'No such payment')", [second.id])).ok === true);
  const queue = await call("admin_topup_requests('pending')");
  check('the admin queue shows what is left, with the login', queue.length === 3 && queue[0].email === 'rider@proof.np', JSON.stringify(queue[0]));

  await as(RIDER);
  const statuses = (await call('my_topup_requests()')).map((r) => r.status).sort();
  check('the rider sees loaded and rejected', statuses.includes('loaded') && statuses.includes('rejected'), statuses.join(','));
  const credit = (await call('my_statement()')).entries.find((e) => e.kind === 'topup' && e.amount === 300);
  check('the loaded request is on the statement as eSewa', credit?.title === 'Top-up · eSewa', JSON.stringify(credit));
  await as(null);
}

console.log('\n18. Only an admin can act as one');
{
  const adminCalls = [
    'admin_overview()', "admin_passengers('')", "admin_operators('')", "admin_topup_requests('pending')",
    `admin_statement('${riderWallet.publicKey}')`, 'admin_load_topup(1)', "admin_reject_topup(1, 'x')",
    `admin_load_cash('${riderWallet.publicKey}', 10, 'x')`, `admin_adjust_wallet('${riderWallet.publicKey}', 10, 'xxxx')`,
    `admin_set_suspended('passenger', '${riderWallet.publicKey}', true)`, "admin_set_setting('esewa_id', 'x')",
    'admin_client_errors(10)',
  ];
  for (const uid of [RIDER, null]) {
    await as(uid);
    const verdicts = [];
    for (const sql of adminCalls) {
      const r = await call(sql).catch((e) => ({ reason: e.message }));
      verdicts.push(Array.isArray(r) ? 'rows' : r?.reason);
    }
    check(`every admin function refuses ${uid ? 'a rider' : 'nobody signed in'}`,
      verdicts.every((v) => v === 'not_admin'), verdicts.join(','));
  }
  await as(ADMIN);
  const overview = await call('admin_overview()');
  check('the admin sees the platform', overview.ok === true && overview.pending_requests === 3 && overview.accounts >= 1, JSON.stringify(overview));
  const found = await call("admin_passengers('rider@')");
  check('and can find a passenger by login', found.length === 1 && found[0].wallet === riderWallet.publicKey, JSON.stringify(found[0]));
  const cash = await call(`admin_load_cash($1, 100, 'Counter at Ratna Park')`, [riderWallet.publicKey]);
  check('and load cash at a counter', cash.ok === true, JSON.stringify(cash));
  check('settings are admin-written and rider-readable', (await call("admin_set_setting('esewa_id', '9800000001')")).ok === true);
  await as(RIDER);
  const settings = (await db.query('select value from platform_settings where key = $1', ['esewa_id'])).rows[0];
  check('the rider reads the merchant id', settings?.value === '9800000001');
  await as(null);
}

console.log('\n19. Suspension closes the portal, not the ride');
{
  await as(ADMIN);
  await call('admin_set_suspended($1, $2, true)', ['passenger', riderWallet.publicKey]);
  await as(RIDER);
  check('a suspended rider cannot request a top-up', (await call("request_topup('esewa', 100, 'ESW-SUS')")).reason === 'suspended');
  check('and the portal says so', (await call('my_account()')).suspended === true);
  const at = boardAt + 500;
  accountLegs += 1;
  const receipt = signLeg(buildLeg({
    vehicleId: APLATE, tripId: 'TACCT', legId: 'LACCTSUSPENDED', passengerPublicKey: riderDay.publicKey,
    boardDoorId: 'A', alightDoorId: 'B', boardOdoM: 1000, alightOdoM: 4300, distanceM: 3300, distanceSource: 'odometer',
    boardAt: at, alightAt: at + 600, concession: 'none', amount: priceDistance(3300).amount, tariffCode: TARIFF.code,
  }), aVehicle.secretKey);
  const tap = signTap(buildTap({ passengerPublicKey: riderDay.publicKey, vehicleId: APLATE, doorId: 'A', timestamp: at }), riderDay.secretKey);
  const ride = (await sync({ keyLinks: [riderPk1], legs: [{ receipt, tap }] })).legResults[0];
  check('a ride already taken still settles', ride?.ok === true, JSON.stringify(ride));

  await as(ADMIN);
  await call('admin_set_suspended($1, $2, false)', ['passenger', riderWallet.publicKey]);
  await as(RIDER);
  check('reactivated, the rider can request again', (await call("request_topup('esewa', 100, 'ESW-BACK')")).ok === true);

  // An operator owner, suspended, loses the dashboard.
  const OWNER = '0d000000-0000-4000-8000-000000000004';
  await db.query("insert into auth.users (id, email) values ($1, 'owner@proof.np')", [OWNER]);
  await as(OWNER);
  const company = await call("register_operator('Suspend Yatayat')");
  check('an owner registers', company.ok === true);
  await as(ADMIN);
  const ops = await call("admin_operators('suspend')");
  check('the admin finds the operator', ops.length === 1 && ops[0].id === company.operator_id, JSON.stringify(ops));
  await call('admin_set_suspended($1, $2, true)', ['operator', company.operator_id]);
  await as(OWNER);
  const mine = await call('my_operator()');
  check('a suspended operator is told so', mine.suspended === true, JSON.stringify(mine));
  check('and reads no operator data', (await call('current_operator_id()')) === null);
  await as(null);

  const wrong = await call('admin_adjust_wallet($1, -99999, $2)', [riderWallet.publicKey, 'too much']).catch((e) => ({ reason: e.message }));
  check('a correction cannot pass the overdraft floor (and needs an admin)', wrong.reason === 'not_admin');
  await as(ADMIN);
  check('a correction needs a reason', (await call("admin_adjust_wallet($1, -1, '')", [riderWallet.publicKey])).reason === 'reason_required');
  check('a correction cannot pass the overdraft floor', (await call("admin_adjust_wallet($1, -99999, 'too much')", [riderWallet.publicKey])).reason === 'below_floor');
  await as(null);
}

console.log('\n20. A gateway top-up is credited on the gateway\'s word, once');
{
  const hmac = async (key, message) => createHmac('sha256', key).update(message).digest('base64');
  const { secretKey, productCode } = ESEWA.test;

  // eSewa's own sample form: these three values sign to this string.
  const sample = await esewaForm({
    amount: 110, transactionUuid: '241028', productCode, secretKey,
    successUrl: 'https://example.np/ok', failureUrl: 'https://example.np/no', hmac,
  });
  check('the eSewa form is signed the way eSewa signs its sample', sample.signature === 'i94zsd3oXF6ZsSr/kGqT4sSzYQzjj1W/waxjWyRwaME=', sample.signature);

  const opened = await call('gateway_open_topup($1, $2, $3)', [RIDER, 'esewa', 250]);
  check('a gateway request opens for a linked rider', opened.ok === true && /^BH-\d{6}-[0-9A-F]{12}$/.test(opened.reference), JSON.stringify(opened));
  check('a login with no wallet cannot open one', (await call('gateway_open_topup($1, $2, $3)', [OTHER, 'esewa', 250])).reason === 'not_linked');
  check('only eSewa opens at the gateway', (await call('gateway_open_topup($1, $2, $3)', [RIDER, 'fonepay', 250])).reason === 'bad_method'
    && (await call('gateway_open_topup($1, $2, $3)', [RIDER, 'khalti', 250])).reason === 'bad_method');

  await as(ADMIN);
  const queue = await call("admin_topup_requests('pending')");
  check('an unpaid gateway request is not work for the admin', !queue.some((r) => r.reference === opened.reference));
  await as(null);

  // What eSewa sends back, signed by eSewa.
  const returned = async (fields) => {
    const names = 'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names';
    const message = { transaction_code: '000AWEO', product_code: productCode, signed_field_names: names, ...fields };
    message.signature = await hmac(secretKey, esewaMessage(message, names));
    return Buffer.from(JSON.stringify(message)).toString('base64');
  };
  const good = await returned({ status: 'COMPLETE', total_amount: '250.0', transaction_uuid: opened.reference });
  const read = await readEsewaReturn(good, { secretKey, hmac });
  check('a signed eSewa return is read', read.ok === true && read.amount === 250 && read.transactionUuid === opened.reference, JSON.stringify(read));
  const tampered = JSON.parse(Buffer.from(good, 'base64').toString());
  tampered.total_amount = '2500.0';
  check('an edited amount breaks the signature',
    (await readEsewaReturn(Buffer.from(JSON.stringify(tampered)).toString('base64'), { secretKey, hmac })).reason === 'bad_signature');
  check('a pending payment is not read as paid',
    (await readEsewaReturn(await returned({ status: 'PENDING', total_amount: '250.0', transaction_uuid: opened.reference }), { secretKey, hmac })).reason === 'not_complete');
  check('the status API must agree on the amount',
    esewaSettled({ status: 'COMPLETE', transaction_uuid: opened.reference, total_amount: 25 }, { transactionUuid: opened.reference, amount: 250 }).reason === 'amount_mismatch');
  check('and on the transaction',
    esewaSettled({ status: 'COMPLETE', transaction_uuid: 'BH-OTHER', total_amount: 250 }, { transactionUuid: opened.reference, amount: 250 }).reason === 'wrong_transaction');
  check('Khalti amounts are checked in paisa',
    khaltiSettled({ status: 'Completed', total_amount: 250 }, { amount: 250 }).reason === 'amount_mismatch'
    && khaltiSettled({ status: 'Completed', total_amount: 25000, transaction_id: 'K1' }, { amount: 250 }).ok === true);
  check('Khalti is sent paisa', khaltiInitiateBody({ amount: 250, reference: 'R', returnUrl: 'u', websiteUrl: 'w' }).amount === 25000);

  const before = await balance(riderWallet);
  const done = await call('gateway_complete_topup($1, $2, $3, $4)', [opened.reference, 'esewa', 250, '000AWEO']);
  check('a confirmed payment credits the wallet', done.ok === true && (await balance(riderWallet)) === before + 250, JSON.stringify(done));
  const again = await call('gateway_complete_topup($1, $2, $3, $4)', [opened.reference, 'esewa', 250, '000AWEO']);
  check('confirming twice credits once', again.already === true && (await balance(riderWallet)) === before + 250, JSON.stringify(again));
  check('a reference cannot be completed as another method',
    (await call('gateway_complete_topup($1, $2, $3, $4)', [opened.reference, 'khalti', 250, 'X'])).reason === 'not_found');

  const short = await call('gateway_open_topup($1, $2, $3)', [RIDER, 'esewa', 400]);
  check('a gateway session is pinned to its request', (await call('gateway_attach_topup($1, $2)', [short.reference, 'PIDX-1'])).ok === true);
  check('and cannot be re-pinned', (await call('gateway_attach_topup($1, $2)', [short.reference, 'PIDX-2'])).ok === false);
  check('only its owner can look the request up',
    (await call('gateway_request_for($1, $2)', [RIDER, short.reference])).provider_ref === 'PIDX-1'
    && (await call('gateway_request_for($1, $2)', [OTHER, short.reference])).reason === 'not_found');
  const mismatch = await call('gateway_complete_topup($1, $2, $3, $4)', [short.reference, 'esewa', 40, 'K2']);
  check('a payment for the wrong amount credits nothing', mismatch.reason === 'amount_mismatch' && (await balance(riderWallet)) === before + 250);
  await as(ADMIN);
  const flagged = (await call("admin_topup_requests('pending')")).find((r) => r.reference === short.reference);
  check('and waits for a person, with the reason', flagged?.note?.includes('Rs 40 against Rs 400'), JSON.stringify(flagged));
  await as(null);

  const abandoned = await call('gateway_open_topup($1, $2, $3)', [RIDER, 'esewa', 100]);
  check('an abandoned payment is marked failed', (await call('gateway_fail_topup($1, $2, $3)', [abandoned.reference, 'esewa', 'User cancelled'])).ok === true);
  check('and cannot be completed afterwards',
    (await call('gateway_complete_topup($1, $2, $3, $4)', [abandoned.reference, 'esewa', 100, 'X'])).reason === 'already_decided');

  await as(RIDER);
  const statement = await call('my_statement()');
  check('the gateway top-up is on the statement with its eSewa code',
    statement.entries.some((e) => e.title === 'Top-up · eSewa' && e.amount === 250 && e.detail === '000AWEO'));
  check('the statement still adds up', statement.entries.reduce((s, e) => s + e.amount, 0) === statement.balance);
  await as(null);
}

// ------------------------------------------------------- crew economics

let crewLegs = 0;

console.log('\n21. An honest trip pays the crew, and a pulled plug does not');
{
  const meter = { vehicleId: PLATE, publicKey: vehicle.publicKey, capacity: 42, firmware: 'proof' };
  const nowS = Math.floor(Date.now() / 1000);

  // A conductor is not an employee record: they hold an ordinary wallet, the
  // same one they ride on.
  const conductor = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 0) on conflict do nothing', [conductor.publicKey]);

  const rider = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 5000) on conflict do nothing', [rider.publicKey]);

  const signOnFor = (person, at = nowS) =>
    signSignOn(buildSignOn({ crewPublicKey: person.publicKey, vehicleId: PLATE, issuedAt: at }), person.secretKey);

  // One ride on a named trip, receipt and tap together, exactly as a door phone
  // uploads it.
  const rideOn = async (tripId, n) => {
    legSeq += 1;
    crewLegs += 1;
    const at = boardAt + n;
    const price = priceDistance(3300);
    const receipt = signLeg(buildLeg({
      vehicleId: PLATE, tripId, legId: `L${tripId}_${legSeq}`,
      passengerPublicKey: rider.publicKey, boardDoorId: 'A', alightDoorId: 'B',
      boardOdoM: 0, alightOdoM: 3300, distanceM: 3300, distanceSource: 'odometer',
      boardAt: at, alightAt: at + 600, concession: 'none',
      amount: price.amount, tariffCode: TARIFF.code,
    }), vehicle.secretKey);
    const tap = signTap(buildTap({
      passengerPublicKey: rider.publicKey, vehicleId: PLATE, doorId: 'A', timestamp: at,
    }), rider.secretKey);
    return upload(receipt, tap);
  };

  const runTrip = async (tripId, rides, extra = {}) => {
    await sync({ meter, crew: { signOn: signOnFor(conductor), tripIds: [tripId] } });
    for (let n = 0; n < rides; n += 1) await rideOn(tripId, n);
    if (extra.body) await sync({ meter, ...extra.body });
    const closed = await sync({ meter, closedTrips: [tripId] });
    return closed.tripResults[0];
  };

  const crewBalance = async () =>
    (await db.query('select balance from passengers where public_key = $1', [conductor.publicKey])).rows[0].balance;

  // --- the clean trip
  const clean = await runTrip('TCREW1', CLEAN_TRIP_MIN_LEGS + 2);
  check('a full trip with a quiet tape pays the bonus',
    clean.ok === true && clean.outcome === 'paid' && clean.amount === CLEAN_TRIP_BONUS_NPR, JSON.stringify(clean));
  check("and it reaches the conductor's wallet", (await crewBalance()) === CLEAN_TRIP_BONUS_NPR, `Rs ${await crewBalance()}`);

  const replayed = await sync({ meter, closedTrips: ['TCREW1'] });
  check('closing the same trip twice pays once', replayed.tripResults[0].reason === 'replay', JSON.stringify(replayed.tripResults[0]));
  check('the wallet did not move again', (await crewBalance()) === CLEAN_TRIP_BONUS_NPR, `Rs ${await crewBalance()}`);

  // --- the plug
  const pulled = await runTrip('TCREW2', CLEAN_TRIP_MIN_LEGS + 2, {
    body: { meterEvents: [{ tripId: 'TCREW2', at: new Date().toISOString(), kind: 'power_lost', moving: true, note: 'feed pulled' }] },
  });
  check('a trip whose meter lost its feed pays nothing',
    pulled.outcome === 'missed' && pulled.amount === 0, JSON.stringify(pulled));
  check('and the crew is told which reason it was',
    (pulled.reasons ?? []).some((r) => r.code === 'power_lost'), JSON.stringify(pulled.reasons));
  check('the wallet is unchanged', (await crewBalance()) === CLEAN_TRIP_BONUS_NPR, `Rs ${await crewBalance()}`);
  const tamper = await db.query("select count(*)::int as n from meter_events where trip_id = 'TCREW2' and kind = 'power_lost'");
  check('the pull is on the tape whether or not anyone looks', tamper.rows[0].n === 1, `${tamper.rows[0].n} row(s)`);

  // --- the override
  const overridden = await runTrip('TCREW3', CLEAN_TRIP_MIN_LEGS + 2, {
    body: { doorEvents: [{ tripId: 'TCREW3', at: new Date().toISOString(), kind: 'override_on', door: 'A', onboard: 44, capacity: 42 }] },
  });
  check('a trip that overrode the capacity interlock pays nothing',
    overridden.outcome === 'missed' && (overridden.reasons ?? []).some((r) => r.code === 'door_override'),
    JSON.stringify(overridden.reasons));

  // --- the empty trip
  const empty = await runTrip('TCREW4', CLEAN_TRIP_MIN_LEGS - 1);
  check('a trip that carried almost nobody pays nothing',
    empty.outcome === 'missed' && (empty.reasons ?? []).some((r) => r.code === 'too_few_legs'),
    JSON.stringify(empty.reasons));

  // --- nobody signed on
  for (let n = 0; n < CLEAN_TRIP_MIN_LEGS + 1; n += 1) await rideOn('TCREW5', n);
  const nobody = await sync({ meter, closedTrips: ['TCREW5'] });
  check('a trip run with nobody signed on is not an error, it just earns nothing',
    nobody.tripResults[0].reason === 'no_crew', JSON.stringify(nobody.tripResults[0]));

  // --- somebody else's signature
  const impostor = createKeypair();
  const forgedSignOn = signSignOn(
    buildSignOn({ crewPublicKey: conductor.publicKey, vehicleId: PLATE, issuedAt: nowS }),
    impostor.secretKey,
  );
  const forgedResult = await sync({ meter, crew: { signOn: forgedSignOn, tripIds: ['TCREW6'] } });
  check('a sign-on signed by somebody else is refused',
    forgedResult.crewResults[0].reason === 'bad_signature', JSON.stringify(forgedResult.crewResults[0]));

  // --- the first sign-on for a trip is not a replay of anything
  const firstOn = await sync({ meter, crew: { signOn: signOnFor(conductor), tripIds: ['TCREWA'] } });
  check('a first sign-on is reported as one, not as a replay',
    firstOn.crewResults[0].ok === true && firstOn.crewResults[0].reason === undefined,
    JSON.stringify(firstOn.crewResults[0]));
  const secondOn = await sync({ meter, crew: { signOn: signOnFor(conductor), tripIds: ['TCREWA'] } });
  check('the same crew signing on again is the replay', secondOn.crewResults[0].reason === 'replay',
    JSON.stringify(secondOn.crewResults[0]));

  // --- a trip whose rides reached the backend before its crew's sign-on did
  for (let n = 0; n < CLEAN_TRIP_MIN_LEGS + 1; n += 1) await rideOn('TCREWB', n);
  const late = await sync({ meter, crew: { signOn: signOnFor(conductor), tripIds: ['TCREWB'] } });
  check('a sign-on still lands on a trip whose rides arrived first', late.crewResults[0].ok === true,
    JSON.stringify(late.crewResults[0]));
  const lateClosed = await sync({ meter, closedTrips: ['TCREWB'] });
  check('and that trip still pays', lateClosed.tripResults[0].outcome === 'paid',
    JSON.stringify(lateClosed.tripResults[0]));

  // --- and the crew on a trip cannot be swapped once the rides are in
  await sync({ meter, crew: { signOn: signOnFor(conductor), tripIds: ['TCREW7'] } });
  const swap = await sync({ meter, crew: { signOn: signOnFor(impostor), tripIds: ['TCREW7'] } });
  check('a second sign-on cannot take over a trip already crewed',
    swap.crewResults[0].reason === 'crew_already_signed_on', JSON.stringify(swap.crewResults[0]));

  // --- a conductor who has never used Bhada
  const stranger = createKeypair();
  await sync({ meter, crew: { signOn: signOnFor(stranger), tripIds: ['TCREW8'] } });
  for (let n = 0; n < CLEAN_TRIP_MIN_LEGS + 1; n += 1) await rideOn('TCREW8', n);
  const noWallet = await sync({ meter, closedTrips: ['TCREW8'] });
  check('a clean trip for a conductor with no wallet is recorded, not paid into thin air',
    noWallet.tripResults[0].outcome === 'no_wallet' && noWallet.tripResults[0].amount === 0,
    JSON.stringify(noWallet.tripResults[0]));

  // --- the bonus follows the wallet, never the key the token names
  const seed = await createMasterSeed();
  const root = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 0) on conflict do nothing', [root.publicKey]);
  const today = dayIndex(nowS);
  const dayKey = await deriveDailyKeypair(seed, today);
  const link = signLink(buildLink({
    pseudonymPublicKey: dayKey.publicKey, rootPublicKey: root.publicKey, dayIndex: today,
  }), root.secretKey, dayKey.secretKey);
  await sync({ meter, keyLinks: [link] });
  await sync({ meter, crew: { signOn: signOnFor(dayKey), tripIds: ['TCREW9'] } });
  for (let n = 0; n < CLEAN_TRIP_MIN_LEGS + 1; n += 1) await rideOn('TCREW9', n);
  const pseudonymous = await sync({ meter, closedTrips: ['TCREW9'] });
  const rootBalance = (await db.query('select balance from passengers where public_key = $1', [root.publicKey])).rows[0].balance;
  const dayRow = (await db.query('select balance from passengers where public_key = $1', [dayKey.publicKey])).rows[0];
  check('a conductor signing on with a day-key is paid on the wallet behind it',
    pseudonymous.tripResults[0].outcome === 'paid' && rootBalance === CLEAN_TRIP_BONUS_NPR,
    `root Rs ${rootBalance}, day-key ${dayRow ? `Rs ${dayRow.balance}` : 'has no wallet'}`);

  // --- what the owner is out, against what the crews were paid
  const paid = await db.query('select coalesce(sum(amount), 0)::int as rs, count(*)::int as n from crew_bonuses');
  const credited = await db.query(
    'select coalesce(sum(balance), 0)::int as rs from passengers where public_key in ($1, $2)',
    [conductor.publicKey, root.publicKey],
  );
  check('every rupee a crew was paid is a rupee the operator owes',
    paid.rows[0].rs === credited.rows[0].rs, `Rs ${paid.rows[0].rs} recorded, Rs ${credited.rows[0].rs} in wallets`);
  line('bonus rows written', `${paid.rows[0].n} trips, Rs ${paid.rows[0].rs} paid`);

  const owner = await db.query('select * from operator_crew_bonuses where vehicle_plate = $1', [PLATE]);
  const misses = await db.query('select * from operator_bonus_misses where vehicle_plate = $1', [PLATE]);
  check('the owner view shows the trips and what they cost',
    owner.rows.length > 0 && owner.rows[0].bonus_npr === paid.rows[0].rs, JSON.stringify(owner.rows[0] ?? null));
  check('and every missed bonus carries its reasons', misses.rows.length > 0 && misses.rows.every((row) => row.reasons !== null),
    `${misses.rows.length} miss(es)`);
}

console.log('\n22. A crash is reported by anyone and read only by an admin');
{
  const report = (message, extra = {}) => call(
    'report_client_error($1, $2, $3, $4, $5, $6)',
    [extra.surface ?? 'terminal', message, extra.stack ?? null, '/terminal?door=A', 'proof', 'proof-agent'],
  );
  await as(null);
  check('a phone with no login can report a crash', (await report('TypeError: x is undefined')).ok === true);
  check('an empty report is refused', (await report('   ')).reason === 'empty');
  await report('y'.repeat(2000), { surface: 's'.repeat(100), stack: 'z'.repeat(10000) });
  const long = (await db.query("select length(message) as m, length(surface) as s, length(stack) as k from client_errors where message like 'yyy%'")).rows[0];
  check('every field is cut to its length', long.m === 500 && long.s === 40 && long.k === 4000, JSON.stringify(long));

  let anonRead = 'allowed';
  await db.query('set role anon');
  try { await db.query('select * from client_errors'); } catch (e) { anonRead = /permission denied for table client_errors/.test(e.message) ? 'refused' : e.message; }
  await db.query('reset role');
  check('the table itself is closed to the public', anonRead === 'refused', anonRead);

  await as(RIDER);
  check('a rider cannot read the reports', (await call('admin_client_errors(10)')).reason === 'not_admin');
  await as(ADMIN);
  const seen = await call('admin_client_errors(10)');
  check('an admin reads them, newest first', Array.isArray(seen) && seen.length === 2 && seen[0].message.startsWith('yyy'), `${seen.length} row(s)`);

  await as(null);
  const flood = [];
  for (let i = 0; i < 70; i += 1) flood.push((await report(`flood ${i}`)).reason ?? 'ok');
  const after = (await db.query('select count(*)::int as n from client_errors')).rows[0].n;
  check('a flood is held to 60 reports a minute', after === 60 && flood.at(-1) === 'rate_limited', `${after} row(s)`);

  await db.query("update client_errors set at = now() - interval '31 days'");
  await report('after a month');
  const left = (await db.query('select count(*)::int as n from client_errors')).rows[0].n;
  check('reports older than 30 days are dropped as new ones arrive', left === 1, `${left} row(s)`);
  await db.query('delete from client_errors');
}

console.log('\n23. Nothing the anon key can read skips row-level security');
{
  // Public on purpose: the network, the fares and who may sign concessions.
  // Everything else an API role can select must be a table with RLS on, or a
  // view that runs as the caller so the tables' RLS applies to it.
  const PUBLIC = new Set(['stops', 'routes', 'fares', 'tariffs', 'route_stops', 'route_directory', 'concession_issuers']);
  const open = await db.query(`
    select c.relname as name, c.relkind as kind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname <> '_migrations'
      and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))
      and case c.relkind
            when 'r' then not c.relrowsecurity
            when 'v' then not coalesce('security_invoker=true' = any(c.reloptions), false)
            else false
          end
    order by 1`);
  const leaks = open.rows.map((row) => row.name).filter((name) => !PUBLIC.has(name));
  check('no table without RLS and no owner-run view is open to the API roles', leaks.length === 0, leaks.join(', ') || 'none');

  // And what that means for the regulator return: its owner sees their buses,
  // anyone else sees nothing. Hand PLATE to the owner from section 12 for the
  // length of a transaction, and read as each API role would.
  const OWNER = '6f1c2a0e-5b3d-4c1e-9a7f-2d8e4b6c0a11';
  const total = (await db.query('select count(*)::int as n from dotm_daily_return where vehicle_plate = $1', [PLATE])).rows[0].n;
  await db.query('begin');
  await as(OWNER);
  await db.query('update vehicles set operator_id = current_operator_id() where plate = $1', [PLATE]);
  const readAs = async (role, uid) => {
    await as(uid);
    await db.query(`set local role ${role}`);
    const rows = (await db.query('select vehicle_plate from dotm_daily_return').catch((e) => ({ rows: [{ vehicle_plate: e.message }] }))).rows;
    await db.query('reset role');
    return rows;
  };
  const owner = await readAs('authenticated', OWNER);
  const stranger = await readAs('authenticated', RIDER);
  await db.query('rollback');
  // Outside the transaction: the refusal is an error, and an error inside one
  // would abort it.
  await as(null);
  await db.query('set role anon');
  const anonymous = await db.query('select vehicle_plate from dotm_daily_return')
    .then((q) => q.rows, (e) => [{ vehicle_plate: e.message }]);
  await db.query('reset role');
  check('the owner reads their own bus in the DoTM return', total > 0 && owner.length === total && owner.every((r) => r.vehicle_plate === PLATE),
    `${owner.length} of ${total}`);
  check('another login reads none of it', stranger.length === 0, `${stranger.length} row(s)`);
  check('and the anon key cannot read it at all', /permission denied/.test(anonymous[0]?.vehicle_plate ?? ''), anonymous[0]?.vehicle_plate ?? 'rows returned');
}

console.log('\n24. A lost phone does not lose the money');
{
  const MOVER = '0e000000-0000-4000-8000-000000000005';
  await db.query("insert into auth.users (id, email) values ($1, 'mover@proof.np')", [MOVER]);

  // A phone, as the app holds it: a wallet key and today's day-key.
  const phone = () => {
    const seed = createMasterSeed();
    const wallet = createKeypair();
    const day = deriveDailyKeypair(seed, dayIndex());
    const pk1 = signLink(buildLink({
      rootPublicKey: wallet.publicKey, pseudonymPublicKey: day.publicKey, day: dayIndex(),
    }), wallet.secretKey, day.secretKey);
    return { wallet, day, pk1 };
  };
  let n = 0;
  const ride = (who, at) => {
    n += 1;
    const receipt = signLeg(buildLeg({
      vehicleId: APLATE, tripId: 'TMOVE', legId: `LMOVE${n}`, passengerPublicKey: who.day.publicKey,
      boardDoorId: 'A', alightDoorId: 'B', boardOdoM: 1000, alightOdoM: 4300, distanceM: 3300, distanceSource: 'odometer',
      boardAt: at, alightAt: at + 600, concession: 'none', amount: priceDistance(3300).amount, tariffCode: TARIFF.code,
    }), aVehicle.secretKey);
    const tap = signTap(buildTap({ passengerPublicKey: who.day.publicKey, vehicleId: APLATE, doorId: 'A', timestamp: at }), who.day.secretKey);
    return { receipt, tap };
  };
  const balance = async (key) => (await db.query('select balance, overdraft_npr from passengers where public_key = $1', [key])).rows[0];
  const fare = priceDistance(3300).amount;
  const now = Math.floor(Date.now() / 1000);

  // The old phone: linked, topped up, one ride settled, one ride taken offline
  // and not yet uploaded when the phone is lost.
  const oldPhone = phone();
  await sync({ keyLinks: [oldPhone.pk1] });
  check('the old phone links to its login',
    (await linkWith({ link: linkFor(MOVER, oldPhone.wallet), accessToken: tokenFor(MOVER) }))?.ok === true);
  await as(ADMIN);
  await call("admin_load_cash($1, 300, 'Counter at Ratna Park')", [oldPhone.wallet.publicKey]);
  await as(null);
  const settledBefore = (await sync({ keyLinks: [oldPhone.pk1], legs: [ride(oldPhone, now - 3000)] })).legResults[0];
  accountLegs += 1;
  const offline = ride(oldPhone, now - 2000);
  check('a ride on the old phone settles', settledBefore?.ok === true && (await balance(oldPhone.wallet.publicKey)).balance === 300 - fare);

  // A new phone, same login.
  const newPhone = phone();
  await sync({ keyLinks: [newPhone.pk1] });
  const totalBefore = (await balance(oldPhone.wallet.publicKey)).balance + (await balance(newPhone.wallet.publicKey)).balance;
  check('without asking to move, the new phone is still refused',
    (await linkWith({ link: linkFor(MOVER, newPhone.wallet), accessToken: tokenFor(MOVER) })).reason === 'account_has_wallet');
  check('another login cannot move this money',
    (await linkWith({ link: linkFor(OTHER, newPhone.wallet), accessToken: tokenFor(MOVER), move: true })).reason === 'wrong_user');
  const moved = await linkWith({ link: linkFor(MOVER, newPhone.wallet), accessToken: tokenFor(MOVER), move: true });
  check('the login moves its money to the new phone', moved?.ok === true && moved.moved === true && moved.amount === 300 - fare,
    JSON.stringify(moved));
  // The move happened now; the proof places it 1000 s ago so a ride can be
  // taken on each side of it without a receipt from the future.
  await db.query("update wallet_moves set moved_at = to_timestamp($1) where to_wallet = $2", [now - 1000, newPhone.wallet.publicKey]);

  const oldAfter = await balance(oldPhone.wallet.publicKey);
  const newAfter = await balance(newPhone.wallet.publicKey);
  check('the old wallet is left empty with no overdraft', oldAfter.balance === 0 && oldAfter.overdraft_npr === 0, JSON.stringify(oldAfter));
  check('and not one rupee was made or lost', oldAfter.balance + newAfter.balance === totalBefore);
  check('moving again changes nothing',
    (await linkWith({ link: linkFor(MOVER, newPhone.wallet), accessToken: tokenFor(MOVER), move: true }))?.moved === false);

  const late = (await sync({ keyLinks: [oldPhone.pk1], legs: [offline] })).legResults[0];
  accountLegs += 1;
  check('a ride taken before the move, uploaded after, is paid from the new phone',
    late?.ok === true && (await balance(newPhone.wallet.publicKey)).balance === newAfter.balance - fare, JSON.stringify(late));

  const stolen = (await sync({ keyLinks: [oldPhone.pk1], legs: [ride(oldPhone, now - 500)] })).legResults[0];
  check('a ride on the old phone after the move is refused, not charged to the owner',
    stolen?.reason === 'insufficient_balance' && (await balance(newPhone.wallet.publicKey)).balance === newAfter.balance - fare,
    JSON.stringify(stolen));

  const fresh = (await sync({ keyLinks: [newPhone.pk1], legs: [ride(newPhone, now - 400)] })).legResults[0];
  accountLegs += 1;
  check('the new phone rides on the moved money', fresh?.ok === true);

  await as(MOVER);
  const statement = await call('my_statement(50)');
  await as(null);
  const rides = statement.entries.filter((e) => e.kind === 'ride');
  check('the statement carries the old phone\'s history and adds up',
    statement.balance === newAfter.balance - 2 * fare && rides.length === 3
      && !statement.entries.some((e) => e.kind === 'opening') && statement.entries[0].balance_after === statement.balance,
    `${rides.length} rides, balance ${statement.balance}`);

  const THIEF = '0f000000-0000-4000-8000-000000000006';
  await db.query("insert into auth.users (id, email) values ($1, 'thief@proof.np')", [THIEF]);
  check('a phone already holding a login\'s money cannot be taken by another login',
    (await linkWith({ link: linkFor(THIEF, newPhone.wallet), accessToken: tokenFor(THIEF), move: true })).reason === 'wallet_taken');
  check('a day-key is not a wallet to move into',
    (await call('move_wallet($1, $2, $3)', [MOVER, newPhone.day.publicKey, 'x'])).reason === 'not_a_wallet');
}

// ------------------------------------------------- 25. counts and cash

let countLegs = 0;

console.log('\n25. People who ride without tapping: cash tickets and the door count');
{
  // Its own bus, so the counter it gains does not follow the buses above.
  const PLATE2 = 'BA3KHA7777';
  const bus = createKeypair();
  const meter = { vehicleId: PLATE2, publicKey: bus.publicKey, capacity: 42, firmware: 'proof' };
  await sync({ meter });
  const conductor = createKeypair();
  const rider = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 0), ($2, 5000) on conflict do nothing', [conductor.publicKey, rider.publicKey]);
  const nowS = Math.floor(Date.now() / 1000);
  const signOn = signSignOn(buildSignOn({ crewPublicKey: conductor.publicKey, vehicleId: PLATE2, issuedAt: nowS }), conductor.secretKey);
  const walletSum = async () => Number((await db.query('select coalesce(sum(balance), 0) as s from passengers')).rows[0].s);

  const cashTicket = (tripId, { distanceM = 5300, amount, signer = bus } = {}) => signCashTicket(buildCashTicket({
    vehicleId: PLATE2, tripId, doorId: 'A', fromStop: 'RATNAPARK', toStop: 'NEWBANESHWOR',
    distanceM, amount: amount ?? priceDistance(distanceM).amount, tariffCode: TARIFF.code, issuedAt: nowS,
  }), signer.secretKey);

  const rideOn = async (tripId, n) => {
    legSeq += 1;
    countLegs += 1;
    const at = boardAt + n;
    const price = priceDistance(3300);
    const receipt = signLeg(buildLeg({
      vehicleId: PLATE2, tripId, legId: `L${tripId}_${legSeq}`,
      passengerPublicKey: rider.publicKey, boardDoorId: 'A', alightDoorId: 'A',
      boardOdoM: 0, alightOdoM: 3300, distanceM: 3300, distanceSource: 'odometer',
      boardAt: at, alightAt: at + 600, concession: 'none', amount: price.amount, tariffCode: TARIFF.code,
    }), bus.secretKey);
    const tap = signTap(buildTap({ passengerPublicKey: rider.publicKey, vehicleId: PLATE2, doorId: 'A', timestamp: at }), rider.secretKey);
    return (await sync({ legs: [{ receipt, tap }] })).legResults[0];
  };

  // --- cash tickets
  const before = await walletSum();
  const good = cashTicket('TCASH0');
  const recorded = await sync({ cashTickets: [good] });
  check('a cash ticket signed by the bus, at the tariff, is recorded',
    recorded.cashResults[0].ok === true && recorded.cashResults[0].amount === priceDistance(5300).amount, JSON.stringify(recorded.cashResults[0]));
  check('...once: the same ticket again is a replay', (await sync({ cashTickets: [good] })).cashResults[0].reason === 'replay');
  check('a ticket written down for less than the tariff is refused',
    (await sync({ cashTickets: [cashTicket('TCASH0', { amount: 10 })] })).cashResults[0].reason === 'price_mismatch');
  check('a ticket not signed by the bus is refused',
    (await sync({ cashTickets: [cashTicket('TCASH0', { signer: createKeypair() })] })).cashResults[0].reason === 'bad_signature');
  check('no wallet moves for cash', (await walletSum()) === before);
  const cashRow = (await db.query('select amount, trip_id from cash_tickets where vehicle_plate = $1', [PLATE2])).rows;
  check('the owner has it on file, against the trip', cashRow.length === 1 && cashRow[0].trip_id === 'TCASH0');

  // --- counts, and the bonus tied to them
  check('a count with no meter announcing it is ignored',
    ((await sync({ tripCounts: [{ tripId: 'TX', counted: 3 }], cashTickets: [cashTicket('TX')] })).countResults ?? []).length === 0);

  const trip = async (tripId, { rides, cash = 0, counted }) => {
    await sync({ meter, crew: { signOn, tripIds: [tripId] } });
    for (let n = 0; n < rides; n += 1) await rideOn(tripId, n);
    const cashTickets = Array.from({ length: cash }, () => cashTicket(tripId));
    const body = { meter, closedTrips: [tripId], ...(cash ? { cashTickets } : {}), ...(counted !== undefined ? { tripCounts: [{ tripId, counted }] } : {}) };
    return (await sync(body)).tripResults[0];
  };
  const crewBalance = async () => Number((await db.query('select balance from passengers where public_key = $1', [conductor.publicKey])).rows[0].balance);

  const all = await trip('TCOUNT1', { rides: 8, cash: 2, counted: 10 });
  check('10 counted, 8 rides + 2 cash on record: the bonus is paid', all.outcome === 'paid' && all.amount === CLEAN_TRIP_BONUS_NPR, JSON.stringify(all));
  const evidence = (await db.query('select trip_evidence($1) as e', ['TCOUNT1'])).rows[0].e;
  check('...and the cash counts toward the fares the trip earned',
    evidence.fares === 8 * priceDistance(3300).amount + 2 * priceDistance(5300).amount && evidence.cash === 2 && evidence.counted === 10, JSON.stringify(evidence));

  const leaky = await trip('TCOUNT2', { rides: 8, cash: 1, counted: 12 });
  check(`12 counted, 9 recorded (75%): no bonus below ${RECORDED_SHARE_MIN_PCT}%`, leaky.outcome === 'missed' && leaky.amount === 0, JSON.stringify(leaky));
  check('...and the crew is told how many went unrecorded',
    (leaky.reasons ?? []).some((r) => r.code === 'riders_not_recorded' && /3 of 12/.test(r.message)), JSON.stringify(leaky.reasons));

  const edge = await trip('TCOUNT3', { rides: 9, counted: 10 });
  check(`exactly ${RECORDED_SHARE_MIN_PCT}% recorded is enough`, edge.outcome === 'paid', JSON.stringify(edge));

  const silent = await trip('TCOUNT4', { rides: 8 });
  check('a bus whose counter has spoken before, and now says nothing, earns no bonus',
    silent.outcome === 'missed' && (silent.reasons ?? []).some((r) => r.code === 'counter_silent'), JSON.stringify(silent.reasons));
  check('the conductor was paid for exactly the two clean trips', (await crewBalance()) === 2 * CLEAN_TRIP_BONUS_NPR, `Rs ${await crewBalance()}`);

  await sync({ meter, tripCounts: [{ tripId: 'TCOUNT2', counted: 7 }] });
  check('a count only goes up: a stale smaller figure does not shrink it',
    (await db.query('select counted_boardings from trips where id = $1', ['TCOUNT2'])).rows[0].counted_boardings === 12);

  // The owner's view, read as the owner and as a stranger, the way the API
  // roles would. The bus is handed to the section-12 owner for one transaction.
  const OWNER = '6f1c2a0e-5b3d-4c1e-9a7f-2d8e4b6c0a11';
  const readTripCount = async (uid) => {
    await as(uid);
    await db.query('set local role authenticated');
    const rows = (await db.query('select * from operator_trip_count where trip_id = $1', ['TCOUNT2'])).rows;
    await db.query('reset role');
    return rows;
  };
  await db.query('begin');
  await as(OWNER);
  await db.query('update vehicles set operator_id = current_operator_id() where plate = $1', [PLATE2]);
  const ownerView = (await readTripCount(OWNER))[0];
  const strangerView = await readTripCount(RIDER);
  await db.query('rollback');
  await as(null);
  check('the owner reads counted, recorded, cash and the unrecorded number for their bus',
    ownerView?.counted === 12 && ownerView.rides === 8 && ownerView.cash_tickets === 1 && ownerView.unrecorded === 3, JSON.stringify(ownerView));
  check('...and another signed-in user reads nothing', strangerView.length === 0);
  await db.query('set role anon');
  const anonView = await db.query('select * from operator_trip_count').then(() => 'readable', () => 'refused');
  const anonCash = await db.query('select * from cash_tickets').then(() => 'readable', () => 'refused');
  await db.query('reset role');
  check('the anon key reads neither the view nor the cash tickets', anonView === 'refused' && anonCash === 'refused', `${anonView}, ${anonCash}`);
}

// ------------------------------------------- 26. a family on one phone

let familyLegs = 0;

console.log('\n26. A family on one phone, and what an inspector may read');
{
  const PLATE3 = 'BA4KHA1111';
  const bus = createKeypair();
  await sync({ meter: { vehicleId: PLATE3, publicKey: bus.publicKey, capacity: 42, firmware: 'proof' } });

  // A mother and two children: one wallet, three keys for today.
  const seed = createMasterSeed();
  const wallet = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 500) on conflict do nothing', [wallet.publicKey]);
  const today = dayIndex(boardAt);
  const mother = deriveDailyKeypair(seed, today);
  const children = [deriveCompanionKeypair(seed, today, 1), deriveCompanionKeypair(seed, today, 2)];
  const link = (key, root = wallet) => signLink(buildLink({ rootPublicKey: root.publicKey, pseudonymPublicKey: key.publicKey, day: today }), root.secretKey, key.secretKey);

  const filed = (await sync({ keyLinks: [link(mother), ...children.map((c) => link(c))] })).linkResults;
  check('the payer’s day-key and both companions register against the one wallet', filed.length === 3 && filed.every((r) => r.ok), JSON.stringify(filed));

  const stranger = createKeypair();
  await db.query('insert into passengers (public_key, balance) values ($1, 0) on conflict do nothing', [stranger.publicKey]);
  check('a companion cannot be claimed by another wallet afterwards',
    (await sync({ keyLinks: [link(children[0], stranger)] })).linkResults[0].reason === 'pseudonym_taken');

  const before = await balance(wallet);
  let expected = 0;
  for (const [n, key] of [mother, ...children].entries()) {
    legSeq += 1;
    familyLegs += 1;
    const at = boardAt + n;
    const distanceM = 3300 + n * 1000;
    const price = priceDistance(distanceM);
    expected += price.amount;
    const receipt = signLeg(buildLeg({
      vehicleId: PLATE3, tripId: 'TFAMILY', legId: `LFAMILY${legSeq}`,
      passengerPublicKey: key.publicKey, boardDoorId: 'A', alightDoorId: 'A',
      boardOdoM: 0, alightOdoM: distanceM, distanceM, distanceSource: 'odometer',
      boardAt: at, alightAt: at + 600, concession: 'none', amount: price.amount, tariffCode: TARIFF.code,
    }), bus.secretKey);
    const tap = signTap(buildTap({ passengerPublicKey: key.publicKey, vehicleId: PLATE3, doorId: 'ANY', timestamp: at }), key.secretKey);
    const settled = (await sync({ legs: [{ receipt, tap }] })).legResults[0];
    check(`${n === 0 ? 'the mother' : `child ${n}`} settles with their own tap`, settled.ok === true, JSON.stringify(settled));
  }
  check('all three fares come out of the one wallet', (await balance(wallet)) === before - expected, `Rs ${before} → Rs ${await balance(wallet)}, expected −${expected}`);
  // Settlement notes every key it sees, as it does for day-keys; what matters
  // is that no money sits on a companion's row or is taken from it.
  const companionMoney = (await db.query('select coalesce(sum(abs(balance)), 0)::int as n from passengers where public_key = any($1)', [children.map((c) => c.publicKey)])).rows[0].n;
  check('no money is credited to or taken from a companion key', companionMoney === 0, `Rs ${companionMoney}`);

  // The register an inspector's phone downloads: plate and key, to anyone.
  await db.query('set role anon');
  const register = await db.query('select vehicle_public_keys() as r').then((q) => q.rows[0].r, (e) => e.message);
  const leak = await db.query('select operator_id from vehicles limit 1').then(() => 'readable', () => 'refused');
  await db.query('reset role');
  const entry = Array.isArray(register) ? register.find((v) => v.plate === PLATE3) : null;
  check('an inspector’s phone can download every bus’s public key with the anon key', entry?.publicKey === bus.publicKey, typeof register === 'string' ? register : `${register.length} buses`);
  check('...and nothing else about the vehicles', Object.keys(entry ?? {}).sort().join(',') === 'plate,publicKey' && leak === 'refused', leak);
}

console.log('\nLedger');
const legs = await db.query('select count(*)::int as n, coalesce(sum(amount), 0)::int as rs from legs');
const taps = await db.query('select count(*)::int as n from leg_taps');
line('legs settled', legs.rows[0].n);
line('value moved', `Rs ${legs.rows[0].rs}`);
line('taps on file', taps.rows[0].n);
check('only the honest rides moved money', legs.rows[0].n === 15 + overdraftLegs + accountLegs + crewLegs + countLegs + familyLegs);

// The owner's view of the same rides (0011). Run here as the database owner,
// so RLS does not narrow it; the point is that the view computes.
const economics = await db.query('select * from operator_distance where vehicle_plate = $1', [PLATE]);
const day = economics.rows[0];
line('owner sees, per km', day ? `${day.rides} rides, ${day.passenger_km} passenger-km, Rs ${day.npr_per_km}/km, ${day.measured} measured, ${day.unclosed} unclosed` : 'nothing');
check('the owner dashboard view reports the metered rides', day?.rides === 15 + overdraftLegs + crewLegs && day?.unclosed === 2);
const health = await db.query('select * from operator_vehicles where plate = $1', [PLATE]);
check('a bus running only the meter does not look silent', health.rows[0]?.last_sync !== null && health.rows[0]?.lifetime_rides_metered === 15 + overdraftLegs + crewLegs);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
await db.close();
process.exit(failures === 0 ? 0 : 1);
