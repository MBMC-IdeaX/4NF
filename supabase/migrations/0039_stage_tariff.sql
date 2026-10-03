-- Stage fares: how buses in the valley are actually priced.
--
-- Bhada does not set fares. A ride is priced from the stage it boarded at to
-- the stage it got off at, out of a fare table; GPS is what finds those two
-- stages. Until now metered rides were priced by distance (NPR-KTM-2026B).
-- From here new rides are priced by the stage tariff below, and the boarding
-- and exit stages are signed into the receipt (BM2).
--
-- Added, not edited: older receipts keep their distance tariff and keep
-- re-pricing with it. A tariff row now says which kind it is, and a stage
-- tariff carries its table as JSON so the fare a receipt names can be read
-- back here exactly as the device and the sync function priced it.
--
-- THE TABLE IS A DEMO. It follows the seeded `fares` rule for R11 (Rs 15 for
-- the next stage, Rs 5 for each stage after, at most Rs 25). It is not a
-- published government table; the real one is loaded as a new tariff code.

alter table tariffs add column if not exists kind text not null default 'distance';
alter table tariffs drop constraint if exists tariffs_kind_check;
alter table tariffs add constraint tariffs_kind_check check (kind in ('distance', 'stage'));
alter table tariffs add column if not exists stage_fares jsonb;

insert into tariffs (code, route_id, boarding_charge, included_km, step_km, per_step, cap, unclosed_fare, published_by, kind, stage_fares)
select 'R11-STAGE-DEMO-1', 'R11', 15, 0, 1, 0, 25, 25, 'demo seed: stage fare table, not an official table', 'stage',
       jsonb_object_agg(a.code || '|' || b.code,
         case when abs(a.seq - b.seq) = 0 then 15 else least(25, 15 + (abs(a.seq - b.seq) - 1) * 5) end)
  from (values ('RATNAPARK', 1), ('SINGHADURBAR', 2), ('MAITIGHAR', 3), ('THAPATHALI', 4),
               ('NEWBANESHWOR', 5), ('TINKUNE', 6), ('KOTESHWOR', 7)) as a(code, seq)
 cross join (values ('RATNAPARK', 1), ('SINGHADURBAR', 2), ('MAITIGHAR', 3), ('THAPATHALI', 4),
               ('NEWBANESHWOR', 5), ('TINKUNE', 6), ('KOTESHWOR', 7)) as b(code, seq)
on conflict (code) do nothing;
