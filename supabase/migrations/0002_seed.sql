-- Ratna Park to Koteshwor, with the intermediate stops and regulated fares.
-- Real corridor, real stop names, fares in the range Sajha charges today.

insert into operators (id, name) values
  ('SAJHA', 'Sajha Yatayat')
on conflict (id) do nothing;

insert into routes (id, name_ne, name_en) values
  ('R11', 'रत्नपार्क–कोटेश्वर', 'Ratna Park to Koteshwor')
on conflict (id) do nothing;

insert into vehicles (plate, operator_id, route_id) values
  ('BA2KHA4412', 'SAJHA', 'R11'),
  ('BA5KHA2087', 'SAJHA', 'R11')
on conflict (plate) do nothing;

insert into stops (code, name_ne, name_en, ordinal) values
  ('RATNAPARK',    'रत्नपार्क',      'Ratna Park',    1),
  ('SINGHADURBAR', 'सिंहदरबार',      'Singha Durbar', 2),
  ('MAITIGHAR',    'माइतीघर',        'Maitighar',     3),
  ('THAPATHALI',   'थापाथली',        'Thapathali',    4),
  ('NEWBANESHWOR', 'नयाँ बानेश्वर',  'New Baneshwor', 5),
  ('TINKUNE',      'तिनकुने',        'Tinkune',       6),
  ('KOTESHWOR',    'कोटेश्वर',       'Koteshwor',     7)
on conflict (code) do nothing;

/*
  Regulated fare between every ordered pair on the corridor: Rs 15 minimum,
  then Rs 5 per further stop, capped at Rs 25 end to end. Generated rather
  than typed so the table cannot disagree with itself.
*/
insert into fares (route_id, boarding_stop, alighting_stop, amount)
select 'R11',
       a.code,
       b.code,
       least(25, 15 + (b.ordinal - a.ordinal - 1) * 5)
  from stops a
  join stops b on b.ordinal > a.ordinal
on conflict (route_id, boarding_stop, alighting_stop) do nothing;
