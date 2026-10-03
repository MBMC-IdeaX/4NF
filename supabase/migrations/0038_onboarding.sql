-- Onboarding a transport company: agreements first, papers checked, then live.
--
-- The research behind this is docs/legal/2026-10-03-onboarding-research.md.
-- A company is the holder of route permits (Transport Management Directive
-- amendment of 2018; Urban Public Transport Authority Act 2079 §2(ठ)); Bhada
-- onboards it in person:
--
--   1. agreements, before anything else: the service agreement, the payout
--      mandate and the data consent notice (Privacy Act 2075 §12) — signed on
--      paper and scanned, or accepted in the app, or both; every acceptance
--      keeps the exact text's hash
--   2. the company's five papers (0036), checked against the originals
--   3. buses entered by staff from bluebooks and route permits (0034, 0037)
--   4. the owner invited; bus owners and crews invited by the owner (0033)
--   5. live: payouts open (0035). Fares settle from the first ride either way.
--
-- A company that applies from the Owner app starts in `onboarding`, exactly as
-- one Bhada creates. Companies already running before this migration stay live.

alter table operators add column if not exists onboarding_status text not null default 'live';
alter table operators drop constraint if exists operators_onboarding_status_check;
alter table operators add constraint operators_onboarding_status_check check (onboarding_status in ('onboarding', 'live'));
alter table operators add column if not exists contact_name text;
alter table operators add column if not exists contact_phone text;
alter table operators add column if not exists pan text;
alter table operators add column if not exists address text;
alter table operators add column if not exists live_at timestamptz;
alter table operators add column if not exists live_by uuid;

-- New companies start onboarding; only rows that existed above keep 'live'.
alter table operators alter column onboarding_status set default 'onboarding';

-- A company applying from the app: the same register_operator() as before
-- (0019), its company now waiting for Bhada.
-- (No change to the function is needed: the column default does it.)

-- ------------------------------------------------------------- agreements

/*
  The text of each agreement, versioned. A new version is a new row; nothing is
  edited, so an acceptance always points at the words that were accepted.
*/
create table if not exists agreement_texts (
  kind         text not null check (kind in ('service', 'payout_mandate', 'data_consent', 'membership')),
  version      integer not null,
  title        text not null,
  body         text not null,
  body_hash    text not null,
  published_by uuid,
  published_at timestamptz not null default now(),
  primary key (kind, version)
);

alter table agreement_texts enable row level security;
-- Public on purpose: anyone may read what they would be agreeing to.
grant select on agreement_texts to anon, authenticated;
drop policy if exists agreement_texts_public on agreement_texts;
create policy agreement_texts_public on agreement_texts for select to anon, authenticated using (true);

create table if not exists operator_agreements (
  id           uuid primary key default gen_random_uuid(),
  operator_id  text not null references operators(id),
  member_id    uuid,                         -- a bus owner, for 'membership'
  kind         text not null,
  version      integer not null,
  method       text not null check (method in ('paper', 'in_app')),
  body_hash    text not null,
  signer_name  text,
  signer_phone text,
  file_path    text,                         -- the scan, for paper
  accepted_by  uuid,                         -- the login, for in_app
  recorded_by  uuid,                         -- Bhada staff, for paper
  at           timestamptz not null default now(),
  foreign key (kind, version) references agreement_texts (kind, version)
);

create index if not exists operator_agreements_operator on operator_agreements (operator_id, kind, at desc);
alter table operator_agreements enable row level security;

-- The kinds a company must hold before it goes live.
create or replace function required_agreements()
returns text[]
language sql
immutable
as $$ select array['service', 'payout_mandate', 'data_consent'] $$;

create or replace function latest_agreement(p_kind text)
returns agreement_texts
language sql
stable
security definer
set search_path = public
as $$ select * from agreement_texts where kind = p_kind order by version desc limit 1 $$;

create or replace function admin_publish_agreement(p_kind text, p_title text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version integer;
begin
  if not is_platform_admin() then return not_admin(); end if;
  if p_kind not in ('service', 'payout_mandate', 'data_consent', 'membership') then return jsonb_build_object('ok', false, 'reason', 'bad_kind'); end if;
  if length(coalesce(trim(p_title), '')) < 3 or length(coalesce(trim(p_body), '')) < 50 then
    return jsonb_build_object('ok', false, 'reason', 'text_required');
  end if;
  select coalesce(max(version), 0) + 1 into v_version from agreement_texts where kind = p_kind;
  insert into agreement_texts (kind, version, title, body, body_hash, published_by)
  values (p_kind, v_version, trim(p_title), p_body, encode(sha256(convert_to(p_body, 'UTF8')), 'hex'), auth.uid());
  return jsonb_build_object('ok', true, 'version', v_version);
end;
$$;

-- In the app: the owner (company kinds) or a bus owner (membership) accepts the
-- current text. The login is the signature (Electronic Transactions Act 2063:
-- offer and acceptance); the hash fixes what was accepted.
create or replace function accept_agreement(p_kind text, p_version integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member jsonb := current_member();
  v_text   agreement_texts;
begin
  if v_member is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  if p_kind = 'membership' then
    if v_member ->> 'role' <> 'bus_owner' then return jsonb_build_object('ok', false, 'reason', 'bus_owner_only'); end if;
  elsif v_member ->> 'role' <> 'owner' then
    return jsonb_build_object('ok', false, 'reason', 'owner_only');
  end if;
  select * into v_text from agreement_texts where kind = p_kind and version = p_version;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_agreement'); end if;
  if p_version <> (latest_agreement(p_kind)).version then return jsonb_build_object('ok', false, 'reason', 'not_current'); end if;
  insert into operator_agreements (operator_id, member_id, kind, version, method, body_hash, accepted_by)
  values (v_member ->> 'operator_id', case when p_kind = 'membership' then auth.uid() end, p_kind, p_version, 'in_app', v_text.body_hash, auth.uid());
  return jsonb_build_object('ok', true);
end;
$$;

-- On paper: Bhada staff record the signed copy and attach the scan.
create or replace function admin_record_agreement(
  p_operator_id  text,
  p_kind         text,
  p_version      integer,
  p_signer_name  text,
  p_signer_phone text,
  p_file_path    text,
  p_member       uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_text agreement_texts;
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  if not exists (select 1 from operators where id = p_operator_id) then return jsonb_build_object('ok', false, 'reason', 'unknown_operator'); end if;
  select * into v_text from agreement_texts where kind = p_kind and version = p_version;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_agreement'); end if;
  if length(coalesce(trim(p_signer_name), '')) < 2 then return jsonb_build_object('ok', false, 'reason', 'signer_required'); end if;
  if coalesce(p_file_path, '') not like p_operator_id || '/%' then return jsonb_build_object('ok', false, 'reason', 'scan_required'); end if;
  insert into operator_agreements (operator_id, member_id, kind, version, method, body_hash, signer_name, signer_phone, file_path, recorded_by)
  values (p_operator_id, p_member, p_kind, p_version, 'paper', v_text.body_hash, trim(p_signer_name), nullif(trim(p_signer_phone), ''), p_file_path, auth.uid());
  return jsonb_build_object('ok', true);
end;
$$;

-- Where a company stands, for the owner's checklist and the staff console.
create or replace function onboarding_state(p_operator_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'operator_id', o.id,
    'name', o.name,
    'status', o.onboarding_status,
    'live_at', o.live_at,
    'contact_name', o.contact_name, 'contact_phone', o.contact_phone, 'pan', o.pan, 'address', o.address,
    'agreements', (select jsonb_object_agg(k, (
                     select jsonb_build_object('version', a.version, 'method', a.method, 'at', a.at, 'signer', coalesce(a.signer_name, u.email),
                                               'current', a.version = (latest_agreement(k)).version)
                       from operator_agreements a left join auth.users u on u.id = a.accepted_by
                      where a.operator_id = o.id and a.kind = k and a.member_id is null
                      order by a.at desc limit 1))
                     from unnest(required_agreements()) k),
    'agreements_texts', (select jsonb_object_agg(k, (select jsonb_build_object('version', t.version, 'title', t.title) from agreement_texts t
                           where t.kind = k order by t.version desc limit 1)) from unnest(array_append(required_agreements(), 'membership')) k),
    'company_papers', compliance_for(o.id) -> 'company',
    'buses', (select count(*) from vehicles v where v.operator_id = o.id and v.retired_at is null),
    'owner_joined', exists (select 1 from operator_users ou where ou.operator_id = o.id and ou.role = 'owner'),
    'levy_per_day', levy_at(o.id, (now() at time zone 'Asia/Kathmandu')::date)
  )
  from operators o where o.id = p_operator_id
$$;

revoke all on function onboarding_state(text) from anon, authenticated, public;

create or replace function my_onboarding()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member jsonb := current_member();
begin
  if v_member is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  return jsonb_build_object('ok', true, 'role', v_member ->> 'role') || onboarding_state(v_member ->> 'operator_id')
    -- A bus owner's own membership agreement, beside the company's.
    || jsonb_build_object('membership', (
         select jsonb_build_object('version', a.version, 'method', a.method, 'at', a.at,
                                   'current', a.version = (latest_agreement('membership')).version)
           from operator_agreements a
          where a.operator_id = v_member ->> 'operator_id' and a.kind = 'membership' and a.member_id = auth.uid()
          order by a.at desc limit 1));
end;
$$;

-- --------------------------------------------------------------- the staff

create or replace function admin_create_company(p_name text, p_contact_name text, p_contact_phone text, p_pan text default null, p_address text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  if length(coalesce(trim(p_name), '')) < 3 then return jsonb_build_object('ok', false, 'reason', 'name_required'); end if;
  if coalesce(regexp_replace(p_contact_phone, '\D', '', 'g'), '') !~ '^9[78][0-9]{8}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_phone');
  end if;
  -- The same readable id register_operator() makes.
  v_id := upper(regexp_replace(trim(p_name), '[^a-zA-Z0-9]', '', 'g'));
  v_id := left(nullif(v_id, ''), 12);
  if v_id is null then v_id := 'OP'; end if;
  v_id := v_id || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
  insert into operators (id, name, onboarding_status, contact_name, contact_phone, pan, address)
  values (v_id, trim(p_name), 'onboarding', nullif(trim(p_contact_name), ''), regexp_replace(p_contact_phone, '\D', '', 'g'),
          nullif(trim(p_pan), ''), nullif(trim(p_address), ''));
  return jsonb_build_object('ok', true, 'operator_id', v_id);
end;
$$;

-- The first owner's login: Bhada makes the invite, the owner redeems it (0033).
create or replace function admin_invite_owner(p_operator_id text, p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  if not exists (select 1 from operators where id = p_operator_id) then return jsonb_build_object('ok', false, 'reason', 'unknown_operator'); end if;
  v_code := translate(upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)), '01', '89');
  insert into operator_invites (code_hash, operator_id, role, label, created_by)
  values (invite_hash(v_code), p_operator_id, 'owner', nullif(trim(p_label), ''), auth.uid());
  return jsonb_build_object('ok', true, 'code', v_code, 'expires_at', now() + interval '7 days');
end;
$$;

create or replace function admin_companies()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  return jsonb_build_object('ok', true, 'companies', coalesce((
    select jsonb_agg(onboarding_state(o.id) order by (o.onboarding_status = 'live'), o.created_at desc) from operators o), '[]'::jsonb));
end;
$$;

create or replace function admin_company(p_operator_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  if not exists (select 1 from operators where id = p_operator_id) then return jsonb_build_object('ok', false, 'reason', 'unknown_operator'); end if;
  return jsonb_build_object('ok', true) || onboarding_state(p_operator_id) || jsonb_build_object(
    'compliance', compliance_for(p_operator_id),
    'fleet', coalesce((select jsonb_agg(jsonb_build_object('plate', v.plate, 'label', v.label, 'route_id', v.route_id,
                       'seated', v.seated, 'standing', v.standing, 'capacity', v.capacity, 'door_counter', v.door_counter,
                       'owner_member', v.owner_member, 'retired_at', v.retired_at) order by v.plate)
                       from vehicles v where v.operator_id = p_operator_id), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', ou.user_id, 'name', ou.display_name, 'role', ou.role,
                         'login', coalesce(u.email, u.phone)) order by ou.role, ou.joined_at)
                         from operator_users ou left join auth.users u on u.id = ou.user_id where ou.operator_id = p_operator_id), '[]'::jsonb)
  );
end;
$$;

/*
  Live. Every required agreement held at its current version, every company
  paper approved and in date. Payouts open from here; fares settled all along.
*/
create or replace function admin_set_company_live(p_operator_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state   jsonb;
  v_missing text[] := '{}';
  k         text;
begin
  if not is_platform_admin() then return not_admin(); end if;
  v_state := onboarding_state(p_operator_id);
  if v_state is null then return jsonb_build_object('ok', false, 'reason', 'unknown_operator'); end if;
  foreach k in array required_agreements() loop
    if coalesce((v_state -> 'agreements' -> k ->> 'current')::boolean, false) is not true then v_missing := v_missing || k; end if;
  end loop;
  if coalesce((v_state -> 'company_papers' ->> 'verified')::boolean, false) is not true then v_missing := v_missing || 'company_papers'::text; end if;
  if array_length(v_missing, 1) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_ready', 'missing', to_jsonb(v_missing));
  end if;
  update operators set onboarding_status = 'live', live_at = now(), live_by = auth.uid() where id = p_operator_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function admin_publish_agreement(text, text, text) from anon, public;
revoke all on function accept_agreement(text, integer) from anon, public;
revoke all on function admin_record_agreement(text, text, integer, text, text, text, uuid) from anon, public;
revoke all on function my_onboarding() from anon, public;
revoke all on function admin_create_company(text, text, text, text, text) from anon, public;
revoke all on function admin_invite_owner(text, text) from anon, public;
revoke all on function admin_companies() from anon, public;
revoke all on function admin_company(text) from anon, public;
revoke all on function admin_set_company_live(text) from anon, public;
grant execute on function admin_publish_agreement(text, text, text) to authenticated;
grant execute on function accept_agreement(text, integer) to authenticated;
grant execute on function admin_record_agreement(text, text, integer, text, text, text, uuid) to authenticated;
grant execute on function my_onboarding() to authenticated;
grant execute on function admin_create_company(text, text, text, text, text) to authenticated;
grant execute on function admin_invite_owner(text, text) to authenticated;
grant execute on function admin_companies() to authenticated;
grant execute on function admin_company(text) to authenticated;
grant execute on function admin_set_company_live(text) to authenticated;
