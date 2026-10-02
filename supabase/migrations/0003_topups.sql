-- Wallet top-ups.
--
-- `passengers.balance` was a bare mutable column, which means a balance could
-- change with nothing to explain why. Every credit now leaves a row, so the
-- balance is reconstructable and a dispute has something to point at. This is
-- the table an eSewa or Khalti integration writes into later.

create table if not exists wallet_topups (
  id            bigserial primary key,
  public_key    text not null references passengers(public_key),
  amount        integer not null check (amount > 0),
  source        text not null,            -- 'demo', 'esewa', 'khalti', 'cash'
  reference     text,                     -- payment gateway reference
  created_at    timestamptz not null default now()
);

create index if not exists wallet_topups_passenger on wallet_topups (public_key, created_at);

-- A reference from a real payment gateway must never be credited twice.
create unique index if not exists wallet_topups_reference
  on wallet_topups (source, reference) where reference is not null;

/*
  Credit a wallet, recording why. Returns the new balance.

  Registration of an unseen device happens here too, because the first thing
  that ever happens to a new public key is a credit.
*/
create or replace function credit_wallet(
  p_public_key text,
  p_amount     integer,
  p_source     text,
  p_reference  text default null
) returns jsonb
language plpgsql
as $$
declare
  v_balance integer;
begin
  if p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  end if;

  insert into passengers (public_key, balance)
       values (p_public_key, 0)
  on conflict (public_key) do nothing;

  begin
    insert into wallet_topups (public_key, amount, source, reference)
         values (p_public_key, p_amount, p_source, p_reference);
  exception
    when unique_violation then
      -- The gateway retried a callback. Report the current balance rather than
      -- crediting the same payment a second time.
      select balance into v_balance from passengers where public_key = p_public_key;
      return jsonb_build_object('ok', false, 'reason', 'already_credited', 'balance', v_balance);
  end;

  update passengers
     set balance = balance + p_amount
   where public_key = p_public_key
  returning balance into v_balance;

  return jsonb_build_object('ok', true, 'balance', v_balance);
end;
$$;

/*
  Register a device the backend has not seen before.

  A brand new wallet is worth nothing. For the demo a signup credit can be
  configured, and because it goes through credit_wallet it is a visible row in
  wallet_topups with source 'demo' — not an unexplained balance. In a real
  deployment the credit is zero and value arrives from a payment gateway.
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
begin
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

-- Balance must always equal credits minus fares. Useful in a demo and the first
-- thing to check if the numbers are ever disputed.
create or replace view wallet_audit as
  select p.public_key,
         p.balance,
         coalesce((select sum(amount) from wallet_topups w where w.public_key = p.public_key), 0) as credited,
         coalesce((select sum(amount) from transactions t where t.passenger_public_key = p.public_key), 0) as spent,
         coalesce((select sum(amount) from wallet_topups w where w.public_key = p.public_key), 0)
           - coalesce((select sum(amount) from transactions t where t.passenger_public_key = p.public_key), 0)
           = p.balance as balances
    from passengers p;
