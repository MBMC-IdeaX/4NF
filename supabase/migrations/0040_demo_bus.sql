-- A demo bus that is not a real bus.
--
-- The Crew app's "demo bus" used to be BA2KHA4412, a real plate: a phone
-- running the demo on the live site would register its key for that bus. The
-- demo now runs as DEMOBUS01, owned by a demo company that is not a real
-- operator, and marked is_demo.
--
-- A real bus binds the first phone set up for it and refuses every other key
-- (register_meter, 0034). A demo bus is shared by whoever is giving a demo, so
-- it takes the key of the latest phone that checks in. Its rides settle like
-- any other; nothing about a real bus changes.

alter table vehicles add column if not exists is_demo boolean not null default false;

insert into operators (id, name)
values ('BHADA-DEMO', 'Bhada demo (not a real company)')
on conflict (id) do nothing;

insert into vehicles (plate, operator_id, route_id, seated, standing, capacity, label, is_demo)
values ('DEMOBUS01', 'BHADA-DEMO', 'R11', 30, 12, 42, 'Demo bus — Ratna Park ↔ Koteshwor', true)
on conflict (plate) do update set is_demo = true;

create or replace function register_meter(
  p_vehicle_plate text,
  p_public_key    text,
  p_capacity      integer default null,
  p_firmware      text default null,
  p_enrol_code    text default null
) returns jsonb
language plpgsql
as $$
declare
  v_bus       vehicles;
  v_enrolment vehicle_enrolments;
begin
  select * into v_bus from vehicles where plate = p_vehicle_plate for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle');
  end if;

  -- The demo bus follows whichever phone is giving the demo.
  if v_bus.is_demo then
    update vehicles
       set public_key = p_public_key,
           capacity = coalesce(p_capacity, capacity),
           meter_firmware = coalesce(p_firmware, meter_firmware),
           meter_seen_at = now()
     where plate = p_vehicle_plate;
    return jsonb_build_object('ok', true, 'reason', case when v_bus.public_key = p_public_key then 'seen' else 'registered' end, 'demo', true);
  end if;

  if v_bus.retired_at is not null and v_bus.enrol_required then
    return jsonb_build_object('ok', false, 'reason', 'retired');
  end if;

  if v_bus.public_key is null then
    if v_bus.enrol_required then
      select * into v_enrolment from vehicle_enrolments where vehicle_plate = p_vehicle_plate;
      if not found or p_enrol_code is null or invite_hash(p_enrol_code) <> v_enrolment.code_hash then
        return jsonb_build_object('ok', false, 'reason', 'setup_required');
      end if;
      if v_enrolment.expires_at < now() then
        return jsonb_build_object('ok', false, 'reason', 'setup_expired');
      end if;
      delete from vehicle_enrolments where vehicle_plate = p_vehicle_plate;
      update vehicles
         set public_key = p_public_key,
             meter_firmware = coalesce(p_firmware, meter_firmware),
             meter_seen_at = now()
       where plate = p_vehicle_plate;
      insert into vehicle_changes (vehicle_plate, operator_id, change, new_value)
      values (p_vehicle_plate, v_bus.operator_id, 'unit_bound', left(p_public_key, 10));
      return jsonb_build_object('ok', true, 'reason', 'registered');
    end if;

    update vehicles
       set public_key = p_public_key,
           capacity = coalesce(p_capacity, capacity),
           meter_firmware = coalesce(p_firmware, meter_firmware),
           meter_seen_at = now()
     where plate = p_vehicle_plate;
    return jsonb_build_object('ok', true, 'reason', 'registered');
  end if;

  if v_bus.public_key <> p_public_key then
    return jsonb_build_object('ok', false, 'reason', 'key_mismatch');
  end if;

  update vehicles
     set meter_seen_at = now(),
         meter_firmware = coalesce(p_firmware, meter_firmware),
         -- The owner's figure stands on an owner-managed bus.
         capacity = case when enrol_required then capacity else coalesce(p_capacity, capacity) end
   where plate = p_vehicle_plate;
  return jsonb_build_object('ok', true, 'reason', 'seen');
end;
$$;
