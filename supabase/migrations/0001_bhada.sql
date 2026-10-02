-- Bhada backend. Devices are the source of truth for what happened on the bus;
-- this schema is the source of truth for money. A fare only moves value here,
-- after the signature has been checked, and only once.

-- ---------------------------------------------------------------- operators

create table if not exists operators (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists vehicles (
  plate        text primary key,          -- also the conductor id in the token
  operator_id  text not null references operators(id),
  route_id     text,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------------- routes

create table if not exists stops (
  code      text primary key,
  name_ne   text not null,
  name_en   text not null,
  ordinal   integer not null             -- position along the corridor
);

create table if not exists routes (
  id       text primary key,
  name_ne  text not null,
  name_en  text not null
);

-- Regulated stop-to-stop fares. The device caches this table; the backend
-- keeps the authoritative copy and is what a dispute is settled against.
create table if not exists fares (
  route_id       text not null references routes(id),
  boarding_stop  text not null references stops(code),
  alighting_stop text not null references stops(code),
  amount         integer not null check (amount > 0),
  primary key (route_id, boarding_stop, alighting_stop)
);

-- --------------------------------------------------------------- passengers

create table if not exists passengers (
  public_key         text primary key,    -- base64url ed25519, the account name
  balance            integer not null default 0 check (balance >= 0),
  concession         text not null default 'none'
                       check (concession in ('none', 'student', 'senior')),
  registered_at      timestamptz not null default now(),
  last_settled_at    timestamptz
);

-- -------------------------------------------------------------------- trips

create table if not exists trips (
  id             text primary key,        -- minted on the conductor device
  vehicle_plate  text not null references vehicles(plate),
  started_at     timestamptz not null default now(),
  ended_at       timestamptz
);

-- ------------------------------------------------------------- transactions

create table if not exists transactions (
  nonce                 text primary key,
  passenger_public_key  text not null references passengers(public_key),
  vehicle_plate         text not null references vehicles(plate),
  trip_id               text,
  amount                integer not null check (amount > 0),
  boarding_stop         text not null,
  alighting_stop        text not null,
  sequence_number       integer not null,
  issued_at             timestamptz not null,
  collected_at          timestamptz,
  settled_at            timestamptz not null default now(),
  settled_by            text not null    -- public key of the device that synced
);

-- The replay guard. Sequence numbers are monotonic per passenger, so a repeated
-- pair is a replay no matter which device or trip it arrives from, and no matter
-- how many times a flaky connection retries the batch.
create unique index if not exists transactions_replay_guard
  on transactions (passenger_public_key, sequence_number);

create index if not exists transactions_trip on transactions (trip_id);
create index if not exists transactions_vehicle_time on transactions (vehicle_plate, settled_at);

-- --------------------------------------------------------------- settlement

/*
  Settle one already-verified fare.

  The caller (the sync Edge Function) has checked the ed25519 signature; this
  function owns the money and the once-only rule. It is deliberately written so
  that calling it twice with the same token is safe: the second call reports
  the replay instead of moving value again.
*/
create or replace function settle_fare(
  p_passenger_public_key text,
  p_vehicle_plate        text,
  p_trip_id              text,
  p_amount               integer,
  p_boarding_stop        text,
  p_alighting_stop       text,
  p_sequence_number      integer,
  p_nonce                text,
  p_issued_at            timestamptz,
  p_collected_at         timestamptz,
  p_settled_by           text
) returns jsonb
language plpgsql
as $$
declare
  v_balance integer;
begin
  -- An unknown passenger cannot be debited. Registration happens when a device
  -- first reaches the network, so this is a real state, not an error case.
  select balance into v_balance
    from passengers
   where public_key = p_passenger_public_key
     for update;

  if not found then
    return jsonb_build_object('nonce', p_nonce, 'ok', false, 'reason', 'unknown_passenger');
  end if;

  if exists (
    select 1 from transactions
     where passenger_public_key = p_passenger_public_key
       and sequence_number = p_sequence_number
  ) then
    -- A passenger phone does not know the trip id; only the conductor does. If
    -- the passenger synced first the row was stored without one, and rejecting
    -- the conductor's upload outright would throw the trip attribution away —
    -- losing the per-trip ridership that the operator dashboard exists to show.
    -- Backfilling it moves no money, so it is safe to do on a replay.
    if p_trip_id is not null then
      update transactions
         set trip_id = p_trip_id,
             collected_at = coalesce(collected_at, p_collected_at)
       where passenger_public_key = p_passenger_public_key
         and sequence_number = p_sequence_number
         and trip_id is null;
    end if;
    return jsonb_build_object('nonce', p_nonce, 'ok', false, 'reason', 'replay');
  end if;

  if v_balance < p_amount then
    -- The fare still happened; the passenger rode. It is recorded as owed
    -- rather than silently dropped, which is what the offline cap exists to
    -- keep small.
    return jsonb_build_object(
      'nonce', p_nonce, 'ok', false, 'reason', 'insufficient_balance',
      'balance', v_balance, 'shortfall', p_amount - v_balance
    );
  end if;

  insert into transactions (
    nonce, passenger_public_key, vehicle_plate, trip_id, amount,
    boarding_stop, alighting_stop, sequence_number,
    issued_at, collected_at, settled_by
  ) values (
    p_nonce, p_passenger_public_key, p_vehicle_plate, p_trip_id, p_amount,
    p_boarding_stop, p_alighting_stop, p_sequence_number,
    p_issued_at, p_collected_at, p_settled_by
  );

  update passengers
     set balance = balance - p_amount,
         last_settled_at = now()
   where public_key = p_passenger_public_key
  returning balance into v_balance;

  return jsonb_build_object('nonce', p_nonce, 'ok', true, 'balance', v_balance);

exception
  -- Two devices syncing the same fare at the same moment race past the check
  -- above; the unique index is what actually enforces once-only.
  when unique_violation then
    return jsonb_build_object('nonce', p_nonce, 'ok', false, 'reason', 'replay');
end;
$$;

-- ---------------------------------------------------------------- dashboard

-- Route-level ridership. No Nepali operator currently has this.
create or replace view trip_totals as
  select t.trip_id,
         t.vehicle_plate,
         count(*)          as passengers,
         sum(t.amount)     as collected,
         min(t.collected_at) as first_fare,
         max(t.collected_at) as last_fare
    from transactions t
   group by t.trip_id, t.vehicle_plate;

create or replace view ridership_by_hour as
  select vehicle_plate,
         date_trunc('hour', collected_at) as hour,
         count(*)      as passengers,
         sum(amount)   as collected
    from transactions
   where collected_at is not null
   group by vehicle_plate, date_trunc('hour', collected_at);
