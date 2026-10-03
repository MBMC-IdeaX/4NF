-- Stable device event IDs make acknowledgement-loss retries safe.
alter table door_events add column event_id text;
alter table meter_events add column event_id text;
create unique index door_events_device_event on door_events(vehicle_plate, event_id);
create unique index meter_events_device_event on meter_events(vehicle_plate, event_id);

create or replace function append_door_events(p_vehicle_plate text, p_events jsonb) returns jsonb
language plpgsql as $$
declare v_written integer;
begin
  insert into door_events (vehicle_plate, event_id, trip_id, at, kind, door, onboard, capacity, note)
  select p_vehicle_plate, nullif(event->>'eventId', ''), nullif(event->>'tripId', ''),
    (event->>'at')::timestamptz, event->>'kind', event->>'door', (event->>'onboard')::integer, (event->>'capacity')::integer, nullif(event->>'note', '')
  from jsonb_array_elements(p_events) event

  on conflict (vehicle_plate, event_id) do nothing;
  get diagnostics v_written = row_count;
  return jsonb_build_object('ok', true, 'written', v_written);
end;
$$;
revoke all on function append_door_events(text, jsonb) from public, anon, authenticated;
grant execute on function append_door_events(text, jsonb) to service_role;

create or replace function append_meter_events(p_vehicle_plate text, p_events jsonb) returns jsonb
language plpgsql as $$
declare v_written integer;
begin
  insert into meter_events (vehicle_plate, event_id, trip_id, at, kind, moving, note)
  select p_vehicle_plate, nullif(event->>'eventId', ''), nullif(event->>'tripId', ''),
    (event->>'at')::timestamptz, event->>'kind', (event->>'moving')::boolean, nullif(event->>'note', '')
  from jsonb_array_elements(p_events) event
  where event->>'kind' in ('power_lost', 'power_restored')
  on conflict (vehicle_plate, event_id) do nothing;
  get diagnostics v_written = row_count;
  return jsonb_build_object('ok', true, 'written', v_written);
end;
$$;
revoke all on function append_meter_events(text, jsonb) from public, anon, authenticated;
grant execute on function append_meter_events(text, jsonb) to service_role;
