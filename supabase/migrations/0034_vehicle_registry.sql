-- The vehicle registry: buses registered, changed and retired through checked
-- functions, every change written down, and a bus phone bound only with a code
-- its owner issued.
--
-- Two holes this closes.
--
-- 1. Since 0005 any owner could UPDATE their own vehicles rows directly: the
--    meter key every receipt is verified against, the permitted capacity the
--    door interlock enforces and the regulator reads, the route. Nothing
--    recorded who changed what. The table grant goes; owner_* functions take
--    its place and log each change in vehicle_changes.
--
-- 2. register_meter() binds the first key it is offered for a plate with no
--    key. Anyone who knew a plate could sync once and become that bus's meter.
--    A bus registered through admin_register_vehicle() is marked
--    enrol_required, and binds only a phone that brings the one-time setup code
--    from owner_bus_setup(). Vehicles from before this migration keep the old
--    behaviour until their owner issues a setup code for them.
--
-- Capacity on an owner-managed bus is the owner's figure: the setup code
-- carries it to the phone, and the phone's own report no longer overwrites it.

alter table vehicles add column if not exists label text;
alter table vehicles add column if not exists enrol_required boolean not null default false;

alter table vehicles drop constraint if exists vehicles_label_length;
alter table vehicles add constraint vehicles_label_length check (label is null or length(label) <= 40);

-- -------------------------------------------------------------- the change log

create table if not exists vehicle_changes (
  id            bigserial primary key,
  vehicle_plate text not null references vehicles(plate),
  operator_id   text references operators(id),
  changed_by    uuid,                      -- null when the bus phone itself did it
  change        text not null,             -- registered, route, label, capacity, door_counter,
                                           -- retired, restored, setup_issued, unit_replaced, unit_bound, bus_owner
  old_value     text,
  new_value     text,
  at            timestamptz not null default now()
);

create index if not exists vehicle_changes_plate on vehicle_changes (vehicle_plate, at desc);

alter table vehicle_changes enable row level security;
grant select on vehicle_changes to authenticated;

drop policy if exists vehicle_changes_own on vehicle_changes;
create policy vehicle_changes_own on vehicle_changes
  for select to authenticated
  using (operator_id = current_operator_id());

create or replace function note_vehicle_change(p_plate text, p_change text, p_old text, p_new text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into vehicle_changes (vehicle_plate, operator_id, changed_by, change, old_value, new_value)
  select p_plate, v.operator_id, auth.uid(), p_change, p_old, p_new from vehicles v where v.plate = p_plate
$$;

revoke execute on function note_vehicle_change(text, text, text, text) from public;

-- ------------------------------------------------------ who owned the bus when

/*
  A bus can change hands inside a company: a member buys it, sells it back, or
  leaves. The fares it carried belong to whoever owned it on the day it carried
  them, so a change of owner must never carry the bus's past with it — or the
  rupees a member was already paid would turn up again in the company's balance.

  Each change is a dated row, never edited. A bus with no row has always been
  the company's. vehicles.owner_member is the current owner, kept equal to the
  latest row by set_vehicle_owner(), which is the only thing that writes either.
*/
create table if not exists vehicle_owners (
  id            bigserial primary key,
  vehicle_plate text not null references vehicles(plate),
  member_id     uuid,                     -- null: the company's own again
  from_at       timestamptz not null default now(),
  set_by        uuid
);

create index if not exists vehicle_owners_plate on vehicle_owners (vehicle_plate, from_at desc, id desc);
alter table vehicle_owners enable row level security;

create or replace function set_vehicle_owner(p_plate text, p_member uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old uuid;
begin
  select owner_member into v_old from vehicles where plate = p_plate for update;
  if not found or v_old is not distinct from p_member then return; end if;
  update vehicles set owner_member = p_member where plate = p_plate;
  insert into vehicle_owners (vehicle_plate, member_id, set_by) values (p_plate, p_member, auth.uid());
  perform note_vehicle_change(p_plate, 'bus_owner', v_old::text, p_member::text);
end;
$$;

revoke all on function set_vehicle_owner(text, uuid) from anon, authenticated, public;

-- The member who owned a bus at a moment, or null for the company.
create or replace function fare_party(p_plate text, p_at timestamptz)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select (select member_id from vehicle_owners
           where vehicle_plate = p_plate and from_at <= p_at
           order by from_at desc, id desc limit 1)
$$;

revoke all on function fare_party(text, timestamptz) from anon, authenticated, public;

-- ------------------------------------------------- no more direct writes

drop policy if exists vehicles_insert_own on vehicles;
drop policy if exists vehicles_update_own on vehicles;
revoke insert, update, delete on vehicles from authenticated;
revoke insert, update, delete on vehicles from anon;

-- ------------------------------------------------------------- register

/*
  A bus is put on Bhada by Bhada staff, from its bluebook and route permit,
  for a company Bhada has onboarded (0038) — never typed in by an owner. It
  may name the member who owns it (0033); its fares are then that member's.
*/
create or replace function admin_register_vehicle(
  p_operator_id text,
  p_plate       text,
  p_route_id    text default null,
  p_seated      integer default null,
  p_standing    integer default 0,
  p_label       text default null,
  p_member      uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plate    text := upper(regexp_replace(coalesce(p_plate, ''), '\s', '', 'g'));
  v_existing vehicles;
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  if not exists (select 1 from operators where id = p_operator_id) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_operator');
  end if;
  -- Zonal plates as buses carry them: BA 2 KHA 4412.
  if v_plate !~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{2,3}[0-9]{1,4}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_plate');
  end if;
  if p_route_id is not null and not exists (select 1 from routes where id = p_route_id) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_route');
  end if;
  if p_seated is null or p_seated < 1 or p_seated > 120
     or coalesce(p_standing, 0) < 0 or coalesce(p_standing, 0) > 120
     or p_seated + coalesce(p_standing, 0) > 200 then
    return jsonb_build_object('ok', false, 'reason', 'bad_capacity');
  end if;
  if p_member is not null and not exists (
    select 1 from operator_users where user_id = p_member and operator_id = p_operator_id and role = 'bus_owner'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_member');
  end if;

  select * into v_existing from vehicles where plate = v_plate;
  if found then
    return jsonb_build_object('ok', false,
      'reason', case when v_existing.operator_id = p_operator_id and v_existing.retired_at is not null then 'retired' else 'taken' end);
  end if;

  insert into vehicles (plate, operator_id, route_id, seated, standing, capacity, label, enrol_required)
  values (v_plate, p_operator_id, p_route_id, p_seated, coalesce(p_standing, 0), p_seated + coalesce(p_standing, 0),
          nullif(trim(p_label), ''), true);
  perform note_vehicle_change(v_plate, 'registered', null, v_plate);
  if p_member is not null then perform set_vehicle_owner(v_plate, p_member); end if;
  return jsonb_build_object('ok', true, 'plate', v_plate);
end;
$$;

-- Which member owns a bus, set by Bhada staff or the company's owner.
create or replace function set_bus_owner(p_plate text, p_member uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bus vehicles;
begin
  select * into v_bus from vehicles where plate = p_plate for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle'); end if;
  if not (is_reviewer() or (current_operator_id() = v_bus.operator_id and member_role() = 'owner')) then
    return jsonb_build_object('ok', false, 'reason', 'owner_only');
  end if;
  if p_member is not null and not exists (
    select 1 from operator_users where user_id = p_member and operator_id = v_bus.operator_id and role = 'bus_owner'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_member');
  end if;
  -- From now on; the fares it already carried stay with whoever owned it then.
  perform set_vehicle_owner(p_plate, p_member);
  return jsonb_build_object('ok', true);
end;
$$;

-- --------------------------------------------------------------- change

/*
  Change a bus. Null leaves a field alone. The plate, the operator and the
  meter key are not changeable here at all — a key moves only through
  owner_bus_setup().

  Its route and its seats are read off its route permit and bluebook, so only
  Bhada staff change them (admin_update_vehicle), from the paper. The seats are
  the permitted capacity the door interlock enforces and the regulator reads.
  The owner changes what the papers do not say: its name and its door counter.

  A capacity change reaches the bus the next time its phone is set up with a
  fresh code; until then the phone enforces what it was given.
*/
create or replace function update_vehicle(
  p_plate        text,
  p_route_id     text,
  p_label        text,
  p_seated       integer,
  p_standing     integer,
  p_door_counter boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bus      vehicles;
  v_seated   integer;
  v_standing integer;
begin
  select * into v_bus from vehicles where plate = p_plate for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle'); end if;
  if v_bus.retired_at is not null then return jsonb_build_object('ok', false, 'reason', 'retired'); end if;
  if p_route_id is not null and not exists (select 1 from routes where id = p_route_id) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_route');
  end if;

  v_seated := coalesce(p_seated, v_bus.seated);
  v_standing := coalesce(p_standing, v_bus.standing, 0);
  if (p_seated is not null or p_standing is not null)
     and (v_seated is null or v_seated < 1 or v_seated > 120 or v_standing < 0 or v_standing > 120 or v_seated + v_standing > 200) then
    return jsonb_build_object('ok', false, 'reason', 'bad_capacity');
  end if;

  if p_route_id is not null and p_route_id is distinct from v_bus.route_id then
    perform note_vehicle_change(p_plate, 'route', v_bus.route_id, p_route_id);
  end if;
  if p_label is not null and nullif(trim(p_label), '') is distinct from v_bus.label then
    perform note_vehicle_change(p_plate, 'label', v_bus.label, nullif(trim(p_label), ''));
  end if;
  if (p_seated is not null or p_standing is not null) and (v_seated + v_standing) is distinct from v_bus.capacity then
    perform note_vehicle_change(p_plate, 'capacity', v_bus.capacity::text, (v_seated + v_standing)::text);
  end if;
  if p_door_counter is not null and p_door_counter is distinct from v_bus.door_counter then
    perform note_vehicle_change(p_plate, 'door_counter', v_bus.door_counter::text, p_door_counter::text);
  end if;

  update vehicles
     set route_id = coalesce(p_route_id, route_id),
         label = case when p_label is null then label else nullif(trim(p_label), '') end,
         seated = case when p_seated is null and p_standing is null then seated else v_seated end,
         standing = case when p_seated is null and p_standing is null then standing else v_standing end,
         capacity = case when p_seated is null and p_standing is null then capacity else v_seated + v_standing end,
         door_counter = coalesce(p_door_counter, door_counter)
   where plate = p_plate;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function update_vehicle(text, text, text, integer, integer, boolean) from anon, authenticated, public;

create or replace function owner_update_vehicle(
  p_plate        text,
  p_route_id     text default null,
  p_label        text default null,
  p_seated       integer default null,
  p_standing     integer default null,
  p_door_counter boolean default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  if not exists (select 1 from vehicles where plate = p_plate and operator_id = v_operator) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle');
  end if;
  -- Read off the permit and the bluebook: the company asks Bhada (0037).
  if p_route_id is not null or p_seated is not null or p_standing is not null then
    return jsonb_build_object('ok', false, 'reason', 'from_papers');
  end if;
  return update_vehicle(p_plate, null, p_label, null, null, p_door_counter);
end;
$$;

create or replace function admin_update_vehicle(
  p_plate        text,
  p_route_id     text default null,
  p_label        text default null,
  p_seated       integer default null,
  p_standing     integer default null,
  p_door_counter boolean default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  return update_vehicle(p_plate, p_route_id, p_label, p_seated, p_standing, p_door_counter);
end;
$$;

-- ------------------------------------------------------- retire, restore

-- Retired, not deleted: its rides, fares and door tape stay on file.
create or replace function owner_retire_vehicle(p_plate text, p_retire boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
  v_bus      vehicles;
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  select * into v_bus from vehicles where plate = p_plate and operator_id = v_operator for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle'); end if;
  if p_retire and v_bus.retired_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  if not p_retire and v_bus.retired_at is null then return jsonb_build_object('ok', true, 'already', true); end if;

  update vehicles set retired_at = case when p_retire then now() else null end where plate = p_plate;
  -- A retired bus has no crew to be assigned to it.
  if p_retire then
    update operator_users set assigned_plate = null where assigned_plate = p_plate;
    delete from vehicle_enrolments where vehicle_plate = p_plate;
  end if;
  perform note_vehicle_change(p_plate, case when p_retire then 'retired' else 'restored' end, null, null);
  return jsonb_build_object('ok', true);
end;
$$;

-- -------------------------------------------------- setting up a bus phone

/*
  One outstanding setup code per bus. Only its hash is kept; the code is shown
  to the owner once, in the QR the conductor's phone scans. It lasts 48 hours
  and binds one phone.
*/
create table if not exists vehicle_enrolments (
  vehicle_plate text primary key references vehicles(plate),
  code_hash     text not null,
  issued_by     uuid,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '48 hours'
);

alter table vehicle_enrolments enable row level security;

/*
  Issue a setup code for a bus.

  A bus with a phone already bound needs `p_replace`: the old phone stops being
  the bus the moment this runs, because its key is cleared. Receipts it signed
  and never uploaded cannot be verified after that, so the owner's screen asks
  first. A bus from before 0034 becomes enrol-required here, so it is
  protected from then on too.
*/
create or replace function owner_bus_setup(p_plate text, p_replace boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
  v_bus      vehicles;
  v_code     text;
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  select * into v_bus from vehicles where plate = p_plate and operator_id = v_operator for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle'); end if;
  if v_bus.retired_at is not null then return jsonb_build_object('ok', false, 'reason', 'retired'); end if;
  if v_bus.public_key is not null and not p_replace then
    return jsonb_build_object('ok', false, 'reason', 'unit_active', 'seen_at', v_bus.meter_seen_at);
  end if;

  if v_bus.public_key is not null then
    perform note_vehicle_change(p_plate, 'unit_replaced', left(v_bus.public_key, 10), null);
    update vehicles set public_key = null, meter_firmware = null where plate = p_plate;
  end if;

  v_code := translate(upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), '01', '89');
  insert into vehicle_enrolments (vehicle_plate, code_hash, issued_by)
  values (p_plate, invite_hash(v_code), auth.uid())
  on conflict (vehicle_plate) do update
     set code_hash = excluded.code_hash, issued_by = excluded.issued_by,
         issued_at = now(), expires_at = now() + interval '48 hours';
  update vehicles set enrol_required = true where plate = p_plate;
  perform note_vehicle_change(p_plate, 'setup_issued', null, null);

  return jsonb_build_object(
    'ok', true,
    'plate', v_bus.plate,
    'code', v_code,
    'route_id', v_bus.route_id,
    'label', v_bus.label,
    'seated', v_bus.seated,
    'standing', v_bus.standing,
    'capacity', v_bus.capacity,
    'door_counter', v_bus.door_counter,
    'expires_at', now() + interval '48 hours'
  );
end;
$$;

-- -------------------------------------------------- the meter, re-written

drop function if exists register_meter(text, text, integer, text);

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

-- ------------------------------------------------------------ the fleet

/*
  Every bus of the caller's company, with what an owner looks at first: is
  its phone set up, when did it last report, what did it carry today.
  Runs as the caller, so vehicles' row-level security narrows it.
*/
create or replace view owner_fleet
with (security_invoker = true) as
  select v.plate,
         v.label,
         v.route_id,
         r.name_en as route_name,
         v.seated,
         v.standing,
         v.capacity,
         v.door_counter,
         v.retired_at,
         v.created_at,
         v.public_key is not null as unit_bound,
         v.meter_seen_at as unit_seen_at,
         v.meter_firmware as unit_firmware,
         exists (select 1 from vehicle_enrolments e where e.vehicle_plate = v.plate and e.expires_at > now()) as setup_pending,
         (select count(*) from legs l
           where l.vehicle_plate = v.plate
             and l.alighted_at >= date_trunc('day', now() at time zone 'Asia/Kathmandu') at time zone 'Asia/Kathmandu')::int as rides_today,
         ((select coalesce(sum(amount), 0) from legs l
            where l.vehicle_plate = v.plate
              and l.alighted_at >= date_trunc('day', now() at time zone 'Asia/Kathmandu') at time zone 'Asia/Kathmandu')
          + (select coalesce(sum(amount), 0) from transactions t
            where t.vehicle_plate = v.plate
              and t.issued_at >= date_trunc('day', now() at time zone 'Asia/Kathmandu') at time zone 'Asia/Kathmandu'))::int as collected_today
    from vehicles v
    left join routes r on r.id = v.route_id;

grant select on owner_fleet to authenticated;

/*
  A bus owner's own buses, with the same figures the company sees for them.
  A function rather than a view: a bus owner has no row-level access to the
  company's vehicles, legs or fares, and this reads only theirs.
*/
create or replace function my_buses()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'plate', v.plate, 'label', v.label, 'route_id', v.route_id, 'route_name', r.name_en,
           'seated', v.seated, 'standing', v.standing, 'capacity', v.capacity,
           'unit_bound', v.public_key is not null, 'unit_seen_at', v.meter_seen_at, 'retired_at', v.retired_at,
           'rides_today', (select count(*) from legs l where l.vehicle_plate = v.plate
                            and l.alighted_at >= date_trunc('day', now() at time zone 'Asia/Kathmandu') at time zone 'Asia/Kathmandu'),
           'collected_today', (select coalesce(sum(amount), 0) from legs l where l.vehicle_plate = v.plate
                            and l.alighted_at >= date_trunc('day', now() at time zone 'Asia/Kathmandu') at time zone 'Asia/Kathmandu')
                            + (select coalesce(sum(amount), 0) from transactions t where t.vehicle_plate = v.plate
                            and t.issued_at >= date_trunc('day', now() at time zone 'Asia/Kathmandu') at time zone 'Asia/Kathmandu')
         ) order by v.plate), '[]'::jsonb)
    from vehicles v
    left join routes r on r.id = v.route_id
   where v.owner_member = auth.uid()
     and v.operator_id = (current_member() ->> 'operator_id')
$$;

revoke all on function my_buses() from anon, public;
grant execute on function my_buses() to authenticated;

-- The bus phone talks to register_meter() only through the sync function's
-- service role, as before.
revoke all on function register_meter(text, text, integer, text, text) from anon, authenticated, public;

revoke all on function admin_register_vehicle(text, text, text, integer, integer, text, uuid) from anon, public;
revoke all on function set_bus_owner(text, uuid) from anon, public;
revoke all on function owner_update_vehicle(text, text, text, integer, integer, boolean) from anon, public;
revoke all on function admin_update_vehicle(text, text, text, integer, integer, boolean) from anon, public;
revoke all on function owner_retire_vehicle(text, boolean) from anon, public;
revoke all on function owner_bus_setup(text, boolean) from anon, public;

grant execute on function admin_register_vehicle(text, text, text, integer, integer, text, uuid) to authenticated;
grant execute on function set_bus_owner(text, uuid) to authenticated;
grant execute on function owner_update_vehicle(text, text, text, integer, integer, boolean) to authenticated;
grant execute on function admin_update_vehicle(text, text, text, integer, integer, boolean) to authenticated;
grant execute on function owner_retire_vehicle(text, boolean) to authenticated;
grant execute on function owner_bus_setup(text, boolean) to authenticated;
