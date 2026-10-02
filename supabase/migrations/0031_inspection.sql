-- 0031: what an inspector's phone needs before it goes out.
--
-- An inspector checks a bus against the roster its meter signs (RS1,
-- protocol/inspect.mjs). To check that signature with no signal, the phone
-- needs each bus's public key, and it must come from the register here — never
-- from the bus being inspected, which is the thing under suspicion.
--
-- A public key is public: it is printed in every receipt the bus signs. So
-- this is readable by anyone, through a function that returns exactly plate
-- and key and nothing else about the vehicle or its owner.

create or replace function vehicle_public_keys()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('plate', plate, 'publicKey', public_key) order by plate), '[]'::jsonb)
    from vehicles
   where public_key is not null
$$;

revoke all on function vehicle_public_keys() from public;
grant execute on function vehicle_public_keys() to anon, authenticated;
