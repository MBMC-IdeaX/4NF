-- The meter: distance legs, vehicle keys, capacity, and the door tape.
--
-- Everything here follows the rule migration 0001 set. The vehicle is the source
-- of truth for what happened on the road; this schema is the source of truth for
-- money, and it only moves value after a signature has been checked, once.
--
-- What is new is the second signature. A stage fare is agreed by a passenger and
-- a conductor. A distance fare is agreed by a passenger's tap and a vehicle's
-- odometer, so the vehicle needs an identity here too — a public key on file
-- that the Edge Function can verify a BM1 receipt against. Without it an
-- operator could post any distance they liked and call it a ride.

-- ------------------------------------------------------- vehicle as a device

alter table vehicles add column if not exists public_key text;
alter table vehicles add column if not exists capacity integer;
alter table vehicles add column if not exists seated integer;
alter table vehicles add column if not exists standing integer;
alter table vehicles add column if not exists meter_firmware text;
alter table vehicles add column if not exists meter_seen_at timestamptz;

-- A key may only belong to one vehicle. Two buses sharing a key would make
-- every receipt from either of them unattributable.
create unique index if not exists vehicles_public_key_unique
  on vehicles (public_key) where public_key is not null;

-- The permitted load from the route permit. `capacity` is what the door
-- interlock enforces on the vehicle; storing it here is what lets the operator
-- change it centrally and lets an inspector check what it was set to.
alter table vehicles
  add constraint vehicles_capacity_sane
  check (capacity is null or (capacity > 0 and capacity <= 200)) not valid;

-- --------------------------------------------------------------- tariffs

/*
  A published distance tariff. Kept as rows rather than constants because the
  fare a passenger was charged has to be reproducible years later, and that
  means knowing which tariff was in force on the day — not which one is in force
  now. Nothing overwrites a tariff; a change is a new row with a new code.
*/
create table if not exists tariffs (
  code             text primary key,
  route_id         text references routes(id),
  boarding_charge  integer not null check (boarding_charge >= 0),
  included_km      numeric(6,3) not null check (included_km >= 0),
  step_km          numeric(6,3) not null check (step_km > 0),
  per_step         integer not null check (per_step >= 0),
  cap              integer not null check (cap > 0),
  unclosed_fare    integer not null check (unclosed_fare > 0),
  effective_from   timestamptz not null default now(),
  published_by     text
);

insert into tariffs (code, route_id, boarding_charge, included_km, step_km, per_step, cap, unclosed_fare, published_by)
values ('NPR-KTM-2026', 'R11', 15, 2, 1, 3, 25, 25, 'demo seed')
on conflict (code) do nothing;

-- ------------------------------------------------------------------- legs

/*
  One row per completed ride.

  `distance_source` is not a detail. It is the difference between a fare the
  operator can defend and a fare they estimated, and a passenger disputing a
  charge is entitled to know which one they got. It is stored, indexed and shown
  on the dashboard rather than being collapsed into the distance.
*/
create table if not exists legs (
  leg_id               text primary key,
  vehicle_plate        text not null references vehicles(plate),
  trip_id              text,
  passenger_public_key text not null references passengers(public_key),
  board_door           text not null,
  alight_door          text not null,
  board_odo_m          integer not null check (board_odo_m >= 0),
  alight_odo_m         integer not null check (alight_odo_m >= 0),
  distance_m           integer not null check (distance_m >= 0),
  distance_source      text not null check (distance_source in ('odometer', 'gps', 'stage')),
  concession           text not null default 'none',
  amount               integer not null check (amount >= 0),
  tariff_code          text references tariffs(code),
  boarded_at           timestamptz not null,
  alighted_at          timestamptz not null,
  settled_at           timestamptz not null default now(),
  settled_by           text not null,
  receipt              text not null      -- the raw BM1, so this is re-verifiable
);

create index if not exists legs_vehicle_time on legs (vehicle_plate, alighted_at);
create index if not exists legs_passenger on legs (passenger_public_key);
create index if not exists legs_trip on legs (trip_id);
create index if not exists legs_source on legs (distance_source);

-- ------------------------------------------------------------ door events

/*
  The interlock tape.

  This table is the reason the door feature is worth anything to a regulator. A
  bus that was over its permitted load leaves a row here whether or not the crew
  wanted one, and an override — the one way past the interlock — is written with
  the count at the moment it was used. Overloading stops being deniable.
*/
create table if not exists door_events (
  id             bigserial primary key,
  vehicle_plate  text not null references vehicles(plate),
  trip_id        text,
  at             timestamptz not null,
  kind           text not null check (kind in ('locked', 'unlocked', 'override_on', 'override_off', 'refused', 'tamper')),
  door           text,
  onboard        integer,
  capacity       integer,
  note           text
);

create index if not exists door_events_vehicle_time on door_events (vehicle_plate, at desc);
create index if not exists door_events_overrides on door_events (kind) where kind = 'override_on';

-- ---------------------------------------------------------------- settlement

/*
  Settle one already-verified distance leg.

  Same contract as settle_fare(): the caller has checked the signature and
  re-priced the ride from the recorded distance; this owns the money and the
  once-only rule. Calling it twice with the same leg reports the replay rather
  than charging twice.
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
begin
  select balance into v_balance
    from passengers
   where public_key = p_passenger_public_key
     for update;

  if not found then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'unknown_passenger');
  end if;

  if exists (select 1 from legs where leg_id = p_leg_id) then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'replay');
  end if;

  -- A free leg is legitimate: staff concession, or a zero-distance ride that
  -- opened and closed at the same point. It is recorded, and no value moves.
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

/*
  Register a vehicle's meter the first time it reaches the network.

  The key is written once and then frozen. A vehicle that turns up with a
  different key is a vehicle whose box has been swapped or cloned, and that has
  to be an operator decision rather than something a POST can do quietly.
*/
create or replace function register_meter(
  p_vehicle_plate text,
  p_public_key    text,
  p_capacity      integer default null,
  p_firmware      text default null
) returns jsonb
language plpgsql
as $$
declare
  v_existing text;
begin
  select public_key into v_existing from vehicles where plate = p_vehicle_plate;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle');
  end if;

  if v_existing is null then
    update vehicles
       set public_key = p_public_key,
           capacity = coalesce(p_capacity, capacity),
           meter_firmware = coalesce(p_firmware, meter_firmware),
           meter_seen_at = now()
     where plate = p_vehicle_plate;
    return jsonb_build_object('ok', true, 'reason', 'registered');
  end if;

  if v_existing <> p_public_key then
    return jsonb_build_object('ok', false, 'reason', 'key_mismatch');
  end if;

  update vehicles
     set meter_seen_at = now(),
         meter_firmware = coalesce(p_firmware, meter_firmware),
         capacity = coalesce(p_capacity, capacity)
   where plate = p_vehicle_plate;
  return jsonb_build_object('ok', true, 'reason', 'seen');
end;
$$;

-- ----------------------------------------------------------------- reporting

-- What a route actually earns per kilometre carried, which is the number an
-- operator needs to argue for a tariff change and has never had.
create or replace view leg_economics as
  select vehicle_plate,
         date_trunc('day', alighted_at) as day,
         count(*)                                    as rides,
         sum(distance_m) / 1000.0                    as passenger_km,
         sum(amount)                                 as collected,
         round(sum(amount) / nullif(sum(distance_m) / 1000.0, 0), 2) as npr_per_passenger_km,
         round(avg(distance_m) / 1000.0, 2)          as mean_ride_km,
         count(*) filter (where distance_source = 'odometer') as measured,
         count(*) filter (where distance_source <> 'odometer') as estimated
    from legs
   group by vehicle_plate, date_trunc('day', alighted_at);

-- Every time a bus was at or over its permitted load, and what the crew did.
create or replace view overload_log as
  select d.vehicle_plate,
         d.at,
         d.kind,
         d.onboard,
         d.capacity,
         d.onboard - d.capacity as over_by,
         d.note
    from door_events d
   where d.kind in ('locked', 'override_on', 'refused')
   order by d.at desc;

-- ----------------------------------------------------------------- lockdown

alter table legs        enable row level security;
alter table door_events enable row level security;
alter table tariffs     enable row level security;

-- A tariff is published information, like the stage fare table: a device has to
-- be able to price a ride offline, and a regulated price is not a secret.
drop policy if exists tariffs_public_read on tariffs;
create policy tariffs_public_read on tariffs for select to anon, authenticated using (true);

revoke all on legs, door_events from anon, authenticated;
revoke all on leg_economics, overload_log from anon, authenticated;
grant select on tariffs to anon, authenticated;

revoke all on function settle_leg(text, text, text, text, text, text, integer, integer, integer, text, text, integer, text, timestamptz, timestamptz, text, text)
  from anon, authenticated, public;
revoke all on function register_meter(text, text, integer, text) from anon, authenticated, public;
