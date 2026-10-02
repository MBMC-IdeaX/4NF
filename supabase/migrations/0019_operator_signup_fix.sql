-- An owner could sign up but never name their company.
--
-- register_operator() (0006) built the id's suffix with gen_random_bytes(),
-- which is pgcrypto. On Supabase pgcrypto lives in the `extensions` schema, and
-- the function pins `search_path = public` — correctly, since it is security
-- definer — so the call failed with "function gen_random_bytes(integer) does
-- not exist" and every new owner was stuck on the registration screen.
--
-- gen_random_uuid() is built into Postgres 13 and later and sits in
-- pg_catalog, which is always on the path. Same five hex characters, no
-- extension to find.

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
  v_id := v_id || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));

  insert into operators (id, name) values (v_id, trim(p_name));
  insert into operator_users (user_id, operator_id, display_name)
       values (v_uid, v_id, coalesce(p_display_name, trim(p_name)));

  return jsonb_build_object('ok', true, 'operator_id', v_id, 'created', true);
end;
$$;

revoke all on function register_operator(text, text) from anon, public;
grant execute on function register_operator(text, text) to authenticated;
