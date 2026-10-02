-- note_crew() called a first sign-on a replay.
--
-- The function inserted the trip row with the crew already on it, then read the
-- crew back to decide what had happened — and read its own insert. So the very
-- first sign-on for a trip answered `{ ok: true, reason: 'replay' }`, which is
-- true about nothing: there was no earlier sign-on to be a replay of.
--
-- Nothing broke, because every caller keys off `ok` and the row was correct
-- either way. But a verdict that names the wrong thing is a verdict somebody
-- eventually debugs against, and this one was found the first time the live
-- function was asked to sign a conductor on.
--
-- The fix is to let the insert say whether it was the one that wrote the row.

create or replace function note_crew(
  p_trip_id         text,
  p_vehicle_plate   text,
  p_crew_public_key text,
  p_signed_on_at    timestamptz,
  p_sign_on         text
) returns jsonb
language plpgsql
as $$
declare
  v_inserted boolean := false;
  v_existing text;
begin
  insert into trips (id, vehicle_plate, started_at, crew_public_key, crew_signed_on_at, crew_sign_on)
  values (p_trip_id, p_vehicle_plate, p_signed_on_at, p_crew_public_key, p_signed_on_at, p_sign_on)
  on conflict (id) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted then
    return jsonb_build_object('ok', true, 'tripId', p_trip_id, 'crew', p_crew_public_key);
  end if;

  select crew_public_key into v_existing from trips where id = p_trip_id;

  -- The trip already existed with nobody on it: a metered trip whose rides
  -- reached the backend before its crew's sign-on did, which is ordinary on a
  -- bus that finds signal halfway through.
  if v_existing is null then
    update trips
       set crew_public_key = p_crew_public_key,
           crew_signed_on_at = p_signed_on_at,
           crew_sign_on = p_sign_on
     where id = p_trip_id;
    return jsonb_build_object('ok', true, 'tripId', p_trip_id, 'crew', p_crew_public_key);
  end if;

  if v_existing = p_crew_public_key then
    return jsonb_build_object('ok', true, 'tripId', p_trip_id, 'crew', v_existing, 'reason', 'replay');
  end if;

  return jsonb_build_object('ok', false, 'tripId', p_trip_id, 'reason', 'crew_already_signed_on');
end;
$$;

revoke all on function note_crew(text, text, text, timestamptz, text) from anon, authenticated, public;
