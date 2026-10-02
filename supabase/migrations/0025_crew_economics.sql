-- The clean-trip bonus, and the mark a pulled plug leaves.
--
-- Everything Bhada has built so far takes something away from a conductor. Under
-- cash an uncounted passenger is the conductor's own money; once every boarding
-- runs through a door terminal there is nothing left to skim. A system that only
-- takes is a system the crew will defeat, and the cheapest way to defeat this one
-- is a ten-second reach under the seat for the meter's plug.
--
-- Two halves, and neither works alone. The pull leaves a mark — `meter_events`,
-- written by the device when its charger goes away while the bus is working — and
-- the honest trip pays: Rs 50 to the crew member signed on to it, when the trip
-- carried people, kept its power, never overrode the capacity interlock, and
-- metered nothing the plausibility score calls impossible.
--
-- What is clean is decided in protocol/crew.mjs, not here. settleBatch() counts
-- the evidence through trip_evidence(), judges it in the one place a batch is
-- ever judged, and calls award_clean_trip() with the answer. This file owns the
-- money and the once-only rule, which is the same division as settle_leg().

-- ===================================================== the box's own health

/*
  Not the door tape.

  door_events is the interlock record a regulator reads and it should stay about
  doors. A charger that went away is a fact about the box, and the two want
  different retention, different audiences and different questions asked of them.

  `moving` is why this is worth recording at all. A bus parked with the ignition
  off loses the same 12 V socket; the device only raises `power_lost` when the
  odometer has moved recently, and the flag travels with the event so an owner
  can see the device agreed the bus was working.
*/
create table if not exists meter_events (
  id             bigserial primary key,
  vehicle_plate  text not null references vehicles(plate),
  trip_id        text,
  at             timestamptz not null,
  kind           text not null check (kind in ('power_lost', 'power_restored')),
  moving         boolean,
  note           text
);

create index if not exists meter_events_vehicle_time on meter_events (vehicle_plate, at desc);
create index if not exists meter_events_trip on meter_events (trip_id) where kind = 'power_lost';

alter table meter_events enable row level security;
grant select on meter_events to authenticated;

drop policy if exists meter_events_own on meter_events;
create policy meter_events_own on meter_events
  for select to authenticated
  using (vehicle_plate in (select plate from vehicles where operator_id = current_operator_id()));

/*
  Append the device's power tape.

  Same contract as the door tape: appended, never merged. A summary somebody had
  the chance to tidy is not evidence.
*/
create or replace function append_meter_events(
  p_vehicle_plate text,
  p_events        jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_written integer;
begin
  insert into meter_events (vehicle_plate, trip_id, at, kind, moving, note)
  select p_vehicle_plate,
         nullif(event->>'tripId', ''),
         (event->>'at')::timestamptz,
         event->>'kind',
         (event->>'moving')::boolean,
         nullif(event->>'note', '')
    from jsonb_array_elements(p_events) as event
   where event->>'kind' in ('power_lost', 'power_restored');

  get diagnostics v_written = row_count;
  return jsonb_build_object('ok', true, 'written', v_written);
end;
$$;

-- ============================================================== who the crew is

/*
  There is no employee record in Bhada and this does not invent one.

  A crew member holds an ordinary wallet — the same one they ride on — and signs
  on at the console with a CR1 their own phone signed. The raw token is kept so
  the sign-on stays re-verifiable, exactly as a leg keeps its receipt.
*/
alter table trips add column if not exists crew_public_key text;
alter table trips add column if not exists crew_signed_on_at timestamptz;
alter table trips add column if not exists crew_sign_on text;

create index if not exists trips_crew on trips (crew_public_key) where crew_public_key is not null;

/*
  Record the sign-on against the trip, creating the trip row if the metered path
  has not made one yet — a metered trip has no conductor device to mint it.

  The signature was checked in settleBatch() before this was called. Written
  once: a second sign-on for the same trip is somebody swapping the credited key
  after the rides are in, which is the one thing the bonus must not allow.
*/
create or replace function note_crew(
  p_trip_id         text,
  p_vehicle_plate   text,
  p_crew_public_key text,
  p_signed_on_at    timestamptz,
  p_sign_on         text
) returns jsonb
language plpgsql
as $$
declare
  v_existing text;
begin
  insert into trips (id, vehicle_plate, started_at, crew_public_key, crew_signed_on_at, crew_sign_on)
  values (p_trip_id, p_vehicle_plate, p_signed_on_at, p_crew_public_key, p_signed_on_at, p_sign_on)
  on conflict (id) do nothing;

  select crew_public_key into v_existing from trips where id = p_trip_id;

  if v_existing is null then
    update trips
       set crew_public_key = p_crew_public_key,
           crew_signed_on_at = p_signed_on_at,
           crew_sign_on = p_sign_on
     where id = p_trip_id;
    return jsonb_build_object('ok', true, 'tripId', p_trip_id, 'crew', p_crew_public_key);
  end if;

  if v_existing = p_crew_public_key then
    return jsonb_build_object('ok', true, 'tripId', p_trip_id, 'crew', v_existing, 'reason', 'replay');
  end if;

  return jsonb_build_object('ok', false, 'tripId', p_trip_id, 'reason', 'crew_already_signed_on');
end;
$$;

-- ================================================================== the money

/*
  Every closed trip that had a crew signed on to it, paid or not.

  The misses are here on purpose. A crew that loses a bonus has to be able to see
  why without asking the owner, and `reasons` is the same list protocol/crew.mjs
  hands a console.

  Two sides in one row. `amount` is what reached the crew member's wallet and it
  is equally what the operator owes: Bhada holds passenger balances and owes the
  operator the fares their vehicles collected, so the bonus is that much moved
  out of the payable rather than money anyone invented. `wallet_public_key` is
  where it actually landed, which since daily keys (0016) is rarely the key the
  sign-on named.
*/
create table if not exists crew_bonuses (
  trip_id           text primary key,
  vehicle_plate     text not null references vehicles(plate),
  operator_id       text references operators(id),
  crew_public_key   text not null,
  wallet_public_key text references passengers(public_key),
  amount            integer not null check (amount >= 0),
  legs              integer not null default 0,
  fares             integer not null default 0,
  outcome           text not null check (outcome in ('paid', 'missed', 'no_wallet')),
  reasons           jsonb,
  awarded_at        timestamptz not null default now()
);

create index if not exists crew_bonuses_crew on crew_bonuses (crew_public_key, awarded_at desc);
create index if not exists crew_bonuses_vehicle on crew_bonuses (vehicle_plate, awarded_at desc);

alter table crew_bonuses enable row level security;
grant select on crew_bonuses to authenticated;

drop policy if exists crew_bonuses_own on crew_bonuses;
create policy crew_bonuses_own on crew_bonuses
  for select to authenticated
  using (vehicle_plate in (select plate from vehicles where operator_id = current_operator_id()));

-- ================================================================ the evidence

/*
  What the backend can count about one trip.

  Counted here, judged in protocol/crew.mjs. The rule for what makes a trip clean
  is policy, and policy that lives in two languages eventually disagrees with
  itself — the TAP_MAX_AGE_S duplication is the standing warning.
*/
create or replace function trip_evidence(p_trip_id text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'tripId', p_trip_id,
    'legs', (select count(*) from legs where trip_id = p_trip_id),
    'fares', (select coalesce(sum(amount), 0) from legs where trip_id = p_trip_id),
    'implausible', (select count(*) from legs where trip_id = p_trip_id and plausibility = 'high'),
    'powerLost', (select count(*) from meter_events where trip_id = p_trip_id and kind = 'power_lost'),
    'overrides', (select count(*) from door_events where trip_id = p_trip_id and kind = 'override_on'),
    'crewPublicKey', (select crew_public_key from trips where id = p_trip_id),
    'vehiclePlate', (select vehicle_plate from trips where id = p_trip_id),
    'awarded', exists (select 1 from crew_bonuses where trip_id = p_trip_id)
  )
$$;

/*
  Pay one trip's bonus, once.

  `p_amount` is what protocol/crew.mjs decided, and zero is an ordinary answer:
  the trip is still recorded with the reasons it missed. The primary key is the
  once-only rule — a trip closed twice, by a device that retried its batch or by
  two door phones each uploading the close, pays once and reports the replay.

  A crew member who has never used Bhada has no wallet to credit. That is
  recorded as `no_wallet` rather than paid into thin air; they sign up, the next
  trip pays, and the owner can settle the missed one by hand with a
  wallet_adjustment. It is not made into a queue, because a payable nobody can
  see is worse than a row that says plainly what happened.
*/
create or replace function award_clean_trip(
  p_trip_id         text,
  p_vehicle_plate   text,
  p_crew_public_key text,
  p_amount          integer,
  p_legs            integer,
  p_fares           integer,
  p_reasons         jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_wallet      text;
  v_operator    text;
  v_balance     integer;
  v_outcome     text;
  v_paid        integer := 0;
begin
  if exists (select 1 from crew_bonuses where trip_id = p_trip_id) then
    return jsonb_build_object('tripId', p_trip_id, 'ok', false, 'reason', 'replay');
  end if;

  select operator_id into v_operator from vehicles where plate = p_vehicle_plate;
  if not found then
    return jsonb_build_object('tripId', p_trip_id, 'ok', false, 'reason', 'unknown_vehicle');
  end if;

  -- Money moves on wallet_for(key), never on the key the sign-on names: since
  -- daily keys (0016) that key is a pseudonym with no money behind it.
  v_wallet := wallet_for(p_crew_public_key);
  if v_wallet is not null and not exists (select 1 from passengers where public_key = v_wallet) then
    v_wallet := null;
  end if;

  if p_amount <= 0 then
    v_outcome := 'missed';
  elsif v_wallet is null then
    v_outcome := 'no_wallet';
  else
    v_outcome := 'paid';
    v_paid := p_amount;
  end if;

  if v_outcome = 'paid' then
    update passengers
       set balance = balance + v_paid
     where public_key = v_wallet
    returning balance into v_balance;
  end if;

  insert into crew_bonuses (
    trip_id, vehicle_plate, operator_id, crew_public_key, wallet_public_key,
    amount, legs, fares, outcome, reasons
  ) values (
    p_trip_id, p_vehicle_plate, v_operator, p_crew_public_key,
    case when v_outcome = 'paid' then v_wallet else null end,
    v_paid, coalesce(p_legs, 0), coalesce(p_fares, 0), v_outcome, p_reasons
  );

  update trips set ended_at = coalesce(ended_at, now()) where id = p_trip_id;

  return jsonb_build_object(
    'tripId', p_trip_id, 'ok', true, 'outcome', v_outcome,
    'amount', v_paid, 'balance', v_balance, 'reasons', p_reasons
  );

exception
  when unique_violation then
    return jsonb_build_object('tripId', p_trip_id, 'ok', false, 'reason', 'replay');
end;
$$;

-- ================================================================== the views

/*
  What the owner pays out, and what it bought.

  Read as one line: this many trips ran with a crew signed on, this many were
  clean, this much left the fare payable. An operator whose clean rate is low is
  not looking at a dishonest crew so much as a bus whose meter keeps losing
  power — which is the next column along.
*/
create or replace view operator_crew_bonuses
with (security_invoker = true) as
  select vehicle_plate,
         date_trunc('day', awarded_at at time zone 'Asia/Kathmandu') as day,
         count(*)::int                                        as trips,
         count(*) filter (where outcome = 'paid')::int         as clean_trips,
         count(*) filter (where outcome = 'no_wallet')::int    as unpaid_no_wallet,
         coalesce(sum(amount), 0)::int                         as bonus_npr,
         coalesce(sum(fares), 0)::int                          as fares_npr,
         coalesce(sum(fares), 0)::int - coalesce(sum(amount), 0)::int as net_npr
    from crew_bonuses
   group by vehicle_plate, date_trunc('day', awarded_at at time zone 'Asia/Kathmandu');

-- Every trip that missed, with the reasons in the crew's own words.
create or replace view operator_bonus_misses
with (security_invoker = true) as
  select trip_id, vehicle_plate, crew_public_key, legs, fares, outcome, reasons, awarded_at
    from crew_bonuses
   where outcome <> 'paid';

-- Every time a meter lost its feed with the bus moving under it.
create or replace view operator_power_tamper
with (security_invoker = true) as
  select vehicle_plate, trip_id, at, kind, moving, note
    from meter_events
   where kind = 'power_lost';

grant select on operator_crew_bonuses, operator_bonus_misses, operator_power_tamper to authenticated;

revoke all on function append_meter_events(text, jsonb) from anon, authenticated, public;
revoke all on function note_crew(text, text, text, timestamptz, text) from anon, authenticated, public;
revoke all on function trip_evidence(text) from anon, authenticated, public;
revoke all on function award_clean_trip(text, text, text, integer, integer, integer, jsonb) from anon, authenticated, public;
