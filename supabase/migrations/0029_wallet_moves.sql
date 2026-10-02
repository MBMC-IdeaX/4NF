-- A lost phone no longer loses the money on it.
--
-- Until now a wallet was a key on one phone, and a login could hold exactly one
-- wallet: link_account() refused a second phone with account_has_wallet. Lose
-- the phone and the balance went with it. The login now owns the money. A new
-- phone, signed in to the same login, signs an AL1 with its own wallet key and
-- asks to move; move_wallet() carries the balance (or the debt) across in one
-- transaction and records it in wallet_moves.
--
-- What happens to the old phone's keys depends on when the ride happened:
--
--   * a ride that began before the move, still uploading from a phone that was
--     offline, is charged to the new wallet, because that is where the money
--     it was paid from now lives;
--   * a ride that began after the move is charged to the old wallet, which the
--     move leaves at zero with no overdraft. Whoever has the old phone rides on
--     nothing: the ride is refused as insufficient, the owner loses nothing.
--
-- So wallet_for() gains a second form, wallet_for(key, at), that follows a move
-- only for a ride that started before it. settle_leg() and settle_fare() are
-- re-created with exactly one change each, the call that picks the wallet;
-- everything else in them is copied unchanged from 0018 and 0022. The
-- one-argument wallet_for() follows every move, so refunds, crew bonuses and
-- day-key registration all reach the wallet the person holds today.
--
-- The move is authorised by the login's access token plus an AL1 signed by the
-- new wallet, checked in settleBatch() like every account link. Whoever holds
-- the login holds the money, as with any bank or wallet app.

create table if not exists wallet_moves (
  id          bigint generated always as identity primary key,
  from_wallet text not null unique references passengers(public_key),
  to_wallet   text not null references passengers(public_key),
  user_id     uuid references auth.users(id) on delete set null,
  amount      integer not null,
  link        text not null,
  moved_at    timestamptz not null default now(),
  check (from_wallet <> to_wallet)
);

create index if not exists wallet_moves_to on wallet_moves (to_wallet);

alter table wallet_moves enable row level security;
revoke all on wallet_moves from anon, authenticated;

-- The wallet a key spends from for a ride that started at p_at: its root, then
-- along any move made after p_at. A move made before the ride is not followed.
create or replace function wallet_for(p_public_key text, p_at timestamptz) returns text
language plpgsql
stable
as $$
declare
  v_wallet text;
  v_next   text;
begin
  select coalesce(
    (select root_public_key from passenger_keys where pseudonym_public_key = p_public_key),
    p_public_key
  ) into v_wallet;

  for hop in 1..16 loop
    select to_wallet into v_next
      from wallet_moves
     where from_wallet = v_wallet and moved_at > coalesce(p_at, '-infinity'::timestamptz);
    exit when not found;
    v_wallet := v_next;
  end loop;
  return v_wallet;
end;
$$;

-- The wallet a key's owner holds today: every move followed.
create or replace function wallet_for(p_public_key text) returns text
language sql
stable
as $$
  select wallet_for(p_public_key, '-infinity'::timestamptz);
$$;

revoke all on function wallet_for(text, timestamptz) from anon, authenticated, public;
revoke all on function wallet_for(text) from anon, authenticated, public;

create or replace function move_wallet(p_user_id uuid, p_new_wallet text, p_link text)
returns jsonb
language plpgsql
as $$
declare
  v_account passenger_accounts%rowtype;
  v_old     passengers%rowtype;
  v_new     passengers%rowtype;
begin
  select * into v_account from passenger_accounts where user_id = p_user_id for update;
  if not found then
    -- Nothing to move from: this is a first link.
    return link_account(p_user_id, p_new_wallet, p_link);
  end if;
  if v_account.wallet_public_key = p_new_wallet then
    return jsonb_build_object('ok', true, 'moved', false, 'wallet', p_new_wallet);
  end if;
  if v_account.suspended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'suspended',
      'message', 'This account is suspended. Contact Bhada.');
  end if;
  if wallet_for(p_new_wallet) <> p_new_wallet then
    return jsonb_build_object('ok', false, 'reason', 'not_a_wallet',
      'message', 'That key is a day-key or an old wallet, not a phone''s wallet.');
  end if;
  if exists (select 1 from passenger_accounts where wallet_public_key = p_new_wallet) then
    return jsonb_build_object('ok', false, 'reason', 'wallet_taken',
      'message', 'This phone''s wallet already belongs to another login.');
  end if;

  -- Both rows locked, in key order so two moves cannot deadlock.
  perform 1 from passengers
    where public_key in (v_account.wallet_public_key, p_new_wallet)
    order by public_key
    for update;
  select * into v_old from passengers where public_key = v_account.wallet_public_key;
  select * into v_new from passengers where public_key = p_new_wallet;
  if v_new.public_key is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_wallet',
      'message', 'This phone has not been seen by Bhada yet.');
  end if;
  if v_new.balance + v_old.balance < -v_new.overdraft_npr then
    return jsonb_build_object('ok', false, 'reason', 'would_overdraw',
      'message', 'Both phones owe money; top up one of them first.');
  end if;

  update passengers set balance = balance + v_old.balance where public_key = p_new_wallet;
  update passengers set balance = 0, overdraft_npr = 0 where public_key = v_old.public_key;
  insert into wallet_moves (from_wallet, to_wallet, user_id, amount, link)
  values (v_old.public_key, p_new_wallet, p_user_id, v_old.balance, p_link);
  update passenger_accounts
     set wallet_public_key = p_new_wallet, link = p_link, linked_at = now()
   where user_id = p_user_id;

  return jsonb_build_object('ok', true, 'moved', true, 'wallet', p_new_wallet,
    'from', v_old.public_key, 'amount', v_old.balance);
end;
$$;

revoke all on function move_wallet(uuid, text, text) from anon, authenticated, public;

-- ------------------------------------------------ settle_leg, from 0018
-- One change: wallet_for(p_passenger_public_key, p_boarded_at).

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
  v_balance   integer;
  v_overdraft integer;
  v_tap       leg_taps%rowtype;
  v_charge    integer;
  v_verified  boolean;
  v_wallet    text;
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

  v_wallet := wallet_for(p_passenger_public_key, p_boarded_at);

  select balance, overdraft_npr into v_balance, v_overdraft
    from passengers
   where public_key = v_wallet
     for update;

  if not found then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'unknown_passenger');
  end if;

  -- The floor, not zero. A ride that would put this wallet further behind than
  -- its overdraft allows is refused; one that fits is taken, and the passenger
  -- gets home.
  if v_balance - v_charge < -coalesce(v_overdraft, 0) then
    return jsonb_build_object(
      'legId', p_leg_id, 'ok', false, 'reason', 'insufficient_balance',
      'balance', v_balance, 'overdraft', v_overdraft,
      'shortfall', v_charge - v_balance - coalesce(v_overdraft, 0)
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
    'concessionVerified', v_verified,
    'owed', greatest(0, -v_balance)
  );

exception
  when unique_violation then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'replay');
end;
$$;

-- ----------------------------------------------- settle_fare, from 0022
-- One change: wallet_for(p_passenger_public_key, p_issued_at).

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
  v_wallet  text;
begin
  -- The ticket names the key that signed it; the money is the wallet's.
  v_wallet := wallet_for(p_passenger_public_key, p_issued_at);

  select balance into v_balance
    from passengers
   where public_key = v_wallet
     for update;

  if not found or not exists (select 1 from passengers where public_key = p_passenger_public_key) then
    return jsonb_build_object('nonce', p_nonce, 'ok', false, 'reason', 'unknown_passenger');
  end if;

  if exists (
    select 1 from transactions
     where passenger_public_key = p_passenger_public_key
       and sequence_number = p_sequence_number
  ) then
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

  -- Stage fares still stop at zero: the overdraft (0018) is for metered legs.
  if v_balance < p_amount then
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
   where public_key = v_wallet
  returning balance into v_balance;

  return jsonb_build_object('nonce', p_nonce, 'ok', true, 'balance', v_balance);

exception
  when unique_violation then
    return jsonb_build_object('nonce', p_nonce, 'ok', false, 'reason', 'replay');
end;
$$;

-- ------------------------------------------ wallet_statement, from 0022
-- Follows the money. The old phones' top-ups and corrections are this wallet's
-- history too, since their balance was carried here; rides count when they were
-- charged here, which wallet_for(key, boarded) decides — so a ride someone takes
-- on the old phone after the move never appears on the new statement. No line
-- for the move itself: the old history already adds up to what was carried.

create or replace function wallet_statement(p_wallet text, p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_balance   integer;
  v_overdraft integer;
  v_entries   jsonb;
begin
  select balance, overdraft_npr into v_balance, v_overdraft from passengers where public_key = p_wallet;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_wallet');
  end if;

  with recursive merged as (
    -- This wallet and every wallet moved into it, however many phones ago.
    select p_wallet as w
    union
    select m.from_wallet from wallet_moves m join merged on m.to_wallet = merged.w
  ),
  keys as (
    select w as k from merged
    union
    select pseudonym_public_key from passenger_keys where root_public_key in (select w from merged)
  ),
  moves as (
    select t.created_at as at,
           case when t.source = 'refund' then 'refund' else 'topup' end as kind,
           case t.source
             when 'refund'  then 'Refund · unclosed ride'
             when 'esewa'   then 'Top-up · eSewa'
             when 'khalti'  then 'Top-up · Khalti'
             when 'fonepay' then 'Top-up · Fonepay'
             when 'imepay'  then 'Top-up · IME Pay'
             when 'cash'    then 'Top-up · Cash'
             when 'demo'    then 'Welcome credit'
             else 'Top-up · ' || t.source
           end as title,
           coalesce(t.note, t.reference) as detail,
           t.amount as amount
      from wallet_topups t
     where t.public_key in (select w from merged)
    union all
    select a.created_at, 'adjustment', 'Correction', a.reason, a.amount
      from wallet_adjustments a
     where a.wallet_public_key in (select w from merged)
    union all
    select l.alighted_at, 'ride',
           'Ride · ' || to_char(l.distance_m / 1000.0, 'FM990.0') || ' km',
           l.vehicle_plate || case when l.distance_source = 'unclosed' then ' · not tapped out' else '' end,
           -l.amount
      from legs l
     where l.passenger_public_key in (select k from keys)
       and wallet_for(l.passenger_public_key, l.boarded_at) = p_wallet
    union all
    select coalesce(x.collected_at, x.settled_at), 'stage_fare',
           'Stage fare',
           x.vehicle_plate || ' · ' || x.boarding_stop || ' → ' || x.alighting_stop,
           -x.amount
      from transactions x
     where x.passenger_public_key in (select k from keys)
       and wallet_for(x.passenger_public_key, x.issued_at) = p_wallet
  ),
  opened as (
    select * from moves
    union all
    select '-infinity'::timestamptz, 'opening', 'Opening balance', null::text,
           v_balance - (select coalesce(sum(amount), 0) from moves)
     where v_balance - (select coalesce(sum(amount), 0) from moves) <> 0
  ),
  ordered as (
    select m.*,
           v_balance - coalesce(sum(amount) over (order by at desc, kind rows between unbounded preceding and 1 preceding), 0)
             as balance_after
      from opened m
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'at', case when at = '-infinity' then null else at end,
           'kind', kind, 'title', title, 'detail', detail,
           'amount', amount, 'balance_after', balance_after
         ) order by at desc, kind), '[]'::jsonb)
    into v_entries
    from (select * from ordered order by at desc, kind limit greatest(1, least(p_limit, 1000))) page;

  return jsonb_build_object(
    'ok', true,
    'wallet', p_wallet,
    'balance', v_balance,
    'overdraft', v_overdraft,
    'owed', greatest(0, -v_balance)
  , 'entries', v_entries
  );
end;
$$;
