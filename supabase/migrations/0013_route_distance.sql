-- Distance measured along the published route.
--
-- When the odometer cannot supply a figure — multipath under the Baneshwor
-- flyover, a minute of lost fixes in the lanes at Ason — the leg used to be
-- priced at the straight line between the endpoints times a circuity factor of
-- 1.3. That guess is wrong in both directions: short across a tortuous heritage
-- lane, long on a stretch that happens to run straight.
--
-- The bus was not driving an unknown road, it was driving its route, and the
-- route's chainage is a published fact. `route` is a ride placed on that
-- geometry and measured along it. It is still an estimate — the endpoints are
-- fixes, not tap readings — and leg_economics already counts anything that is
-- not `odometer` as estimated, which is exactly right for it.

alter table legs drop constraint if exists legs_distance_source_check;
alter table legs add constraint legs_distance_source_check
  check (distance_source in ('odometer', 'route', 'gps', 'stage', 'unclosed'));
