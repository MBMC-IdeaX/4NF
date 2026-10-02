-- Row Level Security.
--
-- Supabase exposes every table through PostgREST, and the anon key ships inside
-- the client bundle — it is public by construction. Without RLS that key could
-- read every wallet and, worse, INSERT into wallet_topups: anyone could credit
-- themselves any amount. This migration closes that.
--
-- The rule: the anon key may read the public fare table and nothing else. All
-- money moves through the sync Edge Function, which uses the service role and
-- bypasses RLS, and which only acts on an ed25519 signature it has verified.

-- ------------------------------------------------- public reference data

-- Stops, routes and fares are published information. A device needs them to
-- compute a fare offline, and a regulated fare is not a secret.
alter table stops   enable row level security;
alter table routes  enable row level security;
alter table fares   enable row level security;

drop policy if exists stops_public_read on stops;
create policy stops_public_read on stops for select to anon, authenticated using (true);

drop policy if exists routes_public_read on routes;
create policy routes_public_read on routes for select to anon, authenticated using (true);

drop policy if exists fares_public_read on fares;
create policy fares_public_read on fares for select to anon, authenticated using (true);

-- ------------------------------------------------------------- money

-- RLS on with no policy means no access for anon or authenticated. The service
-- role bypasses RLS entirely, so the Edge Function is unaffected.
alter table passengers    enable row level security;
alter table transactions  enable row level security;
alter table wallet_topups enable row level security;
alter table trips         enable row level security;
alter table operators     enable row level security;
alter table vehicles      enable row level security;

-- Belt and braces: even a future policy cannot grant a privilege that was
-- revoked at the table level.
revoke all on passengers, transactions, wallet_topups, trips, operators, vehicles
  from anon, authenticated;

grant select on stops, routes, fares to anon, authenticated;

-- --------------------------------------------------------------- views

-- Views run with the privileges of their owner unless told otherwise, so a view
-- over a locked table is a way around RLS. These are operator reporting and are
-- not for the anon key.
revoke all on wallet_audit, trip_totals, ridership_by_hour from anon, authenticated;

-- --------------------------------------------------------------- functions

-- settle_fare and credit_wallet move money. Only the service role may call them;
-- a client holding the anon key must go through the Edge Function, which checks
-- a signature first.
revoke all on function settle_fare(text, text, text, integer, text, text, integer, text, timestamptz, timestamptz, text) from anon, authenticated, public;
revoke all on function credit_wallet(text, integer, text, text) from anon, authenticated, public;
revoke all on function register_device(text, integer) from anon, authenticated, public;
