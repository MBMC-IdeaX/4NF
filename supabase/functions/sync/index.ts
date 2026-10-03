// POST /functions/v1/sync
//
// Either device uploads its queued fares here. The body carries the raw signed
// QR strings, not summaries of them, so this function verifies each passenger's
// own signature instead of trusting whichever device happened to upload the
// batch. A conductor phone cannot invent a fare; a passenger phone cannot
// un-invent one it signed.
//
// The verification, batching and shaping are settleBatch() in
// protocol/settle.mjs — the same function scripts/lib/pg-backend.mjs runs, so
// the proofs check the code that bills people rather than a copy of it. What is
// left here is HTTP, the service-role client, and the ledger: the methods that
// reach PostgREST. The money itself is moved by settle_fare() and settle_leg()
// in Postgres, which own the once-only rule.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { settleBatch } from '../_shared/protocol/settle.mjs';
import { useRandomSource } from '../_shared/protocol/random.mjs';
import { readJson, overLimit, TooLarge } from '../_shared/guard.ts';

// tweetnacl wants a PRNG present even for verification paths.
useRandomSource((length: number) => crypto.getRandomValues(new Uint8Array(length)));

// A brand new wallet is worth nothing. For a demo, set SIGNUP_CREDIT_NPR so an
// unseen device starts with a balance; the credit is written to wallet_topups
// with source 'demo', so it is a visible row rather than an unexplained number.
// Leave it unset in a real deployment and let value arrive from a gateway.
const SIGNUP_CREDIT = Number(Deno.env.get('SIGNUP_CREDIT_NPR') ?? '0') || 0;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

type Db = ReturnType<typeof createClient>;

/*
  The ledger settleBatch() writes through.

  Every method throws on a PostgREST error rather than returning one: the shared
  code turns a thrown call into a `server_error` verdict for that row and keeps
  going, so one bad RPC costs a device one fare and not the batch.
*/
function restLedger(db: Db) {
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    registerMeter: (m: { vehicleId: string; publicKey: string; capacity: number | null; firmware: string | null; enrolCode: string | null }) =>
      rpc('register_meter', {
        p_vehicle_plate: m.vehicleId,
        p_public_key: m.publicKey,
        p_capacity: m.capacity,
        p_firmware: m.firmware,
        p_enrol_code: m.enrolCode,
      }),

    registerDevice: (publicKey: string, signupCredit: number) =>
      rpc('register_device', { p_public_key: publicKey, p_signup_credit: signupCredit }),

    // The login presenting an account link, from its own access token.
    userForToken: async (token: string) => {
      const { data, error } = await db.auth.getUser(token);
      if (error) return null;
      return data.user?.id ?? null;
    },

    // deno-lint-ignore no-explicit-any
    linkAccount: (a: any) => rpc('link_account', {
      p_user_id: a.userId,
      p_wallet: a.walletPublicKey,
      p_link: a.link,
    }),

    // deno-lint-ignore no-explicit-any
    moveWallet: (a: any) => rpc('move_wallet', {
      p_user_id: a.userId,
      p_new_wallet: a.walletPublicKey,
      p_link: a.link,
    }),

    // deno-lint-ignore no-explicit-any
    registerPseudonym: (a: any) => rpc('register_pseudonym', {
      p_pseudonym_public_key: a.pseudonymPublicKey,
      p_root_public_key: a.rootPublicKey,
      p_day_index: a.dayIndex,
      p_link: a.link,
    }),

    // A receipt is only worth as much as the key it was signed with, and that
    // key comes from the operator's record here — never from the upload, which
    // is the thing being checked.
    vehicleKey: async (plate: string) => {
      const { data } = await db.from('vehicles').select('public_key').eq('plate', plate).maybeSingle();
      return (data?.public_key as string | undefined) ?? null;
    },

    // A settled leg, in the shape protocol/dispute.mjs assesses a claim
    // against. Times come back as ISO strings here and as epoch seconds from
    // PGlite, so the conversion lives on each side of the port, not in the
    // shared code.
    settledLeg: async (legId: string) => {
      const { data } = await db
        .from('legs')
        .select('leg_id, passenger_public_key, vehicle_plate, distance_source, distance_m, amount, concession, tariff_code, boarded_at, alighted_at')
        .eq('leg_id', legId)
        .maybeSingle();
      if (!data) return null;
      return {
        legId: data.leg_id as string,
        passengerPublicKey: data.passenger_public_key as string,
        vehicleId: data.vehicle_plate as string,
        distanceSource: data.distance_source as string,
        distanceM: Number(data.distance_m),
        amount: Number(data.amount),
        concession: data.concession as string,
        tariffCode: data.tariff_code as string,
        boardAt: Math.floor(new Date(data.boarded_at as string).getTime() / 1000),
        alightAt: Math.floor(new Date(data.alighted_at as string).getTime() / 1000),
      };
    },

    // deno-lint-ignore no-explicit-any
    flagLeg: (a: any) => rpc('flag_leg', {
      p_leg_id: a.legId,
      p_plausibility: a.plausibility,
      p_flags: a.flags,
    }),

    // deno-lint-ignore no-explicit-any
    fileDispute: (a: any) => rpc('file_dispute', {
      p_leg_id: a.legId,
      p_passenger_public_key: a.passengerPublicKey,
      p_vehicle_plate: a.vehiclePlate,
      p_claim_nonce: a.claimNonce,
      p_witness_m: a.witnessM,
      p_witness_at: a.witnessAt,
      p_witness_lat_micro: a.witnessLatMicro,
      p_witness_lon_micro: a.witnessLonMicro,
      p_repriced_npr: a.repricedNpr,
      p_refund_npr: a.refundNpr,
      p_outcome: a.outcome,
      p_claim: a.claim,
    }),

    // deno-lint-ignore no-explicit-any
    settleFare: (a: any) => rpc('settle_fare', {
      p_passenger_public_key: a.passengerPublicKey,
      p_vehicle_plate: a.vehiclePlate,
      p_trip_id: a.tripId,
      p_amount: a.amount,
      p_boarding_stop: a.boardingStop,
      p_alighting_stop: a.alightingStop,
      p_sequence_number: a.sequenceNumber,
      p_nonce: a.nonce,
      p_issued_at: a.issuedAt,
      p_collected_at: a.collectedAt,
      p_settled_by: a.settledBy,
    }),

    // deno-lint-ignore no-explicit-any
    recordTap: (a: any) => rpc('record_tap', {
      p_leg_id: a.legId,
      p_vehicle_plate: a.vehiclePlate,
      p_passenger_public_key: a.passengerPublicKey,
      p_tap_nonce: a.tapNonce,
      p_tapped_at: a.tappedAt,
      p_tap: a.tap,
    }),

    // deno-lint-ignore no-explicit-any
    settleLeg: (a: any) => rpc('settle_leg', {
      p_leg_id: a.legId,
      p_vehicle_plate: a.vehiclePlate,
      p_trip_id: a.tripId,
      p_passenger_public_key: a.passengerPublicKey,
      p_board_door: a.boardDoor,
      p_alight_door: a.alightDoor,
      p_board_odo_m: a.boardOdoM,
      p_alight_odo_m: a.alightOdoM,
      p_distance_m: a.distanceM,
      p_distance_source: a.distanceSource,
      p_concession: a.concession,
      p_amount: a.amount,
      p_tariff_code: a.tariffCode,
      p_boarded_at: a.boardedAt,
      p_alighted_at: a.alightedAt,
      p_settled_by: a.settledBy,
      p_receipt: a.receipt,
      p_full_amount: a.fullAmount ?? null,
      p_issuer_public_key: a.issuerPublicKey ?? null,
    }),

    // Appended, never merged. The interlock record is only useful to a regulator
    // if it is the vehicle's own sequence of events rather than a summary
    // someone had the chance to tidy.
    // deno-lint-ignore no-explicit-any
    appendDoorEvents: (events: any[], { vehiclePlate }: { vehiclePlate: string }) =>
      rpc('append_door_events', { p_vehicle_plate: vehiclePlate, p_events: events }),

    // The box's own power tape, kept apart from the door tape for the same
    // reason a regulator's record stays about doors.
    // deno-lint-ignore no-explicit-any
    appendMeterEvents: (events: any[], { vehiclePlate }: { vehiclePlate: string }) =>
      rpc('append_meter_events', { p_vehicle_plate: vehiclePlate, p_events: events }),

    // deno-lint-ignore no-explicit-any
    noteCrew: (a: any) => rpc('note_crew', {
      p_trip_id: a.tripId,
      p_vehicle_plate: a.vehiclePlate,
      p_crew_public_key: a.crewPublicKey,
      p_signed_on_at: a.signedOnAt,
      p_sign_on: a.signOn,
    }),

    tripEvidence: (tripId: string) => rpc('trip_evidence', { p_trip_id: tripId }),

    // deno-lint-ignore no-explicit-any
    awardCleanTrip: (a: any) => rpc('award_clean_trip', {
      p_trip_id: a.tripId,
      p_vehicle_plate: a.vehiclePlate,
      p_crew_public_key: a.crewPublicKey,
      p_amount: a.amount,
      p_legs: a.legs,
      p_fares: a.fares,
      p_reasons: a.reasons,
    }),

    // Cash fares and door counts (migration 0030). Checked in settleBatch().
    // deno-lint-ignore no-explicit-any
    recordCashTicket: (a: any) => rpc('record_cash_ticket', {
      p_ticket_id: a.ticketId,
      p_vehicle_plate: a.vehiclePlate,
      p_trip_id: a.tripId,
      p_door: a.doorId,
      p_from_stop: a.fromStop,
      p_to_stop: a.toStop,
      p_distance_m: a.distanceM,
      p_amount: a.amount,
      p_tariff_code: a.tariffCode,
      p_issued_at: a.issuedAt,
      p_ticket: a.ticket,
    }),

    // deno-lint-ignore no-explicit-any
    recordTripCount: (a: any) => rpc('record_trip_count', {
      p_trip_id: a.tripId,
      p_vehicle_plate: a.vehiclePlate,
      p_counted: a.counted,
    }),
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  let body: unknown;
  if (overLimit(request, 600)) return json({ error: 'Too many requests. Try again in a minute.' }, 429);

  try {
    body = await readJson(request);
  } catch (problem) {
    if (problem instanceof TooLarge) return json({ error: 'Body too large.' }, 413);
    return json({ error: 'Body must be JSON.' }, 400);
  }

  // Service role: this function is the only writer of money, and it has already
  // done the check that matters (the passenger's signature).
  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const [status, payload] = await settleBatch(body, restLedger(db), { signupCredit: SIGNUP_CREDIT });
  return json(payload, status);
});
