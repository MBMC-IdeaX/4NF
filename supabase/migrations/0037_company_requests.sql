-- What a company asks Bhada to do, and the routes Bhada builds from permits.
--
-- Owners do not type buses or routes in (3 Oct 2026: entry by owners was slow
-- and could not be trusted). They ask, with the paper attached, and Bhada's
-- staff do the entry from the paper:
--
--   new_bus  "add this bus": its bluebook and route permit attached
--   route    "my bus's route is not listed": named as on the permit, which the
--            bus has filed (0036)
--
-- A route is built once, from its permit, by a reviewer — stops in running
-- order, each with where it is — and is then there for every company that holds
-- a permit for it. Nothing about fares changes: a metered ride is priced by
-- distance, and stage fares come from the regulated fare table.

-- Where a stop is. Optional for the seeded corridor, required for a stop a
-- reviewer adds, so a rider's map and an inspector can rely on it.
alter table stops add column if not exists lat_micro integer;
alter table stops add column if not exists lon_micro integer;

alter table routes add column if not exists built_by uuid;
alter table routes add column if not exists built_at timestamptz;

create table if not exists company_requests (
  id            uuid primary key default gen_random_uuid(),
  operator_id   text not null references operators(id),
  kind          text not null check (kind in ('new_bus', 'route')),
  vehicle_plate text,                       -- the bus a route request is for; the plate asked for on new_bus
  details       jsonb not null default '{}'::jsonb,
  files         jsonb not null default '[]'::jsonb,  -- [{path, name, mime, label}], in the company's folder
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  result        text,                       -- the plate registered, or the route the bus was put on
  created_by    uuid,
  created_at    timestamptz not null default now(),
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  review_note   text
);

create index if not exists company_requests_queue on company_requests (status, created_at);
create index if not exists company_requests_operator on company_requests (operator_id, created_at desc);
alter table company_requests enable row level security;

-- ------------------------------------------------------------ the company

create or replace function owner_request(p_kind text, p_plate text, p_details jsonb default '{}'::jsonb, p_files jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
  v_plate    text := upper(regexp_replace(coalesce(p_plate, ''), '\s', '', 'g'));
  v_file     jsonb;
  v_id       uuid;
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  if p_kind not in ('new_bus', 'route') then return jsonb_build_object('ok', false, 'reason', 'bad_kind'); end if;
  if jsonb_typeof(p_files) <> 'array' then return jsonb_build_object('ok', false, 'reason', 'bad_files'); end if;
  for v_file in select f from jsonb_array_elements(p_files) as e(f) loop
    if coalesce(v_file ->> 'path', '') not like v_operator || '/%' or (v_file ->> 'path') like '%..%' then
      return jsonb_build_object('ok', false, 'reason', 'bad_path');
    end if;
  end loop;

  if p_kind = 'new_bus' then
    if v_plate !~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{2,3}[0-9]{1,4}$' then return jsonb_build_object('ok', false, 'reason', 'bad_plate'); end if;
    if exists (select 1 from vehicles where plate = v_plate) then return jsonb_build_object('ok', false, 'reason', 'taken'); end if;
    -- The bluebook and the route permit are what staff enter the bus from.
    if jsonb_array_length(p_files) < 2 then return jsonb_build_object('ok', false, 'reason', 'papers_required'); end if;
  else
    if not exists (select 1 from vehicles where plate = v_plate and operator_id = v_operator and retired_at is null) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle');
    end if;
    if length(trim(coalesce(p_details ->> 'permit_name', ''))) < 3 then return jsonb_build_object('ok', false, 'reason', 'route_name_required'); end if;
    if not exists (select 1 from compliance_documents where vehicle_plate = v_plate and operator_id = v_operator
                    and doc_type = 'route_permit' and status in ('pending', 'approved')) then
      return jsonb_build_object('ok', false, 'reason', 'permit_required');
    end if;
  end if;
  if exists (select 1 from company_requests where operator_id = v_operator and kind = p_kind and vehicle_plate = v_plate and status = 'pending') then
    return jsonb_build_object('ok', false, 'reason', 'request_open');
  end if;

  insert into company_requests (operator_id, kind, vehicle_plate, details, files, created_by)
  values (v_operator, p_kind, v_plate, coalesce(p_details, '{}'::jsonb), p_files, auth.uid())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function owner_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  return jsonb_build_object('ok', true, 'requests', coalesce((
    select jsonb_agg(to_jsonb(r) - 'created_by' - 'reviewed_by' order by r.created_at desc)
      from company_requests r where r.operator_id = v_operator), '[]'::jsonb));
end;
$$;

create or replace function owner_withdraw_request(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  update company_requests set status = 'withdrawn' where id = p_id and operator_id = v_operator and status = 'pending';
  return jsonb_build_object('ok', found);
end;
$$;

-- ------------------------------------------------------------ Bhada staff

create or replace function review_requests(p_status text default 'pending')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  return jsonb_build_object('ok', true, 'requests', coalesce((
    select jsonb_agg(to_jsonb(r) || jsonb_build_object(
             'operator_name', o.name,
             -- A route request is built from the bus's latest route permit.
             'permit', case when r.kind = 'route' then (
               select jsonb_build_object('id', d.id, 'file_path', d.file_path, 'file_name', d.file_name, 'mime_type', d.mime_type, 'status', d.status)
                 from compliance_documents d
                where d.vehicle_plate = r.vehicle_plate and d.doc_type = 'route_permit' and d.status <> 'superseded'
                order by d.uploaded_at desc limit 1) end)
           order by r.created_at)
      from company_requests r join operators o on o.id = r.operator_id
     where p_status is null or r.status = p_status), '[]'::jsonb));
end;
$$;

/*
  Build a route from a permit: its names and its stops in running order. A stop
  is an existing code, or a new one with Nepali and English names and a position
  inside Nepal. New stops get a code made from the English name, made unique.
*/
create or replace function admin_build_route(p_name_ne text, p_name_en text, p_stops jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_route text;
  v_stop  jsonb;
  v_code  text;
  v_seen  text[] := '{}';
  v_n     integer := 0;
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  if length(trim(coalesce(p_name_en, ''))) < 3 or length(trim(coalesce(p_name_ne, ''))) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'route_name_required');
  end if;
  if jsonb_typeof(p_stops) <> 'array' or jsonb_array_length(p_stops) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'too_few_stops');
  end if;
  -- Check every stop before writing any.
  for v_stop in select s from jsonb_array_elements(p_stops) as e(s) loop
    if v_stop ? 'code' then
      if not exists (select 1 from stops where code = v_stop ->> 'code') then
        return jsonb_build_object('ok', false, 'reason', 'unknown_stop', 'code', v_stop ->> 'code');
      end if;
      if (v_stop ->> 'code') = any(v_seen) then return jsonb_build_object('ok', false, 'reason', 'stop_twice'); end if;
      v_seen := v_seen || (v_stop ->> 'code');
    elsif length(trim(coalesce(v_stop ->> 'name_en', ''))) < 2 or length(trim(coalesce(v_stop ->> 'name_ne', ''))) < 1 then
      return jsonb_build_object('ok', false, 'reason', 'stop_name_required');
    elsif (v_stop ->> 'lat') is null or (v_stop ->> 'lon') is null
       or (v_stop ->> 'lat')::numeric not between 26.3 and 30.5 or (v_stop ->> 'lon')::numeric not between 80.0 and 88.3 then
      return jsonb_build_object('ok', false, 'reason', 'stop_position_required');
    end if;
  end loop;

  v_route := 'R' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into routes (id, name_ne, name_en, built_by, built_at)
  values (v_route, trim(p_name_ne), trim(p_name_en), auth.uid(), now());

  for v_stop in select s from jsonb_array_elements(p_stops) as e(s) loop
    v_n := v_n + 1;
    if v_stop ? 'code' then
      v_code := v_stop ->> 'code';
    else
      v_code := left(upper(regexp_replace(v_stop ->> 'name_en', '[^A-Za-z0-9]', '', 'g')), 16);
      if v_code = '' then v_code := 'STOP'; end if;
      if exists (select 1 from stops where code = v_code) then
        v_code := left(v_code, 11) || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
      end if;
      insert into stops (code, name_ne, name_en, ordinal, lat_micro, lon_micro)
      values (v_code, trim(v_stop ->> 'name_ne'), trim(v_stop ->> 'name_en'),
              (select coalesce(max(ordinal), 0) + 1 from stops),
              round((v_stop ->> 'lat')::numeric * 1000000)::integer, round((v_stop ->> 'lon')::numeric * 1000000)::integer);
    end if;
    insert into route_stops (route_id, stop_code, ordinal) values (v_route, v_code, v_n);
  end loop;
  return jsonb_build_object('ok', true, 'route_id', v_route);
end;
$$;

/*
  Settle a request. A route request is approved onto a route (built from the
  permit, or one that already existed under another name), which puts the bus on
  it. A new-bus request is approved once staff have registered the bus
  (admin_register_vehicle, 0034); the plate is its result. Refusals carry the
  reason the owner will read.
*/
create or replace function review_request(p_id uuid, p_decision text, p_result text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req company_requests;
  v_old text;
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  if p_decision not in ('approved', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'bad_decision'); end if;
  select * into v_req from company_requests where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_req.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;
  if p_decision = 'rejected' then
    if length(coalesce(trim(p_note), '')) < 4 then return jsonb_build_object('ok', false, 'reason', 'note_required'); end if;
    update company_requests set status = 'rejected', review_note = trim(p_note), reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
    return jsonb_build_object('ok', true);
  end if;

  if v_req.kind = 'route' then
    if p_result is null or not exists (select 1 from routes where id = p_result) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_route');
    end if;
    select route_id into v_old from vehicles where plate = v_req.vehicle_plate;
    update vehicles set route_id = p_result where plate = v_req.vehicle_plate;
    insert into vehicle_changes (vehicle_plate, operator_id, changed_by, change, old_value, new_value)
    values (v_req.vehicle_plate, v_req.operator_id, auth.uid(), 'route', v_old, p_result);
  else
    if not exists (select 1 from vehicles where plate = v_req.vehicle_plate and operator_id = v_req.operator_id) then
      return jsonb_build_object('ok', false, 'reason', 'register_first');
    end if;
    p_result := v_req.vehicle_plate;
  end if;

  update company_requests
     set status = 'approved', result = p_result, review_note = nullif(trim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true, 'result', p_result);
end;
$$;

revoke all on function owner_request(text, text, jsonb, jsonb) from anon, public;
revoke all on function owner_requests() from anon, public;
revoke all on function owner_withdraw_request(uuid) from anon, public;
revoke all on function review_requests(text) from anon, public;
revoke all on function admin_build_route(text, text, jsonb) from anon, public;
revoke all on function review_request(uuid, text, text, text) from anon, public;
grant execute on function owner_request(text, text, jsonb, jsonb) to authenticated;
grant execute on function owner_requests() to authenticated;
grant execute on function owner_withdraw_request(uuid) to authenticated;
grant execute on function review_requests(text) to authenticated;
grant execute on function admin_build_route(text, text, jsonb) to authenticated;
grant execute on function review_request(uuid, text, text, text) to authenticated;
