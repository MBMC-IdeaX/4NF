-- Public verification material only; wallet and ownership data remain private.
create function rider_bus_key(p_vehicle_plate text) returns text
language sql stable security definer set search_path = public
as $$ select public_key from vehicles where plate = p_vehicle_plate and retired_at is null $$;
revoke all on function rider_bus_key(text) from public;
grant execute on function rider_bus_key(text) to anon, authenticated;
