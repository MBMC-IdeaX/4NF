-- Bhada as software: what it charges, what a company and its bus owners are
-- owed, and how each is paid.
--
-- Bhada is not licensed by Nepal Rastra Bank to hold money (Payment and
-- Settlement Act 2075 §5, §36), so it does not. Rider money is held by a
-- licensed partner under a written agreement; Bhada keeps the ledger of who is
-- owed what and instructs the partner. A payout row is an instruction the
-- platform carries out with the partner and then marks paid, with the
-- partner's reference.
--
-- Who is owed. A company (the route-permit holder) may run buses of its own and
-- buses owned by members (0033, role bus_owner). Each is a separate party with
-- its own balance:
--
--   a bus owner   the fares their buses carried, less refunds, crew bonuses,
--                 the company's levy and their own payout fees
--   the company   the fares its own buses carried, less the same, plus the levy
--                 from every member bus, less Bhada's charges
--
-- The levy is the company's flat charge for each day a member's bus ran, as the
-- service agreement sets it, dated like every rate here so a past day keeps the
-- rate it ran under.
--
-- Bhada earns three ways, and never a commission on a fare:
--
--   app_monthly_per_bus  a monthly fee for every bus that ran that month,
--                        charged to the company
--   topup_flat           a flat fee on a rider's eSewa top-up, added to what
--                        eSewa charges (product_service_charge) and not credited
--   payout_flat          a flat fee on each payout, to whoever is paid
--
-- Rates are rows with an effective date, added and never edited, the same rule
-- as tariffs. Every Bhada rate starts at zero, so nothing is charged until the
-- platform admin sets one.

-- ------------------------------------------------------------------- rates

create table if not exists platform_fees (
  id             bigserial primary key,
  kind           text not null check (kind in ('app_monthly_per_bus', 'topup_flat', 'payout_flat')),
  amount_npr     integer not null check (amount_npr >= 0 and amount_npr <= 100000),
  effective_from timestamptz not null default now(),
  set_by         uuid,
  note           text,
  created_at     timestamptz not null default now()
);

create index if not exists platform_fees_kind on platform_fees (kind, effective_from desc);

alter table platform_fees enable row level security;
-- Public on purpose: a rider sees the top-up fee before paying it, an owner the
-- app fee before signing.
grant select on platform_fees to anon, authenticated;
drop policy if exists platform_fees_public on platform_fees;
create policy platform_fees_public on platform_fees for select to anon, authenticated using (true);

insert into platform_fees (kind, amount_npr, effective_from, note)
select kind, 0, '2026-01-01', 'Not charged until the platform admin sets a rate'
  from unnest(array['app_monthly_per_bus', 'topup_flat', 'payout_flat']) as kind
 where not exists (select 1 from platform_fees);

create or replace function fee_at(p_kind text, p_at timestamptz default now())
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select amount_npr from platform_fees
                    where kind = p_kind and effective_from <= p_at
                    order by effective_from desc, id desc limit 1), 0)
$$;

grant execute on function fee_at(text, timestamptz) to anon, authenticated;

-- The company's levy on a member's bus, per day it ran. Set from the service
-- agreement by Bhada staff; dated, never edited.
create table if not exists operator_levies (
  id             bigserial primary key,
  operator_id    text not null references operators(id),
  amount_npr     integer not null check (amount_npr >= 0 and amount_npr <= 100000),
  effective_from date not null,
  set_by         uuid,
  note           text,
  created_at     timestamptz not null default now()
);

create index if not exists operator_levies_operator on operator_levies (operator_id, effective_from desc);
alter table operator_levies enable row level security;

create or replace function levy_at(p_operator_id text, p_day date)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select amount_npr from operator_levies
                    where operator_id = p_operator_id and effective_from <= p_day
                    order by effective_from desc, id desc limit 1), 0)
$$;

revoke all on function levy_at(text, date) from anon, authenticated, public;

-- ----------------------------------------------------- charges and payouts

/*
  Charges against a party's payable: the monthly app fee (the company's), payout
  fees (whoever was paid), and adjustments Bhada makes by hand. `member_id` is
  null for the company itself.
*/
create table if not exists operator_charges (
  id          bigserial primary key,
  operator_id text not null references operators(id),
  member_id   uuid,
  kind        text not null check (kind in ('app_fee', 'payout_fee', 'adjustment')),
  amount_npr  integer not null,             -- positive is a charge; an adjustment may credit
  period      text,                          -- 'YYYY-MM' for an app fee
  detail      jsonb,
  created_by  uuid,
  at          timestamptz not null default now()
);

create unique index if not exists operator_charges_one_app_fee
  on operator_charges (operator_id, period) where kind = 'app_fee';
create index if not exists operator_charges_operator on operator_charges (operator_id, member_id, at desc);

alter table operator_charges enable row level security;

/*
  A payout: a party's instruction to the partner, carried out by the platform.
  The money and the fee are held back from the moment it is requested, so two
  requests can never both spend the same rupees.
*/
create table if not exists operator_payouts (
  id             uuid primary key default gen_random_uuid(),
  operator_id    text not null references operators(id),
  member_id      uuid,
  amount_npr     integer not null check (amount_npr > 0),
  fee_npr        integer not null default 0 check (fee_npr >= 0),
  method         text not null check (method in ('esewa', 'bank')),
  account_name   text not null,
  account_number text not null,
  bank_name      text,
  status         text not null default 'requested' check (status in ('requested', 'paid', 'rejected', 'cancelled')),
  requested_by   uuid,
  requested_at   timestamptz not null default now(),
  decided_by     uuid,
  decided_at     timestamptz,
  reference      text,
  note           text
);

-- One open request at a time per party.
create unique index if not exists operator_payouts_one_open
  on operator_payouts (operator_id, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'requested';
create index if not exists operator_payouts_operator on operator_payouts (operator_id, member_id, requested_at desc);

alter table operator_payouts enable row level security;

-- ----------------------------------------------------------- the payable

/*
  Every rupee a company's buses moved, each with the party it belongs to: the
  member who owned the bus when it moved (fare_party(), 0034), or null for the
  company. Kathmandu days.

    metered, stage  a ride or stage fare, on the day it was carried
    refunds         a refund on an upheld claim, owed by whoever owned the bus
                    on the ride, on the day it was paid
    bonuses         a clean-trip bonus (0025), on the day it was awarded
*/
create or replace function party_moves(p_operator_id text)
returns table (member_id uuid, vehicle_plate text, day date, kind text, amount bigint, n integer)
language sql
stable
security definer
set search_path = public
as $$
  select fare_party(l.vehicle_plate, l.alighted_at), l.vehicle_plate, (l.alighted_at at time zone 'Asia/Kathmandu')::date,
         'metered', l.amount::bigint, 1
    from legs l join vehicles v on v.plate = l.vehicle_plate where v.operator_id = p_operator_id
  union all
  select fare_party(t.vehicle_plate, t.issued_at), t.vehicle_plate, (t.issued_at at time zone 'Asia/Kathmandu')::date,
         'stage', t.amount::bigint, 1
    from transactions t join vehicles v on v.plate = t.vehicle_plate where v.operator_id = p_operator_id
  union all
  select fare_party(d.vehicle_plate, l.alighted_at), d.vehicle_plate, (d.filed_at at time zone 'Asia/Kathmandu')::date,
         'refunds', d.refund_npr::bigint, 0
    from leg_disputes d join legs l on l.leg_id = d.leg_id join vehicles v on v.plate = d.vehicle_plate
   where v.operator_id = p_operator_id and d.refund_npr > 0
  union all
  select fare_party(b.vehicle_plate, b.awarded_at), b.vehicle_plate, (b.awarded_at at time zone 'Asia/Kathmandu')::date,
         'bonuses', b.amount::bigint, 0
    from crew_bonuses b join vehicles v on v.plate = b.vehicle_plate
   where v.operator_id = p_operator_id and b.outcome = 'paid'
$$;

revoke all on function party_moves(text) from anon, authenticated, public;

-- Each day each bus ran, and whose bus it was that day.
create or replace function bus_days(p_operator_id text)
returns table (vehicle_plate text, owner_member uuid, day date)
language sql
stable
security definer
set search_path = public
as $$
  select distinct m.vehicle_plate, m.member_id, m.day
    from party_moves(p_operator_id) m
   where m.kind in ('metered', 'stage')
$$;

revoke all on function bus_days(text) from anon, authenticated, public;

/*
  What one party has earned and may withdraw. `p_member` null is the company.

    fares      every metered ride and stage fare carried while the bus was theirs
             − refunds paid to riders on upheld claims against those rides
             − clean-trip bonuses paid to its crews (0025)
    levy       a bus owner pays it for each day their bus ran; the company
               receives it from every member bus
    charges    app fees, payout fees and adjustments on this party
    paid_out   payouts the partner has made to this party
    held       its open request and that request's fee
    available  fares − refunds − bonuses ∓ levy − charges − paid_out − held

  Cash tickets are not in it: the conductor already holds that cash.
*/
create or replace function party_payable(p_operator_id text, p_member uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with moves as (select * from party_moves(p_operator_id) where member_id is not distinct from p_member),
  days as (select * from bus_days(p_operator_id)),
  sums as (
    select
      (select coalesce(sum(amount), 0) from moves where kind = 'metered')::bigint as metered,
      (select coalesce(sum(amount), 0) from moves where kind = 'stage')::bigint as stage,
      (select coalesce(sum(amount), 0) from moves where kind = 'refunds')::bigint as refunds,
      (select coalesce(sum(amount), 0) from moves where kind = 'bonuses')::bigint as bonuses,
      (case when p_member is null
            then (select coalesce(sum(levy_at(p_operator_id, day)), 0) from days where owner_member is not null)
            else -(select coalesce(sum(levy_at(p_operator_id, day)), 0) from days where owner_member = p_member) end)::bigint as levy,
      (select coalesce(sum(amount_npr), 0) from operator_charges where operator_id = p_operator_id and member_id is not distinct from p_member)::bigint as charges,
      (select coalesce(sum(amount_npr), 0) from operator_payouts where operator_id = p_operator_id and member_id is not distinct from p_member and status = 'paid')::bigint as paid_out,
      (select coalesce(sum(amount_npr + fee_npr), 0) from operator_payouts where operator_id = p_operator_id and member_id is not distinct from p_member and status = 'requested')::bigint as held
  )
  select jsonb_build_object(
    'metered', metered, 'stage', stage, 'refunds', refunds, 'bonuses', bonuses,
    -- Positive for the company (received), negative for a bus owner (paid).
    'levy', levy,
    'earned', metered + stage - refunds - bonuses + levy,
    'charges', charges,
    'paid_out', paid_out,
    'held', held,
    'available', metered + stage - refunds - bonuses + levy - charges - paid_out - held
  )
  from sums
$$;

revoke all on function party_payable(text, uuid) from anon, authenticated, public;

/*
  Which party the caller is: the company (its owner) or themselves (a bus
  owner). Managers and conductors handle no money.
*/
create or replace function caller_party()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case (current_member() ->> 'role')
    when 'owner' then jsonb_build_object('operator_id', current_member() ->> 'operator_id', 'member', null)
    when 'bus_owner' then jsonb_build_object('operator_id', current_member() ->> 'operator_id', 'member', auth.uid())
  end
$$;

revoke all on function caller_party() from anon, public;

create or replace function owner_money()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_party    jsonb := caller_party();
  v_operator text;
  v_member   uuid;
begin
  if v_party is null then
    return jsonb_build_object('ok', false, 'reason', case when current_member() is null then 'not_operator' else 'owner_only' end);
  end if;
  v_operator := v_party ->> 'operator_id';
  v_member := (v_party ->> 'member')::uuid;
  return jsonb_build_object(
    'ok', true,
    'party', case when v_member is null then 'company' else 'bus_owner' end,
    'live', coalesce((select onboarding_status = 'live' from operators where id = v_operator), false),
    'payable', party_payable(v_operator, v_member),
    'levy_per_day', levy_at(v_operator, (now() at time zone 'Asia/Kathmandu')::date),
    'fees', jsonb_build_object(
      'app_monthly_per_bus', fee_at('app_monthly_per_bus'),
      'payout_flat', fee_at('payout_flat'),
      'topup_flat', fee_at('topup_flat')
    ),
    'payouts', coalesce((
      select jsonb_agg(to_jsonb(p) - 'operator_id' - 'member_id' - 'requested_by' - 'decided_by' order by p.requested_at desc)
        from (select * from operator_payouts where operator_id = v_operator and member_id is not distinct from v_member
               order by requested_at desc limit 30) p), '[]'::jsonb),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'amount', c.amount_npr, 'period', c.period,
                                          'detail', c.detail, 'at', c.at) order by c.at desc)
        from (select * from operator_charges where operator_id = v_operator and member_id is not distinct from v_member
               order by at desc limit 30) c), '[]'::jsonb),
    -- The company sees what each member's buses earned it, so the levy is open.
    'members', case when v_member is null then coalesce((
      select jsonb_agg(jsonb_build_object('user_id', ou.user_id, 'name', ou.display_name,
               'buses', (select coalesce(jsonb_agg(v.plate order by v.plate), '[]'::jsonb) from vehicles v where v.owner_member = ou.user_id),
               'levy', (select coalesce(sum(levy_at(v_operator, d.day)), 0) from bus_days(v_operator) d where d.owner_member = ou.user_id))
             order by ou.display_name)
        from operator_users ou where ou.operator_id = v_operator and ou.role = 'bus_owner'), '[]'::jsonb) end
  );
end;
$$;

/*
  The statement, one row per Kathmandu day for the caller's party: what its
  buses carried, the levy, what went back to riders and crews, what Bhada
  charged and what was paid out. Days with nothing are left out. At most 92
  days per call.
*/
create or replace function owner_statement(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_party    jsonb := caller_party();
  v_operator text;
  v_member   uuid;
begin
  if v_party is null then
    return jsonb_build_object('ok', false, 'reason', case when current_member() is null then 'not_operator' else 'owner_only' end);
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then
    return jsonb_build_object('ok', false, 'reason', 'bad_range');
  end if;
  v_operator := v_party ->> 'operator_id';
  v_member := (v_party ->> 'member')::uuid;
  return jsonb_build_object('ok', true, 'days', coalesce((
    with moves as (
      select day, kind, amount, n from party_moves(v_operator) where member_id is not distinct from v_member
      union all
      -- The levy: received by the company from member buses, paid by a member.
      select d.day, 'levy', (case when v_member is null then 1 else -1 end) * levy_at(v_operator, d.day), 0
        from bus_days(v_operator) d
       where (v_member is null and d.owner_member is not null) or d.owner_member = v_member
      union all
      select (at at time zone 'Asia/Kathmandu')::date, 'charges', amount_npr, 0
        from operator_charges where operator_id = v_operator and member_id is not distinct from v_member
      union all
      select (decided_at at time zone 'Asia/Kathmandu')::date, 'payouts', amount_npr, 0
        from operator_payouts where operator_id = v_operator and member_id is not distinct from v_member and status = 'paid'
    )
    select jsonb_agg(to_jsonb(d) order by d.day desc)
      from (
        select day,
               coalesce(sum(n) filter (where kind in ('metered', 'stage')), 0) as rides,
               coalesce(sum(amount) filter (where kind = 'metered'), 0) as metered,
               coalesce(sum(amount) filter (where kind = 'stage'), 0) as stage,
               coalesce(sum(amount) filter (where kind = 'refunds'), 0) as refunds,
               coalesce(sum(amount) filter (where kind = 'bonuses'), 0) as bonuses,
               coalesce(sum(amount) filter (where kind = 'levy'), 0) as levy,
               coalesce(sum(amount) filter (where kind = 'charges'), 0) as charges,
               coalesce(sum(amount) filter (where kind = 'payouts'), 0) as payouts,
               coalesce(sum(amount) filter (where kind in ('metered', 'stage', 'levy')), 0)
                 - coalesce(sum(amount) filter (where kind in ('refunds', 'bonuses', 'charges')), 0) as net
          from moves
         where day between p_from and p_to
         group by day
      ) d
  ), '[]'::jsonb));
end;
$$;

create or replace function request_payout(
  p_amount         integer,
  p_method         text,
  p_account_name   text,
  p_account_number text,
  p_bank_name      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_party    jsonb := caller_party();
  v_operator text;
  v_member   uuid;
  v_fee      integer := fee_at('payout_flat');
  v_number   text := regexp_replace(coalesce(p_account_number, ''), '[\s-]', '', 'g');
  v_avail    bigint;
  v_id       uuid;
begin
  if v_party is null then
    return jsonb_build_object('ok', false, 'reason', case when current_member() is null then 'not_operator' else 'owner_only' end);
  end if;
  v_operator := v_party ->> 'operator_id';
  v_member := (v_party ->> 'member')::uuid;
  -- Money moves only for a company Bhada has onboarded: agreements signed,
  -- papers checked (0038). Fares settle either way.
  if not exists (select 1 from operators where id = v_operator and onboarding_status = 'live') then
    return jsonb_build_object('ok', false, 'reason', 'not_live');
  end if;
  if p_method not in ('esewa', 'bank') then return jsonb_build_object('ok', false, 'reason', 'bad_method'); end if;
  if p_amount is null or p_amount < 100 or p_amount > 5000000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;
  if coalesce(trim(p_account_name), '') = '' then return jsonb_build_object('ok', false, 'reason', 'name_required'); end if;
  if p_method = 'esewa' and v_number !~ '^9[78][0-9]{8}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_esewa_id');
  end if;
  if p_method = 'bank' and (v_number !~ '^[0-9A-Za-z]{6,24}$' or coalesce(trim(p_bank_name), '') = '') then
    return jsonb_build_object('ok', false, 'reason', 'bad_bank_account');
  end if;

  -- The row lock makes the check and the insert one step, so two taps cannot
  -- both pass the balance check.
  perform 1 from operators where id = v_operator for update;
  if exists (select 1 from operator_payouts where operator_id = v_operator and member_id is not distinct from v_member and status = 'requested') then
    return jsonb_build_object('ok', false, 'reason', 'request_open');
  end if;
  v_avail := (party_payable(v_operator, v_member) ->> 'available')::bigint;
  if p_amount + v_fee > v_avail then
    return jsonb_build_object('ok', false, 'reason', 'insufficient', 'available', v_avail, 'fee', v_fee);
  end if;

  insert into operator_payouts (operator_id, member_id, amount_npr, fee_npr, method, account_name, account_number, bank_name, requested_by)
  values (v_operator, v_member, p_amount, v_fee, p_method, trim(p_account_name), v_number, nullif(trim(p_bank_name), ''), auth.uid())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'amount', p_amount, 'fee', v_fee);
end;
$$;

create or replace function cancel_payout(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_party jsonb := caller_party();
  v_count integer;
begin
  if v_party is null then return jsonb_build_object('ok', false, 'reason', 'owner_only'); end if;
  update operator_payouts set status = 'cancelled', decided_at = now(), decided_by = auth.uid()
   where id = p_id and operator_id = v_party ->> 'operator_id'
     and member_id is not distinct from (v_party ->> 'member')::uuid and status = 'requested';
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', v_count = 1, 'reason', case when v_count = 1 then null else 'not_open' end);
end;
$$;

-- -------------------------------------------------------------- the admin

create or replace function admin_fees()
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
    'now', jsonb_build_object(
      'app_monthly_per_bus', fee_at('app_monthly_per_bus'),
      'topup_flat', fee_at('topup_flat'),
      'payout_flat', fee_at('payout_flat')),
    'history', coalesce((select jsonb_agg(to_jsonb(f) order by f.effective_from desc, f.id desc) from platform_fees f), '[]'::jsonb),
    'revenue', jsonb_build_object(
      'app_fees', (select coalesce(sum(amount_npr), 0) from operator_charges where kind = 'app_fee'),
      'payout_fees', (select coalesce(sum(amount_npr), 0) from operator_charges where kind = 'payout_fee'),
      'topup_fees', (select coalesce(sum(fee_npr), 0) from topup_requests where status = 'loaded'))
  );
end;
$$;

-- A new rate from now or later. Never backdated: a charge already made keeps
-- the rate it was made at.
create or replace function admin_set_fee(p_kind text, p_amount integer, p_effective_from timestamptz default now(), p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then return not_admin(); end if;
  if p_kind not in ('app_monthly_per_bus', 'topup_flat', 'payout_flat') then
    return jsonb_build_object('ok', false, 'reason', 'bad_kind');
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 100000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;
  if p_effective_from < now() - interval '1 minute' then
    return jsonb_build_object('ok', false, 'reason', 'backdated');
  end if;
  insert into platform_fees (kind, amount_npr, effective_from, set_by, note)
  values (p_kind, p_amount, p_effective_from, auth.uid(), nullif(trim(p_note), ''));
  return jsonb_build_object('ok', true);
end;
$$;

-- The levy from the service agreement, from a day on. Never backdated.
create or replace function admin_set_levy(p_operator_id text, p_amount integer, p_effective_from date default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from date := coalesce(p_effective_from, (now() at time zone 'Asia/Kathmandu')::date);
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  if not exists (select 1 from operators where id = p_operator_id) then return jsonb_build_object('ok', false, 'reason', 'unknown_operator'); end if;
  if p_amount is null or p_amount < 0 or p_amount > 100000 then return jsonb_build_object('ok', false, 'reason', 'bad_amount'); end if;
  if v_from < (now() at time zone 'Asia/Kathmandu')::date then return jsonb_build_object('ok', false, 'reason', 'backdated'); end if;
  insert into operator_levies (operator_id, amount_npr, effective_from, set_by, note)
  values (p_operator_id, p_amount, v_from, auth.uid(), nullif(trim(p_note), ''));
  return jsonb_build_object('ok', true);
end;
$$;

/*
  Bill one finished month's app fee to each company.

  A bus is billed for a month if it carried at least one ride or stage fare in
  that month, Kathmandu time; an idle bus costs nothing. Priced at the rate in
  force on the first of the month. Running it twice bills once.
*/
create or replace function admin_bill_month(p_month text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start  timestamptz;
  v_end    timestamptz;
  v_rate   integer;
  v_billed integer := 0;
  v_total  bigint := 0;
  r        record;
begin
  if not is_platform_admin() then return not_admin(); end if;
  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then return jsonb_build_object('ok', false, 'reason', 'bad_month'); end if;
  v_start := (p_month || '-01')::timestamp at time zone 'Asia/Kathmandu';
  v_end := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Kathmandu';
  if v_end > now() then return jsonb_build_object('ok', false, 'reason', 'month_not_over'); end if;
  v_rate := fee_at('app_monthly_per_bus', v_start);

  for r in
    select v.operator_id, array_agg(distinct v.plate order by v.plate) as plates
      from vehicles v
     where exists (select 1 from legs l where l.vehicle_plate = v.plate and l.alighted_at >= v_start and l.alighted_at < v_end)
        or exists (select 1 from transactions t where t.vehicle_plate = v.plate and t.issued_at >= v_start and t.issued_at < v_end)
     group by v.operator_id
  loop
    insert into operator_charges (operator_id, kind, amount_npr, period, detail, created_by)
    values (r.operator_id, 'app_fee', v_rate * cardinality(r.plates), p_month,
            jsonb_build_object('buses', r.plates, 'rate', v_rate), auth.uid())
    on conflict (operator_id, period) where kind = 'app_fee' do nothing;
    if found then
      v_billed := v_billed + 1;
      v_total := v_total + v_rate * cardinality(r.plates);
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'month', p_month, 'rate', v_rate, 'companies', v_billed, 'total', v_total);
end;
$$;

create or replace function admin_payouts(p_status text default 'requested')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then return not_admin(); end if;
  return coalesce((
    select jsonb_agg(to_jsonb(p) || jsonb_build_object(
             'operator_name', o.name,
             'member_name', (select ou.display_name from operator_users ou where ou.user_id = p.member_id),
             'available', (party_payable(p.operator_id, p.member_id) ->> 'available')::bigint)
           order by p.requested_at)
      from operator_payouts p join operators o on o.id = p.operator_id
     where p_status is null or p.status = p_status), '[]'::jsonb);
end;
$$;

/*
  The platform carried out (or refused) a payout with the partner. Paid needs
  the partner's reference, so every rupee out can be matched to a statement.
*/
create or replace function admin_decide_payout(p_id uuid, p_decision text, p_reference text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout operator_payouts;
begin
  if not is_platform_admin() then return not_admin(); end if;
  if p_decision not in ('paid', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'bad_decision'); end if;
  select * into v_payout from operator_payouts where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_payout.status <> 'requested' then return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', v_payout.status); end if;
  if p_decision = 'paid' and coalesce(trim(p_reference), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'reference_required');
  end if;
  if p_decision = 'rejected' and coalesce(trim(p_note), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'note_required');
  end if;

  update operator_payouts
     set status = p_decision, decided_by = auth.uid(), decided_at = now(),
         reference = nullif(trim(p_reference), ''), note = nullif(trim(p_note), '')
   where id = p_id;
  if p_decision = 'paid' and v_payout.fee_npr > 0 then
    insert into operator_charges (operator_id, member_id, kind, amount_npr, detail, created_by)
    values (v_payout.operator_id, v_payout.member_id, 'payout_fee', v_payout.fee_npr, jsonb_build_object('payout', p_id), auth.uid());
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- An adjustment by hand, with a reason: a credit for a fault, a correction.
create or replace function admin_adjust_operator(p_operator_id text, p_amount integer, p_reason text, p_member uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then return not_admin(); end if;
  if not exists (select 1 from operators where id = p_operator_id) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000000 then return jsonb_build_object('ok', false, 'reason', 'bad_amount'); end if;
  if length(coalesce(trim(p_reason), '')) < 4 then return jsonb_build_object('ok', false, 'reason', 'reason_required'); end if;
  insert into operator_charges (operator_id, member_id, kind, amount_npr, detail, created_by)
  values (p_operator_id, p_member, 'adjustment', p_amount, jsonb_build_object('reason', trim(p_reason)), auth.uid());
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function owner_money() from anon, public;
revoke all on function owner_statement(date, date) from anon, public;
revoke all on function request_payout(integer, text, text, text, text) from anon, public;
revoke all on function cancel_payout(uuid) from anon, public;
revoke all on function admin_fees() from anon, public;
revoke all on function admin_set_fee(text, integer, timestamptz, text) from anon, public;
revoke all on function admin_set_levy(text, integer, date, text) from anon, public;
revoke all on function admin_bill_month(text) from anon, public;
revoke all on function admin_payouts(text) from anon, public;
revoke all on function admin_decide_payout(uuid, text, text, text) from anon, public;
revoke all on function admin_adjust_operator(text, integer, text, uuid) from anon, public;

grant execute on function owner_money() to authenticated;
grant execute on function owner_statement(date, date) to authenticated;
grant execute on function request_payout(integer, text, text, text, text) to authenticated;
grant execute on function cancel_payout(uuid) to authenticated;
grant execute on function admin_fees() to authenticated;
grant execute on function admin_set_fee(text, integer, timestamptz, text) to authenticated;
grant execute on function admin_set_levy(text, integer, date, text) to authenticated;
grant execute on function admin_bill_month(text) to authenticated;
grant execute on function admin_payouts(text) to authenticated;
grant execute on function admin_decide_payout(uuid, text, text, text) to authenticated;
grant execute on function admin_adjust_operator(text, integer, text, uuid) to authenticated;

-- ------------------------------------------------------ the top-up fee

alter table topup_requests add column if not exists fee_npr integer not null default 0;

create or replace function gateway_open_topup(p_user_id uuid, p_method text, p_amount integer)
returns jsonb
language plpgsql
as $$
declare
  v_account passenger_accounts%rowtype;
  v_ref     text;
  v_id      bigint;
  v_fee     integer := fee_at('topup_flat');
begin
  select * into v_account from passenger_accounts where user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_linked');
  end if;
  if v_account.suspended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'suspended');
  end if;
  if p_method is distinct from 'esewa' then
    return jsonb_build_object('ok', false, 'reason', 'bad_method');
  end if;
  if p_amount is null or p_amount < 10 or p_amount > 10000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;
  -- Abandoned attempts no longer count against the five.
  perform expire_gateway_topups(p_user_id);
  if (select count(*) from topup_requests
       where user_id = p_user_id and status = 'initiated'
         and created_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_pending');
  end if;

  v_ref := 'BH-' || to_char(now() at time zone 'Asia/Kathmandu', 'YYMMDD') || '-'
        || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  -- The fee is fixed into the request when it opens: a rate changed while the
  -- rider is on eSewa's page does not change what they agreed to pay.
  insert into topup_requests (user_id, wallet_public_key, method, amount, fee_npr, reference, status, channel)
  values (p_user_id, v_account.wallet_public_key, p_method, p_amount, v_fee, v_ref, 'initiated', 'gateway')
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'reference', v_ref, 'amount', p_amount,
                            'fee', v_fee, 'total', p_amount + v_fee, 'method', p_method);
end;
$$;

create or replace function gateway_request_for(p_user_id uuid, p_reference text)
returns jsonb
language sql
stable
as $$
  select coalesce((
    select jsonb_build_object('id', id, 'method', method, 'amount', amount, 'fee', fee_npr, 'total', amount + fee_npr,
                              'reference', reference, 'status', status, 'provider_ref', provider_ref)
      from topup_requests
     where user_id = p_user_id and reference = p_reference
  ), jsonb_build_object('ok', false, 'reason', 'not_found'))
$$;

/*
  `p_amount` is what eSewa says it collected: the top-up and its fee together.
  The wallet is credited the top-up only; the fee stays on the request as the
  platform's.
*/
create or replace function gateway_complete_topup(p_reference text, p_method text, p_amount integer, p_provider_ref text)
returns jsonb
language plpgsql
as $$
declare
  v_req    topup_requests%rowtype;
  v_credit jsonb;
begin
  select * into v_req from topup_requests
   where reference = p_reference and method = p_method and channel = 'gateway'
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_req.status = 'loaded' then
    return jsonb_build_object('ok', true, 'already', true, 'id', v_req.id,
      'balance', (select balance from passengers where public_key = v_req.wallet_public_key));
  end if;
  -- Expired for lack of news is not the same as cancelled: eSewa's word that
  -- it was paid still counts.
  if v_req.status <> 'initiated'
     and not (v_req.status = 'failed' and v_req.note = 'Not paid within 15 minutes') then
    return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', v_req.status);
  end if;
  if p_amount <> v_req.amount + v_req.fee_npr then
    update topup_requests
       set status = 'pending', provider_ref = p_provider_ref, decided_at = null,
           note = format('Gateway reported Rs %s against Rs %s asked (Rs %s and a Rs %s fee). Check before loading.',
                         p_amount, v_req.amount + v_req.fee_npr, v_req.amount, v_req.fee_npr)
     where id = v_req.id;
    return jsonb_build_object('ok', false, 'reason', 'amount_mismatch');
  end if;

  v_credit := credit_wallet(v_req.wallet_public_key, v_req.amount, v_req.method, v_req.reference);
  if not coalesce((v_credit->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', coalesce(v_credit->>'reason', 'credit_failed'));
  end if;
  update wallet_topups set note = nullif(p_provider_ref, '')
   where source = v_req.method and reference = v_req.reference;

  update topup_requests
     set status = 'loaded', provider_ref = p_provider_ref, note = null, decided_at = now()
   where id = v_req.id;

  return jsonb_build_object('ok', true, 'id', v_req.id, 'balance', (v_credit->>'balance')::integer);
end;
$$;


-- The gateway functions stay with the payments function's service role.
revoke all on function gateway_open_topup(uuid, text, integer) from anon, authenticated, public;
revoke all on function gateway_request_for(uuid, text) from anon, authenticated, public;
revoke all on function gateway_complete_topup(text, text, integer, text) from anon, authenticated, public;
