-- A different key every day, and the one table that knows they are the same person.
--
-- Every BT1 tap and BM1 receipt carries the passenger's public key in clear, and
-- both land in tables an operator can read. One key per phone forever means a
-- fleet owner can reconstruct a commute: this key boards at Thapathali at 08:32
-- every weekday and gets off at Koteshwor at 09:05. Nobody agreed to that when
-- they paid Rs 15 to get to work.
--
-- So the phone derives a fresh key per calendar day and signs its rides with
-- that. The operator sees unlinkable day-keys. Something still has to know which
-- wallet a day-key spends from, and that something is this table — service role
-- only, never readable by an operator, and deliberately the single place the
-- link exists.
--
-- What this protects against and what it does not, kept here so nobody reads
-- more into it later: it stops the fleet building movement records. It does not
-- hide anything from whoever runs this database, and on a route with three
-- passengers a day the timings re-identify people whatever key is on the row.

create table if not exists passenger_keys (
  pseudonym_public_key text primary key,
  root_public_key      text not null references passengers(public_key) on delete cascade,
  day_index            integer not null,
  link                 text not null,     -- the raw PK1, so this is re-verifiable
  registered_at        timestamptz not null default now()
);

-- Every pseudonym a wallet has ever used. Indexed this way round because the
-- lookup that happens on every settlement is pseudonym to root, and the lookup
-- that happens once in a support conversation is root to pseudonyms.
create index if not exists passenger_keys_root on passenger_keys (root_public_key, day_index desc);

/*
  File a day-key against its wallet.

  Both signatures were checked before this was called. What is left is what only
  the database can do: refuse to move a pseudonym to a different wallet once it
  has one. Without that, a second PK1 naming the same pseudonym and somebody
  else's root would redirect a passenger's fares onto a stranger's balance.
*/
create or replace function register_pseudonym(
  p_pseudonym_public_key text,
  p_root_public_key      text,
  p_day_index            integer,
  p_link                 text
) returns jsonb
language plpgsql
as $$
declare
  v_existing text;
begin
  select root_public_key into v_existing
    from passenger_keys where pseudonym_public_key = p_pseudonym_public_key;

  if found then
    if v_existing = p_root_public_key then
      return jsonb_build_object('ok', true, 'reason', 'already_registered');
    end if;
    -- A pseudonym belongs to one wallet, permanently.
    return jsonb_build_object('ok', false, 'reason', 'pseudonym_taken');
  end if;

  -- The wallet has to exist before a key can spend from it.
  if not exists (select 1 from passengers where public_key = p_root_public_key) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_passenger');
  end if;

  insert into passenger_keys (pseudonym_public_key, root_public_key, day_index, link)
  values (p_pseudonym_public_key, p_root_public_key, p_day_index, p_link);

  return jsonb_build_object('ok', true, 'reason', 'registered');

exception
  when unique_violation then
    return jsonb_build_object('ok', true, 'reason', 'already_registered');
end;
$$;

/*
  Which wallet a key spends from.

  A key with no row is its own wallet, which is every device that has not turned
  rotation on and every ride settled before this migration. That fallback is
  what makes the whole change backwards compatible rather than a flag day.
*/
create or replace function wallet_for(p_public_key text) returns text
language sql
stable
as $$
  select coalesce(
    (select root_public_key from passenger_keys where pseudonym_public_key = p_public_key),
    p_public_key
  );
$$;

/*
  Registering a device, now that a device has more than one key.

  The hole this closes: settlement registers whoever a receipt names, and with
  rotation that is a fresh key every day. Left alone, a passenger would collect
  the signup credit once per day simply by existing, and rotating faster would
  print money.

  So a key that is already somebody's pseudonym is not a new device. It gets its
  name row and no credit; the wallet behind it was registered the day it was
  created and was credited then, once.
*/
create or replace function register_device(
  p_public_key    text,
  p_signup_credit integer default 0
) returns jsonb
language plpgsql
as $$
declare
  v_new boolean;
  v_balance integer;
  v_wallet text;
begin
  v_wallet := wallet_for(p_public_key);

  -- A known pseudonym: the wallet is the thing that exists, and it is not new.
  if v_wallet <> p_public_key then
    insert into passengers (public_key, balance) values (p_public_key, 0)
    on conflict (public_key) do nothing;
    select balance into v_balance from passengers where public_key = v_wallet;
    return jsonb_build_object('ok', true, 'registered', false, 'balance', v_balance);
  end if;

  select not exists (select 1 from passengers where public_key = p_public_key) into v_new;

  insert into passengers (public_key, balance)
       values (p_public_key, 0)
  on conflict (public_key) do nothing;

  if v_new and p_signup_credit > 0 then
    perform credit_wallet(p_public_key, p_signup_credit, 'demo', 'signup:' || p_public_key);
  end if;

  select balance into v_balance from passengers where public_key = p_public_key;
  return jsonb_build_object('ok', true, 'registered', v_new, 'balance', v_balance);
end;
$$;

-- --------------------------------------------------- settlement, through it

drop function if exists settle_leg(text, text, text, text, text, text, integer, integer, integer, text, text, integer, text, timestamptz, timestamptz, text, text, integer, text);

/*
  Settle a metered leg.

  Unchanged except in one respect: the money comes out of wallet_for(passenger),
  not out of the key printed on the receipt. The leg still records the pseudonym
  — that is what makes the operator's copy unlinkable — while the balance moves
  on the account behind it.
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
  v_wallet   text;
begin
  if exists (select 1 from legs where leg_id = p_leg_id) then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'replay');
  end if;

  select * into v_tap from leg_taps where leg_id = p_leg_id;
  if not found then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'awaiting_tap');
  end if;
  if v_tap.passenger_public_key <> p_passenger_public_key
     or v_tap.vehicle_plate <> p_vehicle_plate
     or abs(extract(epoch from (v_tap.tapped_at - p_boarded_at))) > 300 then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'tap_mismatch');
  end if;

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
    v_verified := false;
    v_charge := coalesce(p_full_amount, p_amount);
  end if;

  v_wallet := wallet_for(p_passenger_public_key);

  select balance into v_balance
    from passengers
   where public_key = v_wallet
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

  -- The row names the pseudonym. legs.passenger_public_key references
  -- passengers, so a day-key needs a row of its own there; it is a name, not a
  -- wallet, and its balance is never read or moved.
  insert into passengers (public_key, balance)
  values (p_passenger_public_key, 0)
  on conflict (public_key) do nothing;

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
   where public_key = v_wallet
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

-- ----------------------------------------------------------------- lockdown

-- The only table in the system whose whole purpose is to link two identifiers.
-- RLS on with no policy: service role only. An operator reading this would undo
-- the entire point of rotating the keys.
alter table passenger_keys enable row level security;
revoke all on passenger_keys from anon, authenticated;

revoke all on function register_pseudonym(text, text, integer, text) from anon, authenticated, public;
revoke all on function wallet_for(text) from anon, authenticated, public;
revoke all on function settle_leg(text, text, text, text, text, text, integer, integer, integer, text, text, integer, text, timestamptz, timestamptz, text, text, integer, text)
  from anon, authenticated, public;
