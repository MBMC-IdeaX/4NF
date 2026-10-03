-- The papers a bus company files, and the people who check them.
--
-- Every company files five before it goes live (0038): its registration
-- certificate from the Office of Company Registrar, its PAN/VAT certificate, a
-- tax clearance, its directors' citizenship and its registration with DoTM as a
-- transport company. Bhada's onboarding officer usually files these.
--
-- Every bus carries five: its ownership paper (the bluebook), its pollution
-- test (प्रदूषण), a recent tax clearance, its insurance and its route permit
-- (रुट इजाजत) from the transport office, which is what ties it to a route. Every driver
-- carries two: a driving licence and their agreement with the vehicle's owner.
--
-- An owner or manager uploads each file to a private storage bucket under the
-- company's own folder, then files it here. A platform reviewer opens it,
-- checks it against the paper, and approves it with its expiry date or rejects
-- it with the reason. A bus or driver is verified while every required paper
-- is approved and in date.
--
-- Nothing here stops a fare. A bus whose insurance lapsed still carries the
-- rider who is already on it; the owner and the regulator see that it lapsed.

-- --------------------------------------------------------------- reviewers

create table if not exists platform_reviewers (
  user_id  uuid primary key,
  added_by uuid,
  added_at timestamptz not null default now()
);

alter table platform_reviewers enable row level security;

create or replace function is_reviewer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_platform_admin() or exists (select 1 from platform_reviewers where user_id = auth.uid())
$$;

grant execute on function is_reviewer() to authenticated;

create or replace function admin_set_reviewer(p_email text, p_reviewer boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
begin
  if not is_platform_admin() then return not_admin(); end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then return jsonb_build_object('ok', false, 'reason', 'no_such_login'); end if;
  if p_reviewer then
    insert into platform_reviewers (user_id, added_by) values (v_user, auth.uid()) on conflict do nothing;
  else
    delete from platform_reviewers where user_id = v_user;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ----------------------------------------------------------------- drivers

/*
  The person at the wheel. Not a login: most drivers never open an app. A
  conductor (खलासी) is a member with a login (0033); a driver is a record the
  owner keeps, with the papers the law asks for.
*/
create table if not exists operator_drivers (
  id            uuid primary key default gen_random_uuid(),
  operator_id   text not null references operators(id),
  name          text not null check (length(trim(name)) between 2 and 80),
  license_no    text not null check (length(trim(license_no)) between 4 and 40),
  phone         text,
  vehicle_plate text references vehicles(plate),
  created_at    timestamptz not null default now(),
  retired_at    timestamptz
);

create unique index if not exists operator_drivers_license on operator_drivers (operator_id, upper(license_no)) where retired_at is null;

alter table operator_drivers enable row level security;

-- ---------------------------------------------------------------- documents

create table if not exists compliance_documents (
  id            uuid primary key default gen_random_uuid(),
  operator_id   text not null references operators(id),
  vehicle_plate text references vehicles(plate),
  driver_id     uuid references operator_drivers(id),
  doc_type      text not null check (doc_type in (
                  'bluebook', 'pollution', 'tax_clearance', 'insurance', 'route_permit',   -- a bus
                  'driving_license', 'driver_agreement',                   -- a driver
                  'company_registration', 'pan_vat', 'company_tax_clearance',
                  'director_citizenship', 'dotm_registration')),           -- the company
  file_path     text not null,
  file_name     text,
  mime_type     text,
  size_bytes    integer,
  doc_number    text,
  expires_on    date,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'superseded')),
  uploaded_by   uuid,
  uploaded_at   timestamptz not null default now(),
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  review_note   text,
  constraint compliance_documents_subject check (
    (doc_type in ('bluebook', 'pollution', 'tax_clearance', 'insurance', 'route_permit') and vehicle_plate is not null and driver_id is null)
    or (doc_type in ('driving_license', 'driver_agreement') and driver_id is not null)
    or (doc_type in ('company_registration', 'pan_vat', 'company_tax_clearance', 'director_citizenship', 'dotm_registration')
        and vehicle_plate is null and driver_id is null)
  )
);

create index if not exists compliance_documents_queue on compliance_documents (status, uploaded_at);
create index if not exists compliance_documents_operator on compliance_documents (operator_id, uploaded_at desc);

alter table compliance_documents enable row level security;

-- Which papers expire. A bluebook and an agreement are checked once.
create or replace function doc_expires(p_type text)
returns boolean
language sql
immutable
as $$ select p_type in ('pollution', 'tax_clearance', 'insurance', 'route_permit', 'driving_license', 'company_tax_clearance') $$;

create or replace function doc_is_company(p_type text)
returns boolean
language sql
immutable
as $$ select p_type in ('company_registration', 'pan_vat', 'company_tax_clearance', 'director_citizenship', 'dotm_registration') $$;

-- -------------------------------------------------------- the owner's side

create or replace function owner_save_driver(
  p_id         uuid default null,
  p_name       text default null,
  p_license_no text default null,
  p_phone      text default null,
  p_plate      text default null,
  p_retire     boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
  v_id       uuid;
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  if p_plate is not null and p_plate <> '' and not exists (
    select 1 from vehicles where plate = p_plate and operator_id = v_operator and retired_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle');
  end if;

  if p_id is null then
    if coalesce(length(trim(p_name)), 0) < 2 then return jsonb_build_object('ok', false, 'reason', 'name_required'); end if;
    if coalesce(length(trim(p_license_no)), 0) < 4 then return jsonb_build_object('ok', false, 'reason', 'license_required'); end if;
    insert into operator_drivers (operator_id, name, license_no, phone, vehicle_plate)
    values (v_operator, trim(p_name), upper(trim(p_license_no)), nullif(trim(p_phone), ''), nullif(p_plate, ''))
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  update operator_drivers
     set name = coalesce(nullif(trim(p_name), ''), name),
         license_no = coalesce(upper(nullif(trim(p_license_no), '')), license_no),
         phone = case when p_phone is null then phone else nullif(trim(p_phone), '') end,
         vehicle_plate = case when p_plate is null then vehicle_plate else nullif(p_plate, '') end,
         retired_at = case when p_retire then coalesce(retired_at, now()) else retired_at end
   where id = p_id and operator_id = v_operator;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_driver'); end if;
  return jsonb_build_object('ok', true, 'id', p_id);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'license_on_file');
end;
$$;

/*
  File a paper already uploaded to storage. The file must sit in the company's
  own folder and name a bus or driver of the same company, or be one of the
  company's own papers. A newer paper of the same kind supersedes an older one
  still waiting.

  Filed by the company (owner_submit_document; its owner for company papers)
  or by Bhada staff during onboarding (admin_submit_document).
*/
create or replace function file_document(
  p_operator   text,
  p_doc_type   text,
  p_plate      text,
  p_driver_id  uuid,
  p_file_path  text,
  p_file_name  text,
  p_mime_type  text,
  p_size_bytes integer,
  p_doc_number text,
  p_expires_on date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vehicle_type boolean := p_doc_type in ('bluebook', 'pollution', 'tax_clearance', 'insurance', 'route_permit');
  v_driver_type  boolean := p_doc_type in ('driving_license', 'driver_agreement');
  v_id           uuid;
begin
  if not (v_vehicle_type or v_driver_type or doc_is_company(p_doc_type)) then
    return jsonb_build_object('ok', false, 'reason', 'bad_type');
  end if;
  if coalesce(p_file_path, '') not like p_operator || '/%' or p_file_path like '%..%' then
    return jsonb_build_object('ok', false, 'reason', 'bad_path');
  end if;
  if p_mime_type is not null and p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    return jsonb_build_object('ok', false, 'reason', 'bad_file');
  end if;
  if v_vehicle_type and not exists (select 1 from vehicles where plate = p_plate and operator_id = p_operator) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_vehicle');
  end if;
  if v_driver_type and not exists (select 1 from operator_drivers where id = p_driver_id and operator_id = p_operator) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_driver');
  end if;

  update compliance_documents set status = 'superseded'
   where operator_id = p_operator and doc_type = p_doc_type and status = 'pending'
     and vehicle_plate is not distinct from case when v_vehicle_type then p_plate end
     and driver_id is not distinct from case when v_driver_type then p_driver_id end;

  insert into compliance_documents (operator_id, vehicle_plate, driver_id, doc_type, file_path, file_name, mime_type,
                                    size_bytes, doc_number, expires_on, uploaded_by)
  values (p_operator,
          case when v_vehicle_type then p_plate end,
          case when v_driver_type then p_driver_id end,
          p_doc_type, p_file_path, left(p_file_name, 200), p_mime_type, p_size_bytes,
          nullif(trim(p_doc_number), ''), p_expires_on, auth.uid())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke all on function file_document(text, text, text, uuid, text, text, text, integer, text, date) from anon, authenticated, public;

create or replace function owner_submit_document(
  p_doc_type   text,
  p_plate      text,
  p_driver_id  uuid,
  p_file_path  text,
  p_file_name  text default null,
  p_mime_type  text default null,
  p_size_bytes integer default null,
  p_doc_number text default null,
  p_expires_on date default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator text := current_operator_id();
begin
  if v_operator is null then return jsonb_build_object('ok', false, 'reason', 'not_operator'); end if;
  -- The company's own papers are the owner's to renew.
  if doc_is_company(p_doc_type) and member_role() <> 'owner' then return jsonb_build_object('ok', false, 'reason', 'owner_only'); end if;
  return file_document(v_operator, p_doc_type, p_plate, p_driver_id, p_file_path, p_file_name, p_mime_type, p_size_bytes, p_doc_number, p_expires_on);
end;
$$;

create or replace function admin_submit_document(
  p_operator_id text,
  p_doc_type   text,
  p_plate      text,
  p_driver_id  uuid,
  p_file_path  text,
  p_file_name  text default null,
  p_mime_type  text default null,
  p_size_bytes integer default null,
  p_doc_number text default null,
  p_expires_on date default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  if not exists (select 1 from operators where id = p_operator_id) then return jsonb_build_object('ok', false, 'reason', 'unknown_operator'); end if;
  return file_document(p_operator_id, p_doc_type, p_plate, p_driver_id, p_file_path, p_file_name, p_mime_type, p_size_bytes, p_doc_number, p_expires_on);
end;
$$;

-- The state of one subject's paper of one kind: its latest decided or waiting copy.
create or replace function doc_state(p_operator text, p_type text, p_plate text, p_driver uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select jsonb_build_object(
             'id', d.id,
             'status', case when d.status = 'approved' and d.expires_on is not null and d.expires_on < current_date then 'expired' else d.status end,
             'expires_on', d.expires_on,
             'note', d.review_note,
             'uploaded_at', d.uploaded_at,
             'file_name', d.file_name)
      from compliance_documents d
     where d.operator_id = p_operator and d.doc_type = p_type and d.status <> 'superseded'
       and d.vehicle_plate is not distinct from p_plate and d.driver_id is not distinct from p_driver
     order by (d.status = 'pending') desc, d.uploaded_at desc
     limit 1), jsonb_build_object('status', 'missing'))
$$;

create or replace function compliance_for(p_operator text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with buses as (
    select v.plate, v.label,
           jsonb_build_object(
             'bluebook', doc_state(p_operator, 'bluebook', v.plate, null),
             'pollution', doc_state(p_operator, 'pollution', v.plate, null),
             'tax_clearance', doc_state(p_operator, 'tax_clearance', v.plate, null),
             'insurance', doc_state(p_operator, 'insurance', v.plate, null),
             'route_permit', doc_state(p_operator, 'route_permit', v.plate, null)) as papers
      from vehicles v where v.operator_id = p_operator and v.retired_at is null
  ),
  people as (
    select d.id, d.name, d.license_no, d.phone, d.vehicle_plate,
           jsonb_build_object(
             'driving_license', doc_state(p_operator, 'driving_license', null, d.id),
             'driver_agreement', doc_state(p_operator, 'driver_agreement', null, d.id)) as papers
      from operator_drivers d where d.operator_id = p_operator and d.retired_at is null
  )
  select jsonb_build_object(
    'company', (select jsonb_build_object('papers', p, 'verified', not exists (select 1 from jsonb_each(p) e where e.value ->> 'status' <> 'approved'))
                  from (select jsonb_build_object(
                    'company_registration', doc_state(p_operator, 'company_registration', null, null),
                    'pan_vat', doc_state(p_operator, 'pan_vat', null, null),
                    'company_tax_clearance', doc_state(p_operator, 'company_tax_clearance', null, null),
                    'director_citizenship', doc_state(p_operator, 'director_citizenship', null, null),
                    'dotm_registration', doc_state(p_operator, 'dotm_registration', null, null)) as p) x),
    'buses', coalesce((select jsonb_agg(jsonb_build_object('plate', plate, 'label', label, 'papers', papers,
               'verified', not exists (select 1 from jsonb_each(papers) e where e.value ->> 'status' <> 'approved'))
               order by plate) from buses), '[]'::jsonb),
    'drivers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'license_no', license_no, 'phone', phone,
               'vehicle_plate', vehicle_plate, 'papers', papers,
               'verified', not exists (select 1 from jsonb_each(papers) e where e.value ->> 'status' <> 'approved'))
               order by name) from people), '[]'::jsonb)
  )
$$;

revoke all on function doc_state(text, text, text, uuid) from anon, authenticated, public;
revoke all on function compliance_for(text) from anon, authenticated, public;

create or replace function owner_compliance()
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
  return jsonb_build_object('ok', true, 'operator_id', v_operator) || compliance_for(v_operator);
end;
$$;

-- ------------------------------------------------------- the reviewer's side

create or replace function review_queue(p_status text default 'pending')
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  return jsonb_build_object('ok', true, 'documents', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'operator_id', d.operator_id, 'operator_name', o.name,
             'doc_type', d.doc_type, 'vehicle_plate', d.vehicle_plate,
             'driver_name', dr.name, 'driver_license_no', dr.license_no,
             'file_path', d.file_path, 'file_name', d.file_name, 'mime_type', d.mime_type,
             'doc_number', d.doc_number, 'expires_on', d.expires_on, 'status', d.status,
             'uploaded_at', d.uploaded_at, 'reviewed_at', d.reviewed_at, 'review_note', d.review_note)
             order by d.uploaded_at)
      from compliance_documents d
      join operators o on o.id = d.operator_id
      left join operator_drivers dr on dr.id = d.driver_id
     where p_status is null or d.status = p_status), '[]'::jsonb));
end;
$$;

create or replace function review_companies()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  return jsonb_build_object('ok', true, 'companies', coalesce((
    select jsonb_agg(jsonb_build_object('operator_id', o.id, 'name', o.name) || compliance_for(o.id) order by o.name)
      from operators o), '[]'::jsonb));
end;
$$;

/*
  Approve or reject one paper. Approving a paper that expires needs its expiry
  date, read off the paper by the reviewer; rejecting needs the reason the
  owner will read.
*/
create or replace function review_document(p_id uuid, p_decision text, p_note text default null, p_expires_on date default null, p_doc_number text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc compliance_documents;
begin
  if not is_reviewer() then return jsonb_build_object('ok', false, 'reason', 'not_reviewer'); end if;
  if p_decision not in ('approved', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'bad_decision'); end if;
  select * into v_doc from compliance_documents where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_doc.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', v_doc.status); end if;
  if p_decision = 'rejected' and length(coalesce(trim(p_note), '')) < 4 then
    return jsonb_build_object('ok', false, 'reason', 'note_required');
  end if;
  if p_decision = 'approved' and doc_expires(v_doc.doc_type) and coalesce(p_expires_on, v_doc.expires_on) is null then
    return jsonb_build_object('ok', false, 'reason', 'expiry_required');
  end if;
  if p_decision = 'approved' and coalesce(p_expires_on, v_doc.expires_on) < current_date then
    return jsonb_build_object('ok', false, 'reason', 'already_expired');
  end if;

  update compliance_documents
     set status = p_decision,
         expires_on = coalesce(p_expires_on, expires_on),
         doc_number = coalesce(nullif(trim(p_doc_number), ''), doc_number),
         review_note = nullif(trim(p_note), ''),
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_id;
  -- A newly approved paper retires the one it replaces.
  if p_decision = 'approved' then
    update compliance_documents set status = 'superseded'
     where id <> p_id and operator_id = v_doc.operator_id and doc_type = v_doc.doc_type and status = 'approved'
       and vehicle_plate is not distinct from v_doc.vehicle_plate and driver_id is not distinct from v_doc.driver_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------- the file store

/*
  A private bucket, one folder per company. An owner or manager writes into
  their own folder only and never overwrites; the company and the reviewers
  read. Applied only where Supabase Storage exists, so the local proof (which
  has no storage schema) still runs every other line of this file.
*/
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('owner-documents', 'owner-documents', false, 10485760,
            array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;

    execute $p$drop policy if exists owner_documents_write on storage.objects$p$;
    execute $p$create policy owner_documents_write on storage.objects
      for insert to authenticated
      with check (bucket_id = 'owner-documents' and (storage.foldername(name))[1] = public.current_operator_id())$p$;

    -- Bhada staff file papers for a company during onboarding.
    execute $p$drop policy if exists staff_documents_write on storage.objects$p$;
    execute $p$create policy staff_documents_write on storage.objects
      for insert to authenticated
      with check (bucket_id = 'owner-documents' and public.is_reviewer())$p$;

    execute $p$drop policy if exists owner_documents_read on storage.objects$p$;
    execute $p$create policy owner_documents_read on storage.objects
      for select to authenticated
      using (bucket_id = 'owner-documents'
             and ((storage.foldername(name))[1] = public.current_operator_id() or public.is_reviewer()))$p$;
  end if;
end;
$$;

-- ------------------------------------------------------------------ grants

revoke all on function admin_set_reviewer(text, boolean) from anon, public;
revoke all on function owner_save_driver(uuid, text, text, text, text, boolean) from anon, public;
revoke all on function owner_submit_document(text, text, uuid, text, text, text, integer, text, date) from anon, public;
revoke all on function admin_submit_document(text, text, text, uuid, text, text, text, integer, text, date) from anon, public;
revoke all on function owner_compliance() from anon, public;
revoke all on function review_queue(text) from anon, public;
revoke all on function review_companies() from anon, public;
revoke all on function review_document(uuid, text, text, date, text) from anon, public;

grant execute on function admin_set_reviewer(text, boolean) to authenticated;
grant execute on function owner_save_driver(uuid, text, text, text, text, boolean) to authenticated;
grant execute on function owner_submit_document(text, text, uuid, text, text, text, integer, text, date) to authenticated;
grant execute on function admin_submit_document(text, text, text, uuid, text, text, text, integer, text, date) to authenticated;
grant execute on function owner_compliance() to authenticated;
grant execute on function review_queue(text) to authenticated;
grant execute on function review_companies() to authenticated;
grant execute on function review_document(uuid, text, text, date, text) to authenticated;
