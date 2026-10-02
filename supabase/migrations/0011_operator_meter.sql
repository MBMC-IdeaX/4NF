-- The metered data, in front of the person who pays for the meter.
--
-- 0007 made legs and door_events readable by nobody but the sync function,
-- which kept them away from the public anon key — and also away from the owner
-- dashboard, which went on showing stage fares only. An owner could buy the
-- meter and never see a kilometre. This gives an operator read access to the
-- rides and door events of their own vehicles, through the same RLS pattern as
-- transactions in 0005, and two views the dashboard reads.

grant select on legs, door_events to authenticated;

drop policy if exists legs_own on legs;
create policy legs_own on legs
  for select to authenticated
  using (vehicle_plate in (select plate from vehicles where operator_id = current_operator_id()));

drop policy if exists door_events_own on door_events;
create policy door_events_own on door_events
  for select to authenticated
  using (vehicle_plate in (select plate from vehicles where operator_id = current_operator_id()));

/*
  What each bus earns per kilometre carried, day by day, and how much of it the
  meter can defend: `measured` rides were priced from the odometer, the rest
  from endpoints, stages, or the unclosed-ride cap. A route whose measured share
  falls is a route whose meter needs looking at.
*/
create or replace view operator_distance
with (security_invoker = true) as
  select vehicle_plate,
         date_trunc('day', alighted_at) as day,
         count(*)::int                                   as rides,
         round(sum(distance_m) / 1000.0, 1)              as passenger_km,
         sum(amount)::int                                as collected,
         round(sum(amount) / nullif(sum(distance_m) / 1000.0, 0), 2) as npr_per_km,
         round(avg(distance_m) / 1000.0, 2)              as mean_ride_km,
         count(*) filter (where distance_source = 'odometer')::int as measured,
         count(*) filter (where distance_source = 'unclosed')::int as unclosed
    from legs
   group by vehicle_plate, date_trunc('day', alighted_at);

-- Every time one of this operator's buses sat at its permit, refused a
-- boarding, or had its interlock overridden.
create or replace view operator_overloads
with (security_invoker = true) as
  select vehicle_plate, at, kind, door, onboard, capacity, note
    from door_events
   where kind in ('locked', 'refused', 'override_on');

-- Sync health now counts metered rides and the meter's own heartbeat, not only
-- stage fares: a bus running the meter would otherwise look silent.
create or replace view operator_vehicles
with (security_invoker = true) as
  select v.plate,
         v.route_id,
         (select count(*) from transactions t where t.vehicle_plate = v.plate)::int as lifetime_fares,
         (select coalesce(sum(amount), 0) from transactions t where t.vehicle_plate = v.plate)::int as lifetime_collected,
         greatest(
           (select max(settled_at) from transactions t where t.vehicle_plate = v.plate),
           (select max(settled_at) from legs l where l.vehicle_plate = v.plate),
           v.meter_seen_at
         ) as last_sync,
         (select count(*) from legs l where l.vehicle_plate = v.plate)::int as lifetime_rides_metered,
         v.capacity
    from vehicles v;

grant select on operator_distance, operator_overloads, operator_vehicles to authenticated;
