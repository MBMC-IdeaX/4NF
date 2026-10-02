-- Concessions somebody actually certified.
--
-- `legs.concession` has been a string the passenger's own phone wrote onto the
-- receipt. Students and senior citizens pay half by law, so the string was worth
-- money, and anyone could type it. Every other number in this system is checked
-- against a signature; this was the one taken on trust.
--
-- An AT1 attestation (protocol/attest.mjs) is a campus office, ward office or
-- transport booth signing a statement about a passenger's public key. The
-- signature and the expiry are checked by the door, offline. Whether the office
-- is a real one is checked here, against `concession_issuers`, because only the
-- backend has the register — and the discount only costs the operator money at
-- settlement anyway.
--
-- The rule when a card is missing, expired or from an office nobody registered:
-- the ride settles at FULL fare. Not refused. A passenger whose student card
-- lapsed last week is still a passenger on a bus, and stranding them to protect
-- Rs 7 would be the wrong trade in both directions. The leg records which way it
-- went, so an operator can see unbacked claims without anyone being accused of
-- anything at the door.

create table if not exists concession_issuers (
  public_key   text primary key,
  name         text not null,
  kind         text not null,              -- 'campus', 'ward', 'operator', 'ministry'
  concessions  text[] not null,            -- what this office may certify
  registered_at timestamptz not null default now(),
  revoked_at   timestamptz                 -- set, never deleted: past rides stay explicable
);

create index if not exists concession_issuers_live on concession_issuers (public_key) where revoked_at is null;

-- Which way a leg went, for the operator's own view. Null on every leg settled
-- before this migration, which is honest: nobody checked those.
alter table legs add column if not exists concession_verified boolean;

-- The 17-argument form has to go before the 19-argument one lands, or a call
-- with 17 arguments matches both and Postgres refuses it as ambiguous.
drop function if exists settle_leg(text, text, text, text, text, text, integer, integer, integer, text, text, integer, text, timestamptz, timestamptz, text, text);

/*
  Settle a metered leg.

  Two amounts arrive now. `p_amount` is what the receipt says and what the
  vehicle's own arithmetic produced; `p_full_amount` is the same distance under
  the same tariff with no concession at all. The caller has already re-priced the
  receipt against the tariff it names — that check is what catches a broken meter
  — and has verified the attestation's signature and dates.

  This function decides the last part: is the issuer one we know? If yes, charge
  the concession fare. If no, charge the full one. A leg claiming no concession
  passes straight through, because there is nothing to back.
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
  p_receipt              text,
  p_full_amount          integer default null,
  p_issuer_public_key    text default null
) returns jsonb
language plpgsql
as $$
declare
  v_balance  integer;
  v_tap      leg_taps%rowtype;
  v_charge   integer;
  v_verified boolean;
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

  -- The concession, settled.
  if coalesce(p_concession, 'none') = 'none' then
    v_verified := null;
    v_charge := p_amount;
  elsif exists (
    select 1 from concession_issuers
     where public_key = p_issuer_public_key
       and revoked_at is null
       and p_concession = any (concessions)
  ) then
    v_verified := true;
    v_charge := p_amount;
  else
    -- No office on file stands behind this. Full fare, and say so on the row.
    v_verified := false;
    v_charge := coalesce(p_full_amount, p_amount);
  end if;

  select balance into v_balance
    from passengers
   where public_key = p_passenger_public_key
     for update;

  if not found then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'unknown_passenger');
  end if;

  if v_balance < v_charge then
    return jsonb_build_object(
      'legId', p_leg_id, 'ok', false, 'reason', 'insufficient_balance',
      'balance', v_balance, 'shortfall', v_charge - v_balance
    );
  end if;

  insert into legs (
    leg_id, vehicle_plate, trip_id, passenger_public_key,
    board_door, alight_door, board_odo_m, alight_odo_m,
    distance_m, distance_source, concession, amount, tariff_code,
    boarded_at, alighted_at, settled_by, receipt, concession_verified
  ) values (
    p_leg_id, p_vehicle_plate, p_trip_id, p_passenger_public_key,
    p_board_door, p_alight_door, p_board_odo_m, p_alight_odo_m,
    p_distance_m, p_distance_source, p_concession, v_charge, p_tariff_code,
    p_boarded_at, p_alighted_at, p_settled_by, p_receipt, v_verified
  );

  update passengers
     set balance = balance - v_charge,
         last_settled_at = now()
   where public_key = p_passenger_public_key
  returning balance into v_balance;

  return jsonb_build_object(
    'legId', p_leg_id, 'ok', true, 'balance', v_balance, 'amount', v_charge,
    'concession', coalesce(p_concession, 'none'),
    'concessionVerified', v_verified
  );

exception
  when unique_violation then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'replay');
end;
$$;

/*
  Unbacked concession claims, per vehicle.

  Not a fraud report. A run of these on one bus is more likely a ward office
  nobody has registered yet than a busload of liars, and that is exactly the
  thing an operator should be able to see and go fix.
*/
create or replace view concession_claims as
select
  vehicle_plate,
  concession,
  count(*)                                        as legs,
  count(*) filter (where concession_verified)     as backed,
  count(*) filter (where concession_verified = false) as unbacked,
  max(alighted_at)                                as last_seen
from legs
where concession <> 'none'
group by vehicle_plate, concession;

-- ----------------------------------------------------------------- lockdown

-- The register of offices is public knowledge by nature — a student has to be
-- able to find out where to get a card — and it holds no personal data at all:
-- an office name, a kind, and a public key. Readable; never writable.
alter table concession_issuers enable row level security;
revoke all on concession_issuers from anon, authenticated;
grant select on concession_issuers to anon, authenticated;
drop policy if exists concession_issuers_public_read on concession_issuers;
create policy concession_issuers_public_read on concession_issuers
  for select to anon, authenticated using (true);

-- The claims view reads `legs`, which already carries its own owner policy, so
-- an operator sees their own buses through it and nobody else's.
grant select on concession_claims to authenticated;

revoke all on function settle_leg(text, text, text, text, text, text, integer, integer, integer, text, text, integer, text, timestamptz, timestamptz, text, text, integer, text)
  from anon, authenticated, public;
