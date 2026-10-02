// The backend's Postgres half, with no Node in it.
//
// Every migration applied to a PGlite database, and the ledger settleBatch()
// writes through. Split out of pg-backend.mjs so the same code runs in two
// places: under Node for the proofs and `npm run sync:local`, and in a browser
// for /demo, where a laptop in airplane mode settles a bus's rides on real
// Postgres. The caller hands in the PGlite class and the migration files; this
// file never reads a disk.

import { settleBatch } from '../../protocol/settle.mjs';

/*
  Open the database and bring it up to date. What Supabase provides and PGlite
  does not — the API roles and the auth schema the operator migrations refer
  to — is stubbed first; nothing stubbed is logic. Applied migrations are
  recorded, so a persisted database is migrated forward rather than replayed.
*/
export async function openBackendWith({ PGlite, migrations, dataDir }) {
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end $$;
    -- Supabase grants everything new in public to the API roles by default;
    -- a migration that forgets to revoke leaves it readable with the anon key
    -- the site ships. Mirrored here so the proofs see what production sees.
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key, email text);
    -- Supabase reads the signed-in user from the request's JWT claims; a proof
    -- plays a user by setting the same claim.
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table if not exists _migrations (file text primary key, applied_at timestamptz default now());
  `);
  const applied = new Set((await db.query('select file from _migrations')).rows.map((r) => r.file));
  // `migrations` is [{ file, sql }], applied in file-name order.
  const ordered = [...migrations].sort((a, b) => (a.file < b.file ? -1 : 1));
  for (const { file, sql } of ordered) {
    if (applied.has(file)) continue;
    await db.exec(sql);
    await db.query('insert into _migrations (file) values ($1)', [file]);
  }
  return { db, migrations: ordered.map((m) => m.file) };
}

// A settled leg, in the shape protocol/dispute.mjs assesses a claim against.
// Both backends hand back the same object; only the column names differ.
function legShape(row) {
  return {
    legId: row.leg_id,
    passengerPublicKey: row.passenger_public_key,
    vehicleId: row.vehicle_plate,
    distanceSource: row.distance_source,
    distanceM: Number(row.distance_m),
    amount: Number(row.amount),
    concession: row.concession,
    tariffCode: row.tariff_code,
    boardAt: Number(row.board_at),
    alightAt: Number(row.alight_at),
  };
}

/*
  The ledger settleBatch() writes through. Positional arguments here, named
  arguments in the Edge Function, because that is the difference between a raw
  `select fn($1,$2)` and PostgREST — and it is the only difference left.
*/
function pgLedger(db, { autoRegisterVehicles }) {
  const rpc = async (name, args) => {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
    return (await db.query(`select ${name}(${placeholders}) as r`, args)).rows[0].r;
  };

  return {
    // A local demo settles for a plate nobody has registered through the
    // dashboard. The hosted function has no such hook: there, a vehicle exists
    // because an operator entered it.
    ensureVehicle: autoRegisterVehicles
      ? (plate) => db.query(
        `insert into vehicles (plate, operator_id, route_id) values ($1, 'SAJHA', 'R11') on conflict (plate) do nothing`,
        [plate],
      )
      : undefined,

    noteTrip: (tripId, plate) => db.query(
      'insert into trips (id, vehicle_plate) values ($1, $2) on conflict (id) do nothing',
      [tripId, plate],
    ),

    registerMeter: ({ vehicleId, publicKey, capacity, firmware }) =>
      rpc('register_meter', [vehicleId, publicKey, capacity, firmware]),

    registerDevice: (publicKey, signupCredit) =>
      rpc('register_device', [publicKey, signupCredit]),

    // The local stand-in for Supabase Auth: a token 'local:<user id>' is that
    // user. Only the local demo and the proofs use this ledger; the hosted
    // function asks Supabase Auth instead.
    userForToken: async (token) => /^local:([0-9a-f-]{36})$/.exec(String(token ?? ''))?.[1] ?? null,

    linkAccount: (a) => rpc('link_account', [a.userId, a.walletPublicKey, a.link]),
    moveWallet: (a) => rpc('move_wallet', [a.userId, a.walletPublicKey, a.link]),

    registerPseudonym: (a) =>
      rpc('register_pseudonym', [a.pseudonymPublicKey, a.rootPublicKey, a.dayIndex, a.link]),

    vehicleKey: async (plate) =>
      (await db.query('select public_key from vehicles where plate = $1', [plate])).rows[0]?.public_key ?? null,

    settledLeg: async (legId) => {
      const row = (await db.query(
        `select leg_id, passenger_public_key, vehicle_plate, distance_source, distance_m,
                amount, concession, tariff_code,
                extract(epoch from boarded_at)::bigint  as board_at,
                extract(epoch from alighted_at)::bigint as alight_at
           from legs where leg_id = $1`,
        [legId],
      )).rows[0];
      return row ? legShape(row) : null;
    },

    settleFare: (a) => rpc('settle_fare', [
      a.passengerPublicKey, a.vehiclePlate, a.tripId, a.amount, a.boardingStop, a.alightingStop,
      a.sequenceNumber, a.nonce, a.issuedAt, a.collectedAt, a.settledBy,
    ]),

    recordTap: (a) => rpc('record_tap', [
      a.legId, a.vehiclePlate, a.passengerPublicKey, a.tapNonce, a.tappedAt, a.tap,
    ]),

    settleLeg: (a) => rpc('settle_leg', [
      a.legId, a.vehiclePlate, a.tripId, a.passengerPublicKey, a.boardDoor, a.alightDoor,
      a.boardOdoM, a.alightOdoM, a.distanceM, a.distanceSource, a.concession, a.amount,
      a.tariffCode, a.boardedAt, a.alightedAt, a.settledBy, a.receipt,
      a.fullAmount ?? null, a.issuerPublicKey ?? null,
    ]),

    flagLeg: (a) => rpc('flag_leg', [a.legId, a.plausibility, JSON.stringify(a.flags)]),

    fileDispute: (a) => rpc('file_dispute', [
      a.legId, a.passengerPublicKey, a.vehiclePlate, a.claimNonce,
      a.witnessM, a.witnessAt, a.witnessLatMicro, a.witnessLonMicro,
      a.repricedNpr, a.refundNpr, a.outcome, a.claim,
    ]),

    appendDoorEvents: async (events, { vehiclePlate }) => {
      for (const event of events) {
        await db.query(
          'insert into door_events (vehicle_plate, trip_id, at, kind, door, onboard, capacity, note) values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [vehiclePlate, event.tripId, event.at, event.kind, event.door, event.onboard, event.capacity, event.note],
        );
      }
    },

    appendMeterEvents: (events, { vehiclePlate }) =>
      rpc('append_meter_events', [vehiclePlate, JSON.stringify(events)]),

    noteCrew: (a) => rpc('note_crew', [a.tripId, a.vehiclePlate, a.crewPublicKey, a.signedOnAt, a.signOn]),

    tripEvidence: (tripId) => rpc('trip_evidence', [tripId]),

    recordCashTicket: (a) => rpc('record_cash_ticket', [
      a.ticketId, a.vehiclePlate, a.tripId, a.doorId, a.fromStop, a.toStop,
      a.distanceM, a.amount, a.tariffCode, a.issuedAt, a.ticket,
    ]),

    recordTripCount: (a) => rpc('record_trip_count', [a.tripId, a.vehiclePlate, a.counted]),

    awardCleanTrip: (a) => rpc('award_clean_trip', [
      a.tripId, a.vehiclePlate, a.crewPublicKey, a.amount, a.legs, a.fares,
      JSON.stringify(a.reasons ?? []),
    ]),
  };
}

/*
  POST /sync, as the Edge Function answers it. `signupCredit` stands in for
  SIGNUP_CREDIT_NPR; `autoRegisterVehicles` lets a local demo settle for a plate
  nobody has registered through the dashboard.
*/
export async function handleSync(db, body, {
  signupCredit = 2000,
  autoRegisterVehicles = true,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  return settleBatch(body, pgLedger(db, { autoRegisterVehicles }), { signupCredit, now });
}
