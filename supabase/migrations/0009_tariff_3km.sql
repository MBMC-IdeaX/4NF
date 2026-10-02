-- A tariff that keeps the promise it was sold on.
--
-- NPR-KTM-2026 (Rs 15 for the first 2 km, then Rs 3 per km, cap Rs 25) was
-- presented as "no ride gets dearer than the stage table". It did not hold:
-- three stage-to-stage rides on R11 cost more metered than today, worst
-- Thapathali to New Baneshwor at Rs 18 against Rs 15. Rs 15 now buys the first
-- 3 km, the smallest change that keeps every one of the 21 stage pairs at or
-- below today's fare. `npm run proof:meter` checks every pair.
--
-- Added, not edited: receipts already priced under NPR-KTM-2026 keep being
-- re-priced with it, which is the whole reason tariffs are rows with codes.

insert into tariffs (code, route_id, boarding_charge, included_km, step_km, per_step, cap, unclosed_fare, published_by)
values ('NPR-KTM-2026B', 'R11', 15, 3, 1, 3, 25, 25, 'demo seed: 3 km included')
on conflict (code) do nothing;
