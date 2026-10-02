-- Rides nobody closed, as a distance source of their own.
--
-- A passenger who never taps out is charged the route cap when the trip ends,
-- so that tapping out never becomes optional. Until now that receipt carried
-- the real odometer distance and a flat Rs 25, which the sync function then
-- re-priced from the distance, found not to match, and refused — the rule
-- could never actually settle. The receipt now says `unclosed`, the protocol
-- prices it by the unclosed rule (the cap, at the passenger's concession), and
-- this column accepts it. leg_economics already counts anything that is not
-- `odometer` as estimated, which is what an unclosed ride is.

alter table legs drop constraint if exists legs_distance_source_check;
alter table legs add constraint legs_distance_source_check
  check (distance_source in ('odometer', 'gps', 'stage', 'unclosed'));
