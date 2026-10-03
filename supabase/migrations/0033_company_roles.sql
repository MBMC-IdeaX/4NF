-- Roles inside a bus company.
--
-- Until now a login either was an operator or was not. A company is more than
-- one person: the owner, a manager who runs the buses day to day, and the
-- conductors who carry the Crew app. Each sees what their work needs and no
-- more:
--
--   owner      everything, and the only role that moves money or people
--   manager    buses, crew and reports; no payouts, no roles
--   bus_owner  a person who owns one or more of the company's buses and runs
--              them under its route permits: sees only their own buses and
--              their own money (0035)
--   conductor  the Crew app and the bus they are assigned to; none of the
--              company's figures
--
-- A company's first owner is invited by Bhada after the company is onboarded
-- (0038); companies do not sign themselves up.
--
-- Every existing login is an owner, so nothing anyone can do today changes.
--
-- current_operator_id() — the function every owner view's row-level security
-- turns on — now answers only for owners and managers. A conductor is a member
-- of the company, but reading its fares is not their job.

alter table operator_users add column if not exists role text not null default 'owner';
alter table operator_users drop constraint if exists operator_users_role_check;
alter table operator_users add constraint operator_users_role_check
  check (role in ('owner', 'manager', 'bus_owner', 'conductor'));

-- The bus a conductor works on. Informational for the owner; the phone itself
-- is bound to a bus by its setup code (0034), not by this column.
alter table operator_users add column if not exists assigned_plate text references vehicles(plate);
alter table operator_users add column if not exists joined_at timestamptz not null default now();

-- The member who owns a bus, when it is not the company's own. Its fares,
-- levy and payouts are that member's (0035).
alter table vehicles add column if not exists owner_member uuid;

create or replace function current_operator_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select ou.operator_id
    from operator_users ou
    join operators o on o.id = ou.operator_id
   where ou.user_id = auth.uid()
     and ou.role in ('owner', 'manager')
     and o.suspended_at is null
$$;

-- The caller's company and role, whatever the role. Null outside a company or
-- inside a suspended one.
create or replace function current_member()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('operator_id', ou.operator_id, 'role', ou.role, 'assigned_plate', ou.assigned_plate)
    from operator_users ou
    join operators o on o.id = ou.operator_id
   where ou.user_id = auth.uid()
     and o.suspended_at is null
$$;

grant execute on function current_member() to authenticated;

create or replace function my_operator()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when ou.operator_id is null then jsonb_build_object('registered', false)
    else jsonb_build_object(
      'registered', true,
      'operator_id', ou.operator_id,
      'name', o.name,
      'display_name', ou.display_name,
      'role', ou.role,
      'assigned_plate', ou.assigned_plate,
      'suspended', o.suspended_at is not null,
      'vehicles', (select count(*) from vehicles v where v.operator_id = ou.operator_id and v.retired_at is null)
    )
  end
  from (select 1) x
  left join operator_users ou on ou.user_id = auth.uid()
  left join operators o on o.id = ou.operator_id
$$;

-- ------------------------------------------------------------------ invites

/*
  Joining a company.

  The owner (or a manager, for conductors) makes an invite and hands over its
  code — read aloud, sent by SMS, or shown as a QR. Only a hash is kept, the
  code is shown once, it lasts seven days and it is used once. Whoever signs in
  and redeems it joins with the role the invite named; nobody can choose their
  own role.
*/
create table if not exists operator_invites (
  code_hash     text primary key,
  operator_id   text not null references operators(id),
  role          text not null check (role in ('owner', 'manager', 'bus_owner', 'conductor')),
  assigned_plate text references vehicles(plate),
  label         text,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days',
  used_by       uuid,
  used_at       timestamptz,
  revoked_at    timestamptz
);

create index if not exists operator_invites_operator on operator_invites (operator_id, created_at desc);

-- Functions only. No API role reads or writes the table.
alter table operator_invites enable row level security;

create or replace function invite_hash(p_code text)
returns text
language sql
immutable
as $$
  -- Built-in sha256, not pgcrypto: on Supabase pgcrypto lives in the
  -- extensions schema, outside the search path these functions run with.
  select encode(sha256(convert_to(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'UTF8')), 'hex')
$$;

-- The caller's role in their own company, or null.
create or replace function member_role()
returns text
language sql
stable
security definer
set search_path = public
as $$ select current_member() ->> 'role' $$;

create or replace function owner_invite(
  p_role  text,
  p_plate text default null,
  p_label text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
  v_role     text := member_role();
  v_code     text;
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  -- Owners are invited by Bhada (admin_invite_owner, 0038).
  if p_role not in ('manager', 'bus_owner', 'conductor') then return jsonb_build_object('ok', false, 'reason', 'bad_role'); end if;
  -- A manager brings conductors on; only an owner adds managers and bus owners.
  if p_role in ('manager', 'bus_owner') and v_role <> 'owner' then return jsonb_build_object('ok', false, 'reason', 'owner_only'); end if;
  if p_plate is not null and not exists (
    select 1 from vehicles where plate = p_plate and operator_id = v_operator and retired_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle');
  end if;

  -- Ten characters from an alphabet with no 0/O or 1/I to misread aloud.
  v_code := translate(upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)), '01', '89');
  insert into operator_invites (code_hash, operator_id, role, assigned_plate, label, created_by)
       values (invite_hash(v_code), v_operator, p_role, p_plate, nullif(trim(p_label), ''), auth.uid());
  return jsonb_build_object('ok', true, 'code', v_code, 'role', p_role, 'expires_at', now() + interval '7 days');
end;
$$;

create or replace function accept_invite(p_code text, p_display_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_invite operator_invites;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;

  select * into v_invite from operator_invites where code_hash = invite_hash(p_code) for update;
  if not found or v_invite.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_code');
  end if;
  if v_invite.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if v_invite.expires_at < now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if exists (select 1 from operator_users where user_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'already_member');
  end if;

  insert into operator_users (user_id, operator_id, display_name, role, assigned_plate)
       values (v_uid, v_invite.operator_id, nullif(trim(p_display_name), ''), v_invite.role,
               case when v_invite.role = 'conductor' then v_invite.assigned_plate end);
  -- A bus owner's invite names their bus: from now on its money is theirs (0035).
  if v_invite.role = 'bus_owner' and v_invite.assigned_plate is not null then
    perform set_vehicle_owner(v_invite.assigned_plate, v_uid);
  end if;
  update operator_invites set used_by = v_uid, used_at = now() where code_hash = v_invite.code_hash;
  return jsonb_build_object('ok', true, 'operator_id', v_invite.operator_id, 'role', v_invite.role,
                            'assigned_plate', v_invite.assigned_plate);
end;
$$;

-- ------------------------------------------------------------------ members

create or replace function owner_members()
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
  return jsonb_build_object(
    'ok', true,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', ou.user_id,
               'name', ou.display_name,
               'login', coalesce(u.email, u.phone),
               'role', ou.role,
               'assigned_plate', ou.assigned_plate,
               'joined_at', ou.joined_at,
               'me', ou.user_id = auth.uid()
             , 'buses', (select coalesce(jsonb_agg(v.plate order by v.plate), '[]'::jsonb) from vehicles v where v.owner_member = ou.user_id)
             ) order by array_position(array['owner', 'manager', 'bus_owner', 'conductor'], ou.role), ou.joined_at)
        from operator_users ou
        left join auth.users u on u.id = ou.user_id
       where ou.operator_id = v_operator), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object(
               'role', i.role, 'assigned_plate', i.assigned_plate, 'label', i.label,
               'created_at', i.created_at, 'expires_at', i.expires_at, 'id', left(i.code_hash, 12)
             ) order by i.created_at desc)
        from operator_invites i
       where i.operator_id = v_operator and i.used_at is null and i.revoked_at is null and i.expires_at > now()), '[]'::jsonb)
  );
end;
$$;

create or replace function owner_revoke_invite(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
  v_count integer;
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  update operator_invites set revoked_at = now()
   where operator_id = v_operator and left(code_hash, 12) = p_id and used_at is null and revoked_at is null;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', v_count = 1, 'reason', case when v_count = 1 then null else 'unknown_invite' end);
end;
$$;

/*
  Change a member's role or bus, or remove them.

  Owners only, except that a manager may move a conductor between buses. A
  company always keeps at least one owner, so the last owner cannot demote or
  remove themselves and lock everyone out of the money.
*/
create or replace function owner_set_member(
  p_user_id uuid,
  p_role    text default null,
  p_plate   text default null,
  p_remove  boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
  v_me       text := member_role();
  v_member   operator_users;
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  select * into v_member from operator_users where user_id = p_user_id and operator_id = v_operator for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_member'); end if;

  if v_me <> 'owner' and (p_remove or p_role is not null or v_member.role <> 'conductor') then
    return jsonb_build_object('ok', false, 'reason', 'owner_only');
  end if;
  if p_role is not null and p_role not in ('owner', 'manager', 'bus_owner', 'conductor') then
    return jsonb_build_object('ok', false, 'reason', 'bad_role');
  end if;
  if v_member.role = 'owner' and (p_remove or coalesce(p_role, 'owner') <> 'owner')
     and (select count(*) from operator_users where operator_id = v_operator and role = 'owner') = 1 then
    return jsonb_build_object('ok', false, 'reason', 'last_owner');
  end if;
  if p_plate is not null and p_plate <> '' and not exists (
    select 1 from vehicles where plate = p_plate and operator_id = v_operator and retired_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle');
  end if;

  if p_remove then
    -- Their buses become the company's again from now; the fares they already
    -- carried stay theirs (vehicle_owners, 0034).
    perform set_vehicle_owner(v.plate, null) from vehicles v where v.owner_member = p_user_id;
    delete from operator_users where user_id = p_user_id;
    return jsonb_build_object('ok', true, 'removed', true);
  end if;
  update operator_users
     set role = coalesce(p_role, role),
         assigned_plate = case when p_plate is null then assigned_plate else nullif(p_plate, '') end
   where user_id = p_user_id;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function owner_invite(text, text, text) to authenticated;
grant execute on function accept_invite(text, text) to authenticated;
grant execute on function owner_members() to authenticated;
grant execute on function owner_revoke_invite(text) to authenticated;
grant execute on function owner_set_member(uuid, text, text, boolean) to authenticated;

revoke all on function owner_invite(text, text, text) from anon, public;
revoke all on function accept_invite(text, text) from anon, public;
revoke all on function owner_members() from anon, public;
revoke all on function owner_revoke_invite(text) from anon, public;
revoke all on function owner_set_member(uuid, text, text, boolean) from anon, public;
