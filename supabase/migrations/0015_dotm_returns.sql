-- What the regulator asks for, computed rather than compiled.
--
-- The Department of Transport Management licenses a route and a capacity, and
-- an operator holding that permit has to be able to show what they did with it.
-- Today that is a person with a register and a pen, which means the number the
-- regulator sees is the number the operator chose to write down.
--
-- Bhada already holds the two things a return is made of: every ride with its
-- measured distance, and every door event with the occupancy at the moment it
-- fired. These views are those two, shaped the way a return is read — by
-- vehicle, by day — so an operator exports a period rather than assembling one.
--
-- Deliberately not a filing. Nothing here submits anything anywhere, and the
-- pilot has to be filed with DoTM under Section 153 before any of it is a legal
-- return rather than a spreadsheet. What it removes is the part where the
-- numbers are retyped.

/*
  The daily return, per vehicle.

  `passenger_km` is the figure the whole system exists to make defensible: the
  sum of measured ride distances, with the estimated ones counted separately so
  nobody has to take the total on faith. `overload_events` is the interlock tape
  reduced to the only question a regulator asks of it — how often was this bus
  over its permitted capacity, and how far over.
*/
create or replace view dotm_daily_return as
with rides as (
  select
    l.vehicle_plate,
    (l.alighted_at at time zone 'Asia/Kathmandu')::date as service_date,
    count(*)                                                    as rides,
    count(*) filter (where l.distance_source = 'odometer')       as rides_measured,
    count(*) filter (where l.distance_source <> 'odometer')      as rides_estimated,
    round(sum(l.distance_m) / 1000.0, 2)                         as passenger_km,
    round(sum(l.distance_m) filter (where l.distance_source = 'odometer') / 1000.0, 2) as passenger_km_measured,
    sum(l.amount)                                                as fare_npr,
    count(*) filter (where l.concession <> 'none')               as concession_rides,
    sum(l.amount) filter (where l.concession <> 'none')          as concession_npr
  from legs l
  group by 1, 2
),
doors as (
  select
    d.vehicle_plate,
    (d.at at time zone 'Asia/Kathmandu')::date as service_date,
    count(*) filter (where d.kind = 'locked')       as interlock_refusals,
    count(*) filter (where d.kind = 'override_on')  as override_events,
    max(d.onboard)                                  as peak_onboard,
    max(d.capacity)                                 as permitted_capacity,
    max(d.onboard) filter (where d.onboard > d.capacity) as peak_over_capacity
  from door_events d
  group by 1, 2
)
select
  coalesce(r.vehicle_plate, o.vehicle_plate)  as vehicle_plate,
  coalesce(r.service_date, o.service_date)    as service_date,
  v.route_id,
  coalesce(r.rides, 0)                        as rides,
  coalesce(r.rides_measured, 0)               as rides_measured,
  coalesce(r.rides_estimated, 0)              as rides_estimated,
  coalesce(r.passenger_km, 0)                 as passenger_km,
  coalesce(r.passenger_km_measured, 0)        as passenger_km_measured,
  coalesce(r.fare_npr, 0)                     as fare_npr,
  coalesce(r.concession_rides, 0)             as concession_rides,
  coalesce(r.concession_npr, 0)               as concession_npr,
  o.permitted_capacity,
  o.peak_onboard,
  o.peak_over_capacity,
  coalesce(o.interlock_refusals, 0)           as interlock_refusals,
  coalesce(o.override_events, 0)              as override_events
from rides r
full outer join doors o
  on o.vehicle_plate = r.vehicle_plate and o.service_date = r.service_date
left join vehicles v
  on v.plate = coalesce(r.vehicle_plate, o.vehicle_plate);

/*
  The overload register.

  One row per moment this vehicle carried more people than its permit allows,
  with what the crew did about it. This is the document that makes the interlock
  worth anything to a regulator: not a claim that the bus was never overloaded,
  but the vehicle's own sequence of events, including the overrides.

  An override is not misconduct. A crew overrides to get a bus off a junction or
  to let a conductor board, and the tape says when and how full — which is the
  difference between a note and an accusation.
*/
create or replace view dotm_overload_register as
select
  d.vehicle_plate,
  v.route_id,
  d.at,
  d.kind,
  d.door,
  d.onboard,
  d.capacity,
  greatest(0, coalesce(d.onboard, 0) - coalesce(d.capacity, 0)) as over_by,
  d.trip_id,
  d.note
from door_events d
left join vehicles v on v.plate = d.vehicle_plate
where d.kind in ('locked', 'override_on', 'tamper')
   or d.onboard > d.capacity
order by d.at desc;

grant select on dotm_daily_return, dotm_overload_register to authenticated;
