-- Operator self-registration.
--
-- 0005 assumed an operator row already existed and was mapped by hand. A real
-- operator signs up on the site, and the first thing they do is name their
-- company and add their buses. `operator_users` is not writable by anyone —
-- letting a signed-in user insert their own mapping would let them join an
-- existing operator and read its revenue — so registration goes through a
-- security-definer function that only ever creates a *new* operator.

create or replace function register_operator(
  p_name text,
  p_display_name text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  text;
  v_existing text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;

  -- Already mapped. Registering twice must not orphan the first operator.
  select operator_id into v_existing from operator_users where user_id = v_uid;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'operator_id', v_existing, 'created', false);
  end if;

  if coalesce(trim(p_name), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;

  -- A readable id derived from the name, with a short suffix so two operators
  -- called "Sajha" do not collide.
  v_id := upper(regexp_replace(trim(p_name), '[^a-zA-Z0-9]', '', 'g'));
  v_id := left(nullif(v_id, ''), 12);
  if v_id is null then v_id := 'OP'; end if;
  v_id := v_id || '-' || upper(substr(encode(gen_random_bytes(3), 'hex'), 1, 5));

  insert into operators (id, name) values (v_id, trim(p_name));
  insert into operator_users (user_id, operator_id, display_name)
       values (v_uid, v_id, coalesce(p_display_name, trim(p_name)));

  return jsonb_build_object('ok', true, 'operator_id', v_id, 'created', true);
end;
$$;

revoke all on function register_operator(text, text) from anon, public;
grant execute on function register_operator(text, text) to authenticated;

/*
  Who am I. The dashboard needs the operator's name and id on every load, and
  `operators` is only readable once the mapping exists, so this returns both in
  one call and works before any policy would.
*/
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
      'vehicles', (select count(*) from vehicles v where v.operator_id = ou.operator_id)
    )
  end
  from (select 1) x
  left join operator_users ou on ou.user_id = auth.uid()
  left join operators o on o.id = ou.operator_id
$$;

grant execute on function my_operator() to authenticated;

-- Retiring a bus. Deleting one would orphan its transactions, so vehicles are
-- retired rather than removed.
alter table vehicles add column if not exists retired_at timestamptz;

drop policy if exists vehicles_own on vehicles;
create policy vehicles_own on vehicles
  for select to authenticated
  using (operator_id = current_operator_id());
