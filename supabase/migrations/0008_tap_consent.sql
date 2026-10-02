-- The passenger's consent, on file before any distance fare moves money.
--
-- A leg receipt (BM1) is signed by the vehicle. A passenger's public key is not
-- a secret — it is in every QR they have ever shown — so until this migration a
-- valid vehicle signature was enough to debit any passenger for a ride they
-- never took. The BT1 tap is the half of a ride only the passenger can sign.
-- It is now filed here, one tap per leg and one leg per tap, and settle_leg()
-- refuses to move money for a leg without one.
--
-- A receipt that arrives before its tap is not refused, it is held: the two
-- door phones may have had no signal between them, and the boarding door — the
-- one that saw the tap — may upload hours after the alighting door uploaded the
-- receipt. `awaiting_tap` is therefore not a final answer, and devices keep the
-- receipt queued and retry it.

create table if not exists leg_taps (
  leg_id               text primary key,
  vehicle_plate        text not null references vehicles(plate),
  passenger_public_key text not null,
  tap_nonce            text not null,
  tapped_at            timestamptz not null,
  tap                  text not null,       -- the raw BT1, so this is re-verifiable
  received_at          timestamptz not null default now()
);

-- One tap opens one ride. Without this a single genuine tap could be attached
-- to any number of receipts the passenger never saw.
create unique index if not exists leg_taps_one_ride_per_tap
  on leg_taps (passenger_public_key, tap_nonce);

/*
  File one tap against one leg. The caller has already checked the passenger's
  signature and that the tap matches the leg (protocol/leg.mjs
  verifyLegConsent); this owns the once-only rules.
*/
create or replace function record_tap(
  p_leg_id               text,
  p_vehicle_plate        text,
  p_passenger_public_key text,
  p_tap_nonce            text,
  p_tapped_at            timestamptz,
  p_tap                  text
) returns jsonb
language plpgsql
as $$
declare
  v_existing leg_taps%rowtype;
begin
  select * into v_existing from leg_taps where leg_id = p_leg_id;
  if found then
    if v_existing.tap = p_tap then
      return jsonb_build_object('legId', p_leg_id, 'ok', true, 'reason', 'seen');
    end if;
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'tap_conflict');
  end if;

  insert into leg_taps (leg_id, vehicle_plate, passenger_public_key, tap_nonce, tapped_at, tap)
  values (p_leg_id, p_vehicle_plate, p_passenger_public_key, p_tap_nonce, p_tapped_at, p_tap);

  return jsonb_build_object('legId', p_leg_id, 'ok', true, 'reason', 'recorded');

exception
  when unique_violation then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'tap_reused');
end;
$$;

/*
  settle_leg(), now with consent. Same signature and contract as 0007: the
  caller has verified the vehicle's signature and re-priced the ride; this owns
  the money and the once-only rule — and, from here on, refuses to settle a leg
  whose passenger has not signed for it.
*/
create or replace function settle_leg(
  p_leg_id               text,
  p_vehicle_plate        text,
  p_trip_id              text,
  p_passenger_public_key text,
  p_board_door           text,
  p_alight_door          text,
  p_board_odo_m          integer,
  p_alight_odo_m         integer,
  p_distance_m           integer,
  p_distance_source      text,
  p_concession           text,
  p_amount               integer,
  p_tariff_code          text,
  p_boarded_at           timestamptz,
  p_alighted_at          timestamptz,
  p_settled_by           text,
  p_receipt              text
) returns jsonb
language plpgsql
as $$
declare
  v_balance integer;
  v_tap     leg_taps%rowtype;
begin
  -- Replay first, so a device re-uploading a settled leg hears `replay` — a
  -- final answer it can clear its queue on — rather than anything else.
  if exists (select 1 from legs where leg_id = p_leg_id) then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'replay');
  end if;

  select * into v_tap from leg_taps where leg_id = p_leg_id;
  if not found then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'awaiting_tap');
  end if;
  if v_tap.passenger_public_key <> p_passenger_public_key
     or v_tap.vehicle_plate <> p_vehicle_plate
     or abs(extract(epoch from (v_tap.tapped_at - p_boarded_at))) > 120 then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'tap_mismatch');
  end if;

  select balance into v_balance
    from passengers
   where public_key = p_passenger_public_key
     for update;

  if not found then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'unknown_passenger');
  end if;

  if v_balance < p_amount then
    return jsonb_build_object(
      'legId', p_leg_id, 'ok', false, 'reason', 'insufficient_balance',
      'balance', v_balance, 'shortfall', p_amount - v_balance
    );
  end if;

  insert into legs (
    leg_id, vehicle_plate, trip_id, passenger_public_key,
    board_door, alight_door, board_odo_m, alight_odo_m,
    distance_m, distance_source, concession, amount, tariff_code,
    boarded_at, alighted_at, settled_by, receipt
  ) values (
    p_leg_id, p_vehicle_plate, p_trip_id, p_passenger_public_key,
    p_board_door, p_alight_door, p_board_odo_m, p_alight_odo_m,
    p_distance_m, p_distance_source, p_concession, p_amount, p_tariff_code,
    p_boarded_at, p_alighted_at, p_settled_by, p_receipt
  );

  update passengers
     set balance = balance - p_amount,
         last_settled_at = now()
   where public_key = p_passenger_public_key
  returning balance into v_balance;

  return jsonb_build_object('legId', p_leg_id, 'ok', true, 'balance', v_balance, 'amount', p_amount);

exception
  when unique_violation then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'replay');
end;
$$;

-- ----------------------------------------------------------------- lockdown

alter table leg_taps enable row level security;
revoke all on leg_taps from anon, authenticated;
revoke all on function record_tap(text, text, text, text, timestamptz, text) from anon, authenticated, public;
revoke all on function settle_leg(text, text, text, text, text, text, integer, integer, integer, text, text, integer, text, timestamptz, timestamptz, text, text)
  from anon, authenticated, public;
