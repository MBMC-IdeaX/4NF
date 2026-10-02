-- Two rides of credit, so nobody is stranded over Rs 10.
--
-- A wallet that refuses a ride at Rs 5 leaves a person standing at a bus stop in
-- the dark. The passengers most likely to be at Rs 5 are the ones with the least
-- slack to absorb that, and a system that does it to them once has taught them
-- that cash is safer. Which it is, for them, and that is the adoption problem in
-- a single fare.
--
-- So a balance may go as far as -overdraft_npr. Small enough that walking away
-- from the debt is not worth the trouble, since the phone buys nothing until it
-- is cleared, and large enough that nobody is left at Koteshwor at ten at night
-- over the price of a samosa. It is a debt, recovered from the next top-up.

alter table passengers add column if not exists overdraft_npr integer not null default 50
  check (overdraft_npr >= 0);

-- The balance floor was zero since 0001. It has to become the overdraft, and it
-- stays a constraint rather than being dropped: the point is that a wallet can
-- go two rides behind and not one rupee further, and settle_leg() enforcing that
-- in plpgsql is a rule one bad call away from being skipped. Belt here, braces
-- there.
alter table passengers drop constraint if exists passengers_balance_check;
alter table passengers add constraint passengers_balance_check
  check (balance >= -overdraft_npr);

/*
  Settle a metered leg.

  One change from 0016: the floor on the balance check is the overdraft rather
  than zero. A wallet already at the floor is still refused, and the refusal now
  carries how far behind it is, so the app can tell the passenger something true
  instead of "declined".
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

  v_wallet := wallet_for(p_passenger_public_key);

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

/*
  Wallets carrying a debt.

  Not a collections list. It is here so an operator can see the overdraft being
  used the way it was meant — cleared on the next top-up — rather than becoming
  a way to ride for free, and so the size of the float is a number somebody can
  look at rather than a surprise at the end of a month.
*/
create or replace view wallet_overdrafts as
select
  public_key,
  balance,
  -balance     as owed,
  overdraft_npr,
  last_settled_at
from passengers
where balance < 0;

-- Wallet keys and balances are nobody's business but the operator's service role.
revoke all on wallet_overdrafts from anon, authenticated, public;

revoke all on function settle_leg(text, text, text, text, text, text, integer, integer, integer, text, text, integer, text, timestamptz, timestamptz, text, text, integer, text)
  from anon, authenticated, public;
