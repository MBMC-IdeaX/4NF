-- Is this receipt a description of a bus journey?
--
-- Everything the system checks is about consent and arithmetic: the passenger
-- signed the tap, the vehicle signed the receipt, the fare re-prices against the
-- published tariff. None of it asks whether the numbers describe the physical
-- world. An operator running a mock-location app on the meter phone produces
-- receipts that pass every one of those checks and bill everybody aboard for
-- kilometres nobody rode.
--
-- protocol/plausibility.mjs scores a settled leg against what a bus can actually
-- do — the distance against the time it claims to have taken, and where the
-- endpoints are when they are known. This is where the score lands.
--
-- Deliberately not a refusal. Every flag has an honest cause: a diversion, a
-- level crossing, a driver who took the ring road at midnight. Refusing a
-- settlement on a heuristic would mean a passenger's ride fails because their
-- bus was rerouted. So the money moves, the score is recorded, and an operator
-- sees the rate — because one implausible leg is a diversion and a trip where
-- most of them trip the same flag is a meter.

alter table legs add column if not exists plausibility text
  check (plausibility is null or plausibility in ('medium', 'high'));
alter table legs add column if not exists plausibility_flags jsonb;

create index if not exists legs_implausible on legs (vehicle_plate, alighted_at desc)
  where plausibility is not null;

/*
  Record a score against a settled leg.

  Separate from settle_leg() on purpose: this touches no money and must never be
  able to fail a settlement. A leg that settled and then could not be scored is
  a leg with no score, which is the correct outcome — the fare was owed either
  way.
*/
create or replace function flag_leg(
  p_leg_id       text,
  p_plausibility text,
  p_flags        jsonb
) returns jsonb
language plpgsql
as $$
begin
  update legs
     set plausibility = p_plausibility,
         plausibility_flags = p_flags
   where leg_id = p_leg_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_leg');
  end if;
  return jsonb_build_object('ok', true, 'legId', p_leg_id, 'plausibility', p_plausibility);
end;
$$;

/*
  The rate, per vehicle, which is the number that means something.

  A fleet owner reads this to find a box worth looking at, not a passenger worth
  accusing. The flag counts are broken out because the pattern is the evidence:
  every ride on one bus tripping `too_fast` is a meter; one ride in two hundred
  tripping it is a bus that got a clear run down the ring road.
*/
create or replace view meter_plausibility as
select
  vehicle_plate,
  count(*)                                                as legs,
  count(*) filter (where plausibility is not null)        as flagged,
  count(*) filter (where plausibility = 'high')           as flagged_high,
  round(
    100.0 * count(*) filter (where plausibility is not null) / nullif(count(*), 0),
    1
  )                                                       as flagged_pct,
  max(alighted_at) filter (where plausibility is not null) as last_flagged_at
from legs
group by vehicle_plate;

grant select on meter_plausibility to authenticated;
revoke all on function flag_leg(text, text, jsonb) from anon, authenticated, public;
