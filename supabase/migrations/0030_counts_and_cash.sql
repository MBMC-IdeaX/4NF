-- 0030: people who ride without tapping.
--
-- Two things a real Nepali bus needs on day one, and one rule that ties them
-- to the crew bonus.
--
-- 1. Cash riders. A passenger with no phone and no card pays the conductor in
--    cash, and the conductor records it as a CT1 cash ticket, signed by the
--    vehicle and priced by the published tariff (protocol/cash.mjs). No wallet
--    moves: the ticket is what the crew owes the owner for that ride.
--
-- 2. The door counter. A break-beam at the step counts bodies. The meter
--    reports the count per trip; a bus that has reported one is expected to
--    keep reporting (vehicles.door_counter), so unplugging it is not a way out.
--
-- 3. trip_evidence() now counts both, and cleanTripVerdict() in
--    protocol/crew.mjs judges them: a trip whose settled rides and cash tickets
--    cover less than 90% of the door count earns no bonus. The rule is not
--    restated here; this file only counts.

alter table vehicles add column if not exists door_counter boolean not null default false;
alter table trips add column if not exists counted_boardings integer check (counted_boardings >= 0);

create table if not exists cash_tickets (
  ticket_id      text primary key,
  vehicle_plate  text not null references vehicles(plate),
  trip_id        text,
  door           text,
  from_stop      text not null,
  to_stop        text not null,
  distance_m     integer not null check (distance_m >= 0),
  amount         integer not null check (amount >= 0),
  tariff_code    text not null,
  issued_at      timestamptz not null,
  ticket         text not null,
  recorded_at    timestamptz not null default now()
);

create index if not exists cash_tickets_trip on cash_tickets (trip_id);
create index if not exists cash_tickets_vehicle_time on cash_tickets (vehicle_plate, issued_at desc);

alter table cash_tickets enable row level security;

drop policy if exists cash_tickets_own on cash_tickets;
create policy cash_tickets_own on cash_tickets
  for select to authenticated
  using (vehicle_plate in (select plate from vehicles where operator_id = current_operator_id()));

revoke all on cash_tickets from anon;
grant select on cash_tickets to authenticated;

/*
  Record one cash ticket, once.

  The signature and the price were checked in settleBatch() before this is
  called. The primary key is the once-only rule: a door phone that uploads the
  same ticket twice is told `replay`, and the trip's cash is not counted twice.
*/
create or replace function record_cash_ticket(
  p_ticket_id     text,
  p_vehicle_plate text,
  p_trip_id       text,
  p_door          text,
  p_from_stop     text,
  p_to_stop       text,
  p_distance_m    integer,
  p_amount        integer,
  p_tariff_code   text,
  p_issued_at     timestamptz,
  p_ticket        text
) returns jsonb
language plpgsql
as $$
begin
  if p_trip_id is not null then
    insert into trips (id, vehicle_plate) values (p_trip_id, p_vehicle_plate)
    on conflict (id) do nothing;
  end if;
  insert into cash_tickets (ticket_id, vehicle_plate, trip_id, door, from_stop, to_stop,
                            distance_m, amount, tariff_code, issued_at, ticket)
  values (p_ticket_id, p_vehicle_plate, p_trip_id, p_door, p_from_stop, p_to_stop,
          p_distance_m, p_amount, p_tariff_code, p_issued_at, p_ticket);
  return jsonb_build_object('ok', true, 'ticketId', p_ticket_id, 'amount', p_amount);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'ticketId', p_ticket_id, 'reason', 'replay');
end;
$$;

/*
  The door count for one trip.

  The larger of what is on file and what arrived: a count only ever goes up
  within a trip, and a device that resends an older, smaller figure must not
  shrink it. The first count a bus ever reports marks it as having a counter.
*/
create or replace function record_trip_count(
  p_trip_id       text,
  p_vehicle_plate text,
  p_counted       integer
) returns jsonb
language plpgsql
as $$
begin
  if p_counted is null or p_counted < 0 then
    return jsonb_build_object('ok', false, 'tripId', p_trip_id, 'reason', 'unreadable');
  end if;
  insert into trips (id, vehicle_plate, counted_boardings)
  values (p_trip_id, p_vehicle_plate, p_counted)
  on conflict (id) do update
    set counted_boardings = greatest(coalesce(trips.counted_boardings, 0), excluded.counted_boardings);
  update vehicles set door_counter = true where plate = p_vehicle_plate and not door_counter;
  return jsonb_build_object('ok', true, 'tripId', p_trip_id, 'counted',
    (select counted_boardings from trips where id = p_trip_id));
end;
$$;

-- The evidence, now with the cash and the count. Judged in protocol/crew.mjs.
create or replace function trip_evidence(p_trip_id text)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'tripId', p_trip_id,
    'legs', (select count(*) from legs where trip_id = p_trip_id),
    'fares', (select coalesce(sum(amount), 0) from legs where trip_id = p_trip_id)
           + (select coalesce(sum(amount), 0) from cash_tickets where trip_id = p_trip_id),
    'cash', (select count(*) from cash_tickets where trip_id = p_trip_id),
    'cashNpr', (select coalesce(sum(amount), 0) from cash_tickets where trip_id = p_trip_id),
    'counted', (select counted_boardings from trips where id = p_trip_id),
    'counterExpected', coalesce((select v.door_counter from trips t join vehicles v on v.plate = t.vehicle_plate
                                  where t.id = p_trip_id), false),
    'implausible', (select count(*) from legs where trip_id = p_trip_id and plausibility = 'high'),
    'powerLost', (select count(*) from meter_events where trip_id = p_trip_id and kind = 'power_lost'),
    'overrides', (select count(*) from door_events where trip_id = p_trip_id and kind = 'override_on'),
    'crewPublicKey', (select crew_public_key from trips where id = p_trip_id),
    'vehiclePlate', (select vehicle_plate from trips where id = p_trip_id),
    'awarded', exists (select 1 from crew_bonuses where trip_id = p_trip_id)
  )
$$;

/*
  What the owner reads: per trip, the people the door counted against the
  people on the record, and the cash the crew owes.

  `unrecorded` is the number an owner has never had before — how many rode and
  paid nobody, or paid someone who kept it.
*/
create or replace view operator_trip_count
with (security_invoker = true) as
  select t.id                                           as trip_id,
         t.vehicle_plate,
         t.started_at,
         t.counted_boardings                            as counted,
         coalesce(l.rides, 0)::int                      as rides,
         coalesce(c.tickets, 0)::int                    as cash_tickets,
         coalesce(c.npr, 0)::int                        as cash_npr,
         case when t.counted_boardings is null then null
              else greatest(t.counted_boardings - coalesce(l.rides, 0) - coalesce(c.tickets, 0), 0)::int
         end                                            as unrecorded
    from trips t
    left join (select trip_id, count(*) as rides from legs group by trip_id) l on l.trip_id = t.id
    left join (select trip_id, count(*) as tickets, sum(amount) as npr from cash_tickets group by trip_id) c on c.trip_id = t.id
   where (t.counted_boardings is not null or c.tickets is not null)
     -- trips_own already limits an owner to their buses; stated again so the view
     -- stays scoped if that policy ever changes.
     and t.vehicle_plate in (select plate from vehicles where operator_id = current_operator_id());

revoke all on operator_trip_count from anon;
grant select on operator_trip_count to authenticated;

revoke all on function record_cash_ticket(text, text, text, text, text, text, integer, integer, text, timestamptz, text) from anon, authenticated, public;
revoke all on function record_trip_count(text, text, integer) from anon, authenticated, public;
revoke all on function trip_evidence(text) from anon, authenticated, public;
