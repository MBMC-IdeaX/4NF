-- Accounts, statements, top-up requests, and the people allowed to run them.
--
-- Until now a passenger was a key and nothing else, and the only people who
-- could move money by hand were whoever held the service role. This adds:
--
--   - passenger logins, joined to a wallet only by a signature from that wallet
--     (AL1, checked in settleBatch) — never by typing a key into a form;
--   - a statement per wallet that adds up to its balance;
--   - top-up requests that a super admin loads once, against a payment
--     reference that can be used once;
--   - corrections that are new rows with a reason, never edits;
--   - suspension that closes a portal without stranding a fare;
--   - a platform_admins table, checked inside every admin function, so the
--     browser never needs the service key.
--
-- And two repairs to the daily keys of 0016, found while writing the
-- statement: settle_fare() still debited the key on the ticket and
-- file_dispute() still refunded it. Since 0016 the key on a ticket is a day-key
-- with no money behind it, so a stage fare from an updated phone was refused as
-- insufficient_balance and a dead-phone refund landed on a row nobody reads.
-- Both now move money on wallet_for(key), as settle_leg() already did.

-- ============================================================== authority

create table if not exists platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table platform_admins enable row level security;
revoke all on platform_admins from anon, authenticated;

create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from platform_admins where user_id = auth.uid())
$$;

grant execute on function is_platform_admin() to authenticated;

-- ============================================================== accounts

create table if not exists passenger_accounts (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  wallet_public_key text not null unique references passengers(public_key),
  link              text not null,
  linked_at         timestamptz not null default now(),
  suspended_at      timestamptz
);

alter table passenger_accounts enable row level security;
revoke all on passenger_accounts from anon, authenticated;

/*
  Join a login to a wallet. Called only by the sync function, after it has
  checked the AL1 signature and the caller's access token.
*/
create or replace function link_account(p_user_id uuid, p_wallet text, p_link text)
returns jsonb
language plpgsql
as $$
declare
  v_row passenger_accounts%rowtype;
begin
  select * into v_row from passenger_accounts where user_id = p_user_id;
  if found then
    if v_row.wallet_public_key = p_wallet then
      return jsonb_build_object('ok', true, 'created', false, 'wallet', p_wallet);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'account_has_wallet',
      'message', 'This login already has a wallet from another phone.');
  end if;

  if exists (select 1 from passenger_accounts where wallet_public_key = p_wallet) then
    return jsonb_build_object('ok', false, 'reason', 'wallet_taken',
      'message', 'This wallet already belongs to another login.');
  end if;

  insert into passenger_accounts (user_id, wallet_public_key, link)
  values (p_user_id, p_wallet, p_link);
  return jsonb_build_object('ok', true, 'created', true, 'wallet', p_wallet);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'wallet_taken',
      'message', 'This wallet already belongs to another login.');
end;
$$;

revoke all on function link_account(uuid, text, text) from anon, authenticated, public;

-- ======================================================= money, repaired

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
  v_wallet := wallet_for(p_passenger_public_key);

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

revoke all on function settle_fare(text, text, text, integer, text, text, integer, text, timestamptz, timestamptz, text)
  from anon, authenticated, public;

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
  v_wallet  text;
begin
  if exists (select 1 from leg_disputes where leg_id = p_leg_id) then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'replay');
  end if;

  select * into v_leg from legs where leg_id = p_leg_id;
  if not found then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'unknown_leg');
  end if;

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

  if p_refund_npr > v_leg.amount then
    return jsonb_build_object('legId', p_leg_id, 'ok', false, 'reason', 'refund_exceeds_charge');
  end if;

  -- The leg was paid from the wallet behind the key; the refund goes back there.
  v_wallet := wallet_for(p_passenger_public_key);

  insert into wallet_topups (public_key, amount, source, reference)
  values (v_wallet, p_refund_npr, 'refund', p_leg_id);

  update passengers
     set balance = balance + p_refund_npr
   where public_key = v_wallet
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

revoke all on function file_dispute(text, text, text, text, integer, timestamptz, integer, integer, integer, integer, text, text)
  from anon, authenticated, public;

-- ============================================================ corrections

alter table wallet_topups add column if not exists note text;

create table if not exists wallet_adjustments (
  id                bigint generated always as identity primary key,
  wallet_public_key text not null references passengers(public_key),
  amount            integer not null check (amount <> 0),
  reason            text not null check (length(trim(reason)) >= 3),
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now()
);

alter table wallet_adjustments enable row level security;
revoke all on wallet_adjustments from anon, authenticated;

-- ======================================================= top-up requests

create table if not exists topup_requests (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  wallet_public_key text not null references passengers(public_key),
  method            text not null check (method in ('esewa', 'khalti', 'fonepay', 'imepay')),
  amount            integer not null check (amount between 10 and 10000),
  reference         text not null,
  status            text not null default 'pending' check (status in ('pending', 'loaded', 'rejected')),
  note              text,
  created_at        timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by        uuid references auth.users(id),
  unique (method, reference)
);

create index if not exists topup_requests_status on topup_requests (status, created_at);

alter table topup_requests enable row level security;
revoke all on topup_requests from anon, authenticated;

-- ============================================================== settings

create table if not exists platform_settings (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table platform_settings enable row level security;
drop policy if exists platform_settings_read on platform_settings;
create policy platform_settings_read on platform_settings for select to authenticated using (true);
grant select on platform_settings to authenticated;

insert into platform_settings (key, value) values
  ('esewa_id', ''), ('esewa_qr_url', ''),
  ('khalti_id', ''), ('khalti_qr_url', ''),
  ('fonepay_id', ''), ('fonepay_qr_url', ''),
  ('imepay_id', ''), ('imepay_qr_url', ''),
  ('support_phone', '')
on conflict (key) do nothing;

-- ============================================================= suspension

alter table operators add column if not exists suspended_at timestamptz;

create or replace function current_operator_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select ou.operator_id
    from operator_users ou
    join operators o on o.id = ou.operator_id
   where ou.user_id = auth.uid()
     and o.suspended_at is null
$$;

create or replace function my_operator()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when ou.operator_id is null then jsonb_build_object('registered', false)
    else jsonb_build_object(
      'registered', true,
      'operator_id', ou.operator_id,
      'name', o.name,
      'display_name', ou.display_name,
      'suspended', o.suspended_at is not null,
      'vehicles', (select count(*) from vehicles v where v.operator_id = ou.operator_id)
    )
  end
  from (select 1) x
  left join operator_users ou on ou.user_id = auth.uid()
  left join operators o on o.id = ou.operator_id
$$;

-- ============================================================= statement

/*
  Every movement on a wallet, newest first, with the balance after each.

  A wallet's rides are signed by its day-keys, so the keys are the wallet and
  every pseudonym linked to it. If the rows do not add up to the stored
  balance — a wallet seeded before top-ups were recorded — the difference is
  shown as an opening balance rather than hidden.
*/
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

  with keys as (
    select p_wallet as k
    union
    select pseudonym_public_key from passenger_keys where root_public_key = p_wallet
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
     where t.public_key = p_wallet
    union all
    select a.created_at, 'adjustment', 'Correction', a.reason, a.amount
      from wallet_adjustments a
     where a.wallet_public_key = p_wallet
    union all
    select l.alighted_at, 'ride',
           'Ride · ' || to_char(l.distance_m / 1000.0, 'FM990.0') || ' km',
           l.vehicle_plate || case when l.distance_source = 'unclosed' then ' · not tapped out' else '' end,
           -l.amount
      from legs l
     where l.passenger_public_key in (select k from keys)
    union all
    select coalesce(x.collected_at, x.settled_at), 'stage_fare',
           'Stage fare',
           x.vehicle_plate || ' · ' || x.boarding_stop || ' → ' || x.alighting_stop,
           -x.amount
      from transactions x
     where x.passenger_public_key in (select k from keys)
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
    'owed', greatest(0, -v_balance),
    'entries', v_entries
  );
end;
$$;

revoke all on function wallet_statement(text, integer) from anon, authenticated, public;

-- ======================================================= passenger portal

create or replace function my_account()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when a.user_id is null then jsonb_build_object('linked', false, 'email', u.email)
    else jsonb_build_object(
      'linked', true,
      'email', u.email,
      'wallet', a.wallet_public_key,
      'linked_at', a.linked_at,
      'suspended', a.suspended_at is not null,
      'balance', p.balance,
      'overdraft', p.overdraft_npr,
      'owed', greatest(0, -p.balance)
    )
  end
  from (select 1) x
  left join auth.users u on u.id = auth.uid()
  left join passenger_accounts a on a.user_id = auth.uid()
  left join passengers p on p.public_key = a.wallet_public_key
$$;

create or replace function my_statement(p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_account passenger_accounts%rowtype;
begin
  select * into v_account from passenger_accounts where user_id = auth.uid();
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_linked');
  end if;
  if v_account.suspended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'suspended');
  end if;
  return wallet_statement(v_account.wallet_public_key, p_limit);
end;
$$;

create or replace function request_topup(p_method text, p_amount integer, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account passenger_accounts%rowtype;
  v_id      bigint;
begin
  select * into v_account from passenger_accounts where user_id = auth.uid();
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_linked');
  end if;
  if v_account.suspended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'suspended');
  end if;
  if p_method not in ('esewa', 'khalti', 'fonepay', 'imepay') then
    return jsonb_build_object('ok', false, 'reason', 'bad_method');
  end if;
  if p_amount is null or p_amount < 10 or p_amount > 10000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;
  if coalesce(trim(p_reference), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'reference_required');
  end if;
  if (select count(*) from topup_requests where user_id = auth.uid() and status = 'pending') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_pending');
  end if;

  insert into topup_requests (user_id, wallet_public_key, method, amount, reference)
  values (auth.uid(), v_account.wallet_public_key, p_method, p_amount, upper(trim(p_reference)))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending');
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_reference');
end;
$$;

create or replace function my_topup_requests()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'method', method, 'amount', amount, 'reference', reference,
           'status', status, 'note', note, 'created_at', created_at, 'decided_at', decided_at
         ) order by created_at desc), '[]'::jsonb)
    from topup_requests
   where user_id = auth.uid()
$$;

grant execute on function my_account() to authenticated;
grant execute on function my_statement(integer) to authenticated;
grant execute on function request_topup(text, integer, text) to authenticated;
grant execute on function my_topup_requests() to authenticated;
revoke all on function my_account() from anon, public;
revoke all on function my_statement(integer) from anon, public;
revoke all on function request_topup(text, integer, text) from anon, public;
revoke all on function my_topup_requests() from anon, public;

-- =========================================================== admin console

create or replace function not_admin()
returns jsonb
language sql
immutable
as $$ select jsonb_build_object('ok', false, 'reason', 'not_admin') $$;

create or replace function admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then return not_admin(); end if;
  return jsonb_build_object(
    'ok', true,
    'loaded_npr', (select coalesce(sum(amount), 0) from wallet_topups where source not in ('demo', 'refund')),
    'welcome_npr', (select coalesce(sum(amount), 0) from wallet_topups where source = 'demo'),
    'refunded_npr', (select coalesce(sum(amount), 0) from wallet_topups where source = 'refund'),
    'fares_npr', (select coalesce(sum(amount), 0) from legs) + (select coalesce(sum(amount), 0) from transactions),
    'rides', (select count(*) from legs) + (select count(*) from transactions),
    'wallet_npr', (select coalesce(sum(balance), 0) from passengers where public_key not in (select pseudonym_public_key from passenger_keys)),
    'overdraft_npr', (select coalesce(sum(-balance), 0) from passengers where balance < 0),
    'pending_requests', (select count(*) from topup_requests where status = 'pending'),
    'pending_npr', (select coalesce(sum(amount), 0) from topup_requests where status = 'pending'),
    'wallets', (select count(*) from passengers where public_key not in (select pseudonym_public_key from passenger_keys)),
    'accounts', (select count(*) from passenger_accounts),
    'operators', (select count(*) from operators),
    'buses', (select count(*) from vehicles where retired_at is null),
    'buses_reporting', (select count(*) from vehicles v
                         where greatest(v.meter_seen_at,
                                        (select max(settled_at) from legs l where l.vehicle_plate = v.plate),
                                        (select max(settled_at) from transactions t where t.vehicle_plate = v.plate))
                               > now() - interval '24 hours')
  );
end;
$$;

create or replace function admin_passengers(p_query text default '')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(p_query, '')));
begin
  if not is_platform_admin() then return not_admin(); end if;
  return coalesce((
    select jsonb_agg(row order by (row->>'last_activity') desc nulls last)
      from (
        select jsonb_build_object(
                 'wallet', p.public_key,
                 'email', u.email,
                 'user_id', a.user_id,
                 'balance', p.balance,
                 'overdraft', p.overdraft_npr,
                 'suspended', a.suspended_at is not null,
                 'registered_at', p.registered_at,
                 'last_activity', p.last_settled_at,
                 'pending_requests', (select count(*) from topup_requests r where r.wallet_public_key = p.public_key and r.status = 'pending')
               ) as row
          from passengers p
          left join passenger_accounts a on a.wallet_public_key = p.public_key
          left join auth.users u on u.id = a.user_id
         where p.public_key not in (select pseudonym_public_key from passenger_keys)
           and (v_q = '' or lower(coalesce(u.email, '')) like '%' || v_q || '%' or lower(p.public_key) like v_q || '%')
         order by p.last_settled_at desc nulls last
         limit 100
      ) s
  ), '[]'::jsonb);
end;
$$;

create or replace function admin_statement(p_wallet text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then return not_admin(); end if;
  return wallet_statement(p_wallet, 500);
end;
$$;

create or replace function admin_operators(p_query text default '')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(p_query, '')));
begin
  if not is_platform_admin() then return not_admin(); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', o.id,
             'name', o.name,
             'created_at', o.created_at,
             'suspended', o.suspended_at is not null,
             'logins', (select coalesce(jsonb_agg(u.email), '[]'::jsonb)
                          from operator_users ou join auth.users u on u.id = ou.user_id
                         where ou.operator_id = o.id),
             'buses', (select count(*) from vehicles v where v.operator_id = o.id),
             'fares_npr', (select coalesce(sum(l.amount), 0) from legs l join vehicles v on v.plate = l.vehicle_plate where v.operator_id = o.id)
                        + (select coalesce(sum(t.amount), 0) from transactions t join vehicles v on v.plate = t.vehicle_plate where v.operator_id = o.id)
           ) order by o.name)
      from operators o
     where v_q = ''
        or lower(o.name) like '%' || v_q || '%'
        or lower(o.id) like '%' || v_q || '%'
        or exists (select 1 from operator_users ou join auth.users u on u.id = ou.user_id
                    where ou.operator_id = o.id and lower(u.email) like '%' || v_q || '%')
  ), '[]'::jsonb);
end;
$$;

create or replace function admin_topup_requests(p_status text default 'pending')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then return not_admin(); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'email', u.email, 'wallet', r.wallet_public_key,
             'method', r.method, 'amount', r.amount, 'reference', r.reference,
             'status', r.status, 'note', r.note,
             'created_at', r.created_at, 'decided_at', r.decided_at,
             'balance', p.balance
           ) order by case when r.status = 'pending' then r.created_at end asc nulls last, r.decided_at desc)
      from topup_requests r
      join passengers p on p.public_key = r.wallet_public_key
      left join auth.users u on u.id = r.user_id
     where coalesce(p_status, 'all') = 'all' or r.status = p_status
  ), '[]'::jsonb);
end;
$$;

create or replace function admin_load_topup(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req    topup_requests%rowtype;
  v_credit jsonb;
begin
  if not is_platform_admin() then return not_admin(); end if;

  select * into v_req from topup_requests where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', v_req.status);
  end if;

  v_credit := credit_wallet(v_req.wallet_public_key, v_req.amount, v_req.method, v_req.reference);
  if not coalesce((v_credit->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', coalesce(v_credit->>'reason', 'credit_failed'));
  end if;

  update topup_requests
     set status = 'loaded', decided_at = now(), decided_by = auth.uid()
   where id = p_id;

  return jsonb_build_object('ok', true, 'id', p_id, 'balance', (v_credit->>'balance')::integer);
end;
$$;

create or replace function admin_reject_topup(p_id bigint, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req topup_requests%rowtype;
begin
  if not is_platform_admin() then return not_admin(); end if;
  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;
  select * into v_req from topup_requests where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', v_req.status);
  end if;
  update topup_requests
     set status = 'rejected', note = trim(p_reason), decided_at = now(), decided_by = auth.uid()
   where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

create or replace function admin_load_cash(p_wallet text, p_amount integer, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref    text;
  v_credit jsonb;
begin
  if not is_platform_admin() then return not_admin(); end if;
  if p_amount is null or p_amount < 10 or p_amount > 10000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;
  if not exists (select 1 from passengers where public_key = p_wallet) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_wallet');
  end if;
  v_ref := 'CASH-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  v_credit := credit_wallet(p_wallet, p_amount, 'cash', v_ref);
  update wallet_topups set note = nullif(trim(coalesce(p_note, '')), '')
   where source = 'cash' and reference = v_ref;
  return v_credit || jsonb_build_object('reference', v_ref);
end;
$$;

create or replace function admin_adjust_wallet(p_wallet text, p_amount integer, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance   integer;
  v_overdraft integer;
begin
  if not is_platform_admin() then return not_admin(); end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;
  if p_amount is null or p_amount = 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;

  select balance, overdraft_npr into v_balance, v_overdraft
    from passengers where public_key = p_wallet for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_wallet');
  end if;
  if v_balance + p_amount < -v_overdraft then
    return jsonb_build_object('ok', false, 'reason', 'below_floor', 'balance', v_balance, 'overdraft', v_overdraft);
  end if;

  insert into wallet_adjustments (wallet_public_key, amount, reason, created_by)
  values (p_wallet, p_amount, trim(p_reason), auth.uid());

  update passengers set balance = balance + p_amount
   where public_key = p_wallet
  returning balance into v_balance;

  return jsonb_build_object('ok', true, 'balance', v_balance);
end;
$$;

create or replace function admin_set_suspended(p_kind text, p_id text, p_suspended boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then return not_admin(); end if;
  if p_kind = 'operator' then
    update operators set suspended_at = case when p_suspended then coalesce(suspended_at, now()) end where id = p_id;
  elsif p_kind = 'passenger' then
    update passenger_accounts set suspended_at = case when p_suspended then coalesce(suspended_at, now()) end
     where wallet_public_key = p_id;
  else
    return jsonb_build_object('ok', false, 'reason', 'bad_kind');
  end if;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'suspended', p_suspended);
end;
$$;

create or replace function admin_set_setting(p_key text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then return not_admin(); end if;
  update platform_settings
     set value = coalesce(trim(p_value), ''), updated_at = now(), updated_by = auth.uid()
   where key = p_key;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_setting');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'admin_overview()', 'admin_passengers(text)', 'admin_statement(text)', 'admin_operators(text)',
    'admin_topup_requests(text)', 'admin_load_topup(bigint)', 'admin_reject_topup(bigint, text)',
    'admin_load_cash(text, integer, text)', 'admin_adjust_wallet(text, integer, text)',
    'admin_set_suspended(text, text, boolean)', 'admin_set_setting(text, text)'
  ] loop
    execute format('revoke all on function %s from anon, public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
