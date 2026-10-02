-- Days and hours in Kathmandu time, not UTC.
--
-- The dashboard views bucketed by the database's clock, which is UTC. Nepal is
-- UTC+5:45, so a fare taken at 13:45 in Kathmandu was charted at 08:00, a
-- morning fare at 10:15 fell at 04:00 and off the 05:00–22:00 service day
-- altogether, and anything after 18:15 was counted on the next day. Even an
-- hour boundary is wrong in UTC here, because of the 45 minutes.
--
-- Each view is recreated with only the bucketing changed. date_trunc with a
-- zone keeps timestamptz, so the columns keep their types. The DoTM views
-- (0015) already used Asia/Kathmandu.

create or replace view operator_daily
with (security_invoker = true) as
  select vehicle_plate,
         date_trunc('day', settled_at, 'Asia/Kathmandu') as day,
         count(*)::int    as passengers,
         sum(amount)::int as collected
    from transactions
   group by vehicle_plate, date_trunc('day', settled_at, 'Asia/Kathmandu');

create or replace view operator_hourly
with (security_invoker = true) as
  select vehicle_plate,
         extract(hour from coalesce(collected_at, settled_at) at time zone 'Asia/Kathmandu')::int as hour,
         count(*)::int    as passengers,
         sum(amount)::int as collected
    from transactions
   group by vehicle_plate, extract(hour from coalesce(collected_at, settled_at) at time zone 'Asia/Kathmandu');

create or replace view operator_distance
with (security_invoker = true) as
  select vehicle_plate,
         date_trunc('day', alighted_at, 'Asia/Kathmandu') as day,
         count(*)::int                                   as rides,
         round(sum(distance_m) / 1000.0, 1)              as passenger_km,
         sum(amount)::int                                as collected,
         round(sum(amount) / nullif(sum(distance_m) / 1000.0, 0), 2) as npr_per_km,
         round(avg(distance_m) / 1000.0, 2)              as mean_ride_km,
         count(*) filter (where distance_source = 'odometer')::int as measured,
         count(*) filter (where distance_source = 'unclosed')::int as unclosed
    from legs
   group by vehicle_plate, date_trunc('day', alighted_at, 'Asia/Kathmandu');

create or replace view leg_economics as
  select vehicle_plate,
         date_trunc('day', alighted_at, 'Asia/Kathmandu') as day,
         count(*)                                    as rides,
         sum(distance_m) / 1000.0                    as passenger_km,
         sum(amount)                                 as collected,
         round(sum(amount) / nullif(sum(distance_m) / 1000.0, 0), 2) as npr_per_passenger_km,
         round(avg(distance_m) / 1000.0, 2)          as mean_ride_km,
         count(*) filter (where distance_source = 'odometer') as measured,
         count(*) filter (where distance_source <> 'odometer') as estimated
    from legs
   group by vehicle_plate, date_trunc('day', alighted_at, 'Asia/Kathmandu');

create or replace view ridership_by_hour as
  select vehicle_plate,
         date_trunc('hour', collected_at, 'Asia/Kathmandu') as hour,
         count(*)      as passengers,
         sum(amount)   as collected
    from transactions
   where collected_at is not null
   group by vehicle_plate, date_trunc('hour', collected_at, 'Asia/Kathmandu');
