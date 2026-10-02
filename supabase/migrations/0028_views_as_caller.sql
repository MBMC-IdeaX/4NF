-- Five views that ran as their owner, open to the anon key.
--
-- A Postgres view runs with its owner's rights unless it says otherwise, so
-- row-level security on the tables underneath never applied to these. And
-- Supabase grants every new relation in public to anon and authenticated by
-- default, which none of these migrations revoked. The anon key ships in the
-- site's JavaScript, so anyone could read every operator's per-bus takings
-- (dotm_daily_return), their overload register, the concession and dispute
-- load, and which meters score as implausible. Any signed-in operator could
-- read a competitor's fleet the same way.
--
-- Each now runs as the caller, so legs_own, door_events_own and vehicles_own
-- decide what it shows: an operator sees their own buses, anon sees nothing.
-- The operator dashboard's DoTM returns screen reads the first two and keeps
-- working, narrowed to the caller's fleet as it always should have been.
--
-- proof:legs section 23 now fails on any table without RLS, or any view that
-- runs as its owner, that an API role can select.

alter view dotm_daily_return      set (security_invoker = true);
alter view dotm_overload_register set (security_invoker = true);
alter view concession_claims      set (security_invoker = true);
alter view meter_plausibility     set (security_invoker = true);
alter view dispute_load           set (security_invoker = true);

revoke all on dotm_daily_return, dotm_overload_register, concession_claims, meter_plausibility, dispute_load
  from anon, public;

-- dispute_load was never meant for a dashboard; the others were granted to
-- operators on purpose and stay granted, now under RLS.
revoke all on dispute_load from authenticated;
grant select on dotm_daily_return, dotm_overload_register, concession_claims, meter_plausibility to authenticated;
