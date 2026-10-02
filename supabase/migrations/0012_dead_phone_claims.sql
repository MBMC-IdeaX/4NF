-- Two fixes for the same passenger: the one whose phone is wrong, and the one
-- whose phone is dead.
--
-- 1. The tap window. settle_leg() has been refusing any tap made more than 120
--    seconds from the receipt's boarding time, which is the door's rule copied
--    into SQL. The door's rule has moved: an offline Android handset drifts tens
--    of seconds a week and a phone a fortnight off the network can be minutes
--    from the door's clock while its owner stands in front of it with a code
--    they generated a second ago. TAP_MAX_AGE_S in protocol/leg.mjs is now 300,
--    and a door that accepts a tap must not hand it to a backend that will not,
--    or the passenger boards and the fare never settles. Replay is still stopped
--    by the nonce — leg_taps_one_ride_per_tap, which is the lock that actually
--    holds.
--
-- 2. Claims. A ride nobody closed is charged the cap, and that rule stays: it is
--    the only thing that stops tapping out being optional. But the commonest
--    reason a ride goes unclosed in Kathmandu is a flat battery at 6 pm, and
--    until now that passenger had no way to say so. Their phone was running the
--    same odometer the bus was, and wrote it down as it went; this is where that
--    record is filed, checked and paid back.

-- ---------------------------------------------------------- the tap window

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
  -- 300 seconds, matching TAP_MAX_AGE_S. Widened for clock drift, not for
  -- forgery: the tap is still the passenger's own signature and still spendable
  -- exactly once.
  if v_tap.passenger_public_key <> p_passenger_public_key
     or v_tap.vehicle_plate <> p_vehicle_plate
     or abs(extract(epoch from (v_tap.tapped_at - p_boarded_at))) > 300 then
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

-- -------------------------------------------------------------- the claims

/*
  One row per claim, refunded or not.

  A refused claim is kept, not discarded. A passenger is owed the reason their
  claim failed, and an operator looking at a passenger who files one on every
  unclosed ride is owed the pattern. `refund_npr` is 0 on anything refused.

  The raw BD1 stays on the row for the same reason the BM1 stays on `legs`:
  every number here is re-checkable against the signature it came from, months
  later, by someone who does not trust this table.
*/
create table if not exists leg_disputes (
  leg_id               text primary key references legs(leg_id),
  passenger_public_key text not null references passengers(public_key),
  vehicle_plate        text not null references vehicles(plate),
  claim_nonce          text not null,
  witness_m            integer not null check (witness_m >= 0),
  witness_at           timestamptz not null,
  witness_lat_micro    integer not null default 0,
  witness_lon_micro    integer not null default 0,
  charged_npr          integer not null check (charged_npr >= 0),
  repriced_npr         integer not null check (repriced_npr >= 0),
  refund_npr           integer not null default 0 check (refund_npr >= 0),
  outcome              text not null,
  filed_at             timestamptz not null default now(),
  claim                text not null      -- the raw BD1, so this is re-verifiable
);

create index if not exists leg_disputes_passenger on leg_disputes (passenger_public_key, filed_at desc);
create unique index if not exists leg_disputes_one_claim_per_nonce on leg_disputes (claim_nonce);

-- A refund is a wallet credit like any other, with source 'refund' and the leg
-- as its reference. wallet_topups_reference already makes (source, reference)
-- unique, so a refund cannot be paid twice however many times the phone uploads
-- the claim — the same lock that stops a gateway payment being credited twice.

/*
  File one claim.

  The signature was checked before this was called, the same way a receipt's is
  before settle_leg(), and the refund was priced by protocol/dispute.mjs against
  the tariff the leg names. What is left is what only the database can do: prove
  the leg is this passenger's, refuse a second claim against it, and move the
  money once.

  A refused claim still returns ok:false with its reason, and still leaves a row.
*/
create or replace function file_dispute(
  p_leg_id               text,
  p_passenger_public_key text,
  p_vehicle_plate        text,
  p_claim_nonce          text,
  p_witness_m            integer,
  p_witness_at           timestamptz,
  p_witness_lat_micro    integer,
  p_witness_lon_micro    integer,
  p_repriced_npr         integer,
  p_refund_npr           integer,
  p_outcome              text,
  p_claim                text
) returns jsonb
language plpgsql
as $$
declare
  v_leg     legs%rowtype;
  v_balance integer;
begin
  if exists (select 1 from leg_disputes where leg_id = p_leg_id) then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'replay');
  end if;

  select * into v_leg from legs where leg_id = p_leg_id;
  if not found then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'unknown_leg');
  end if;

  -- The claim names a leg; the leg says who rode it. Anyone can read a leg id
  -- off a receipt, so this is the check that makes the signature mean something.
  if v_leg.passenger_public_key <> p_passenger_public_key
     or v_leg.vehicle_plate <> p_vehicle_plate then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'not_your_leg');
  end if;
  if v_leg.distance_source <> 'unclosed' then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'not_disputable');
  end if;

  insert into leg_disputes (
    leg_id, passenger_public_key, vehicle_plate, claim_nonce,
    witness_m, witness_at, witness_lat_micro, witness_lon_micro,
    charged_npr, repriced_npr, refund_npr, outcome, claim
  ) values (
    p_leg_id, p_passenger_public_key, p_vehicle_plate, p_claim_nonce,
    p_witness_m, p_witness_at, p_witness_lat_micro, p_witness_lon_micro,
    v_leg.amount, p_repriced_npr, greatest(0, coalesce(p_refund_npr, 0)), p_outcome, p_claim
  );

  if coalesce(p_refund_npr, 0) <= 0 then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', p_outcome, 'refund', 0);
  end if;

  -- A refund can never hand back more than the leg took.
  if p_refund_npr > v_leg.amount then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'refund_exceeds_charge');
  end if;

  insert into wallet_topups (public_key, amount, source, reference)
  values (p_passenger_public_key, p_refund_npr, 'refund', p_leg_id);

  update passengers
     set balance = balance + p_refund_npr
   where public_key = p_passenger_public_key
  returning balance into v_balance;

  return jsonb_build_object(
    'legId', p_leg_id, 'ok', true, 'reason', 'refunded',
    'refund', p_refund_npr, 'balance', v_balance
  );

exception
  when unique_violation then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'replay');
end;
$$;

/*
  What an owner sees. A handful of claims is a fleet with old handsets on it; a
  bus whose unclosed rides are mostly disputed is a door nobody is tapping out
  at, and that is a route problem, not a battery problem.
*/
create or replace view dispute_load as
select
  l.vehicle_plate,
  count(*) filter (where l.distance_source = 'unclosed')            as unclosed_legs,
  count(d.leg_id)                                                   as claims,
  count(d.leg_id) filter (where d.refund_npr > 0)                   as refunded,
  coalesce(sum(d.refund_npr), 0)                                    as refunded_npr,
  max(d.filed_at)                                                   as last_claim_at
from legs l
left join leg_disputes d on d.leg_id = l.leg_id
group by l.vehicle_plate;

-- ----------------------------------------------------------------- lockdown

alter table leg_disputes enable row level security;
revoke all on leg_disputes from anon, authenticated;
revoke all on function file_dispute(text, text, text, text, integer, timestamptz, integer, integer, integer, integer, text, text)
  from anon, authenticated, public;
