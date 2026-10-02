-- Operator accounts and the dashboard's access path.
--
-- 0004 locked every money table away from the anon key, which is correct and
-- also means the operator dashboard cannot read anything. This adds the way
-- back in: a real Supabase Auth user, mapped to an operator, with RLS policies
-- that scope every row to the operator that owns the vehicle.
--
-- An operator sees their own buses and nobody else's. That is enforced in the
-- database, not in the dashboard's queries, so a bug in the front end cannot
-- leak another operator's revenue.

create table if not exists operator_users (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  operator_id  text not null references operators(id),
  display_name text,
  created_at   timestamptz not null default now()
);

alter table operator_users enable row level security;

-- A signed-in operator may read their own membership row and nothing else.
drop policy if exists operator_users_self on operator_users;
create policy operator_users_self on operator_users
  for select to authenticated
  using (user_id = auth.uid());

/*
  The operator this request belongs to. Marked stable so the planner calls it
  once per query rather than once per row, which matters on the transactions
  table.
*/
create or replace function current_operator_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select operator_id from operator_users where user_id = auth.uid()
$$;

grant execute on function current_operator_id() to authenticated;

-- ------------------------------------------------------- scoped read access

grant select on vehicles, trips, transactions to authenticated;
grant select, insert, update on vehicles to authenticated;

drop policy if exists vehicles_own on vehicles;
create policy vehicles_own on vehicles
  for select to authenticated
  using (operator_id = current_operator_id());

-- Registering a bus is the one thing an operator writes. They may only file it
-- under their own operator id.
drop policy if exists vehicles_insert_own on vehicles;
create policy vehicles_insert_own on vehicles
  for insert to authenticated
  with check (operator_id = current_operator_id());

drop policy if exists vehicles_update_own on vehicles;
create policy vehicles_update_own on vehicles
  for update to authenticated
  using (operator_id = current_operator_id())
  with check (operator_id = current_operator_id());

drop policy if exists trips_own on trips;
create policy trips_own on trips
  for select to authenticated
  using (vehicle_plate in (select plate from vehicles where operator_id = current_operator_id()));

drop policy if exists transactions_own on transactions;
create policy transactions_own on transactions
  for select to authenticated
  using (vehicle_plate in (select plate from vehicles where operator_id = current_operator_id()));

-- Operators may read the route reference data their buses run on.
grant select on operators to authenticated;
drop policy if exists operators_own on operators;
create policy operators_own on operators
  for select to authenticated
  using (id = current_operator_id());

-- ------------------------------------------------------------- concessions

/*
  A concession halves the fare, so who holds one is an operator decision, not a
  passenger one. The device carries a local copy for offline pricing, but this
  is the record that settles a dispute.

  Passengers are not exposed to the dashboard as a table — an operator has no
  business reading every wallet — so this is a narrow function instead.
*/
create or replace function set_concession(
  p_public_key text,
  p_concession text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_operator_id() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_an_operator');
  end if;
  if p_concession not in ('none', 'student', 'senior') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_concession');
  end if;

  update passengers set concession = p_concession where public_key = p_public_key;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_passenger');
  end if;
  return jsonb_build_object('ok', true, 'concession', p_concession);
end;
$$;

revoke all on function set_concession(text, text) from anon, public;
grant execute on function set_concession(text, text) to authenticated;

-- --------------------------------------------------------------- reporting

/*
  Dashboard aggregates. These are views over already-scoped tables, so an
  operator's RLS policy applies through them and no extra filtering is needed
  in the dashboard's queries.

  security_invoker makes the view run as the caller rather than its owner,
  which is what makes that true. Without it a view is a way around RLS.
*/
create or replace view operator_daily
with (security_invoker = true) as
  select vehicle_plate,
         date_trunc('day', settled_at) as day,
         count(*)::int    as passengers,
         sum(amount)::int as collected
    from transactions
   group by vehicle_plate, date_trunc('day', settled_at);

create or replace view operator_hourly
with (security_invoker = true) as
  select vehicle_plate,
         extract(hour from coalesce(collected_at, settled_at))::int as hour,
         count(*)::int    as passengers,
         sum(amount)::int as collected
    from transactions
   group by vehicle_plate, extract(hour from coalesce(collected_at, settled_at));

-- Which stop pairs actually carry people. This is the number no Nepali
-- operator currently has, and the reason the data product exists.
create or replace view operator_segments
with (security_invoker = true) as
  select boarding_stop,
         alighting_stop,
         count(*)::int    as passengers,
         sum(amount)::int as collected
    from transactions
   group by boarding_stop, alighting_stop;

create or replace view operator_trips
with (security_invoker = true) as
  select t.trip_id,
         t.vehicle_plate,
         count(*)::int    as passengers,
         sum(t.amount)::int as collected,
         min(t.collected_at) as started,
         max(t.collected_at) as ended,
         bool_and(t.settled_at is not null) as settled
    from transactions t
   group by t.trip_id, t.vehicle_plate;

-- Per-vehicle sync health: how long since this bus last reported anything.
create or replace view operator_vehicles
with (security_invoker = true) as
  select v.plate,
         v.route_id,
         (select count(*) from transactions t where t.vehicle_plate = v.plate)::int as lifetime_fares,
         (select coalesce(sum(amount), 0) from transactions t where t.vehicle_plate = v.plate)::int as lifetime_collected,
         (select max(settled_at) from transactions t where t.vehicle_plate = v.plate) as last_sync
    from vehicles v;

grant select on operator_daily, operator_hourly, operator_segments,
                operator_trips, operator_vehicles to authenticated;
