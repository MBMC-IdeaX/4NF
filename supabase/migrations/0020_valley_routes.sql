-- More than one route.
--
-- 0001 gave every stop a single `ordinal`, which is R11's order and nobody
-- else's: a stop could only ever sit on one corridor, and Ratna Park is on half
-- the valley's routes. route_stops holds the order per route instead, and R11 is
-- copied into it unchanged. stops.ordinal stays for R11's fare generation in
-- 0002 and the bundled table in src/lib/fares.js, and is no longer required.
--
-- The eight corridors below are well-known Kathmandu Valley routes with stops
-- in their running order. They are NOT DoTM permit numbers and have not been
-- checked against any operator's permit: an owner must confirm the stop list
-- before a bus on one of these routes charges stage fares. Metered fares are
-- priced by the kilometre and do not depend on this table at all.

alter table stops alter column ordinal drop not null;
comment on column stops.ordinal is 'R11 order only (0002). Route order lives in route_stops.';

create table if not exists route_stops (
  route_id  text    not null references routes(id),
  stop_code text    not null references stops(code),
  ordinal   integer not null check (ordinal > 0),
  primary key (route_id, ordinal),
  unique (route_id, stop_code)
);

alter table route_stops enable row level security;
drop policy if exists route_stops_public_read on route_stops;
create policy route_stops_public_read on route_stops for select to anon, authenticated using (true);
grant select on route_stops to anon, authenticated;

-- R11, exactly as it has always been.
insert into route_stops (route_id, stop_code, ordinal)
select 'R11', code, ordinal from stops where ordinal is not null
on conflict do nothing;

insert into stops (code, name_ne, name_en) values
  ('KALANKI',        'कलंकी',          'Kalanki'),
  ('BALKHU',         'बल्खु',           'Balkhu'),
  ('EKANTAKUNA',     'एकान्तकुना',      'Ekantakuna'),
  ('SATDOBATO',      'सातदोबाटो',       'Satdobato'),
  ('GWARKO',         'ग्वार्को',         'Gwarko'),
  ('SINAMANGAL',     'सिनामंगल',        'Sinamangal'),
  ('GAUSHALA',       'गौशाला',          'Gaushala'),
  ('CHABAHIL',       'चाबहिल',          'Chabahil'),
  ('SUKEDHARA',      'सुकेधारा',         'Sukedhara'),
  ('MAHARAJGUNJ',    'महाराजगञ्ज',       'Maharajgunj'),
  ('BASUNDHARA',     'बसुन्धरा',         'Basundhara'),
  ('BALAJU',         'बालाजु',           'Balaju'),
  ('SWAYAMBHU',      'स्वयम्भू',          'Swayambhu'),
  ('SUNDHARA',       'सुन्धारा',         'Sundhara'),
  ('TRIPURESHWOR',   'त्रिपुरेश्वर',       'Tripureshwor'),
  ('TEKU',           'टेकु',             'Teku'),
  ('KALIMATI',       'कालीमाटी',         'Kalimati'),
  ('SOLTIMODE',      'सोल्टीमोड',        'Soltimode'),
  ('JADIBUTI',       'जडीबुटी',          'Jadibuti'),
  ('LOKANTHALI',     'लोकन्थली',         'Lokanthali'),
  ('KAUSHALTAR',     'कौशलटार',         'Kaushaltar'),
  ('GATTHAGHAR',     'गट्ठाघर',          'Gatthaghar'),
  ('THIMI',          'ठिमी',             'Thimi'),
  ('SALLAGHARI',     'सल्लाघारी',        'Sallaghari'),
  ('BHAKTAPUR',      'भक्तपुर',          'Bhaktapur'),
  ('JAMAL',          'जमल',             'Jamal'),
  ('LAZIMPAT',       'लाजिम्पाट',        'Lazimpat'),
  ('PANIPOKHARI',    'पानीपोखरी',        'Panipokhari'),
  ('CHAKRAPATH',     'चक्रपथ',           'Chakrapath'),
  ('GOLFUTAR',       'गोल्फुटार',        'Golfutar'),
  ('BUDHANILKANTHA', 'बूढानीलकण्ठ',      'Budhanilkantha'),
  ('LAGANKHEL',      'लगनखेल',          'Lagankhel'),
  ('JAWALAKHEL',     'जावलाखेल',        'Jawalakhel'),
  ('PULCHOWK',       'पुल्चोक',          'Pulchowk'),
  ('KUPONDOLE',      'कुपण्डोल',         'Kupondole'),
  ('KULESHWOR',      'कुलेश्वर',         'Kuleshwor'),
  ('KIRTIPUR',       'कीर्तिपुर',         'Kirtipur'),
  ('LAINCHAUR',      'लैनचौर',          'Lainchaur'),
  ('SORHAKHUTTE',    'सोह्रखुट्टे',        'Sorhakhutte'),
  ('MACHHAPOKHARI',  'माछापोखरी',       'Machhapokhari'),
  ('GONGABU',        'गोंगबु',           'Gongabu'),
  ('PUTALISADAK',    'पुतलीसडक',        'Putalisadak'),
  ('DILLIBAZAR',     'डिल्लीबजार',       'Dillibazar'),
  ('BOUDHA',         'बौद्ध',            'Boudha'),
  ('JORPATI',        'जोरपाटी',          'Jorpati')
on conflict (code) do nothing;

insert into routes (id, name_ne, name_en) values
  ('RINGROAD',   'रिङरोड (कलंकी–स्वयम्भू, घडीको दिशामा)', 'Ring Road (Kalanki to Swayambhu, clockwise)'),
  ('RPKALANKI',  'रत्नपार्क–कलंकी',        'Ratna Park to Kalanki'),
  ('RPBHAKTAPUR','रत्नपार्क–भक्तपुर',       'Ratna Park to Bhaktapur'),
  ('RPBUDHANIL', 'रत्नपार्क–बूढानीलकण्ठ',   'Ratna Park to Budhanilkantha'),
  ('LAGANKHELRP','लगनखेल–रत्नपार्क',       'Lagankhel to Ratna Park'),
  ('RPKIRTIPUR', 'रत्नपार्क–कीर्तिपुर',      'Ratna Park to Kirtipur'),
  ('RPGONGABU',  'रत्नपार्क–गोंगबु',        'Ratna Park to Gongabu'),
  ('RPJORPATI',  'रत्नपार्क–जोरपाटी',       'Ratna Park to Jorpati')
on conflict (id) do nothing;

insert into route_stops (route_id, stop_code, ordinal)
select r.route_id, s.stop_code, s.ordinal
  from (values
    ('RINGROAD',    array['KALANKI','BALKHU','EKANTAKUNA','SATDOBATO','GWARKO','KOTESHWOR','SINAMANGAL','GAUSHALA','CHABAHIL','SUKEDHARA','MAHARAJGUNJ','BASUNDHARA','BALAJU','SWAYAMBHU']),
    ('RPKALANKI',   array['RATNAPARK','SUNDHARA','TRIPURESHWOR','TEKU','KALIMATI','SOLTIMODE','KALANKI']),
    ('RPBHAKTAPUR', array['RATNAPARK','MAITIGHAR','NEWBANESHWOR','TINKUNE','KOTESHWOR','JADIBUTI','LOKANTHALI','KAUSHALTAR','GATTHAGHAR','THIMI','SALLAGHARI','BHAKTAPUR']),
    ('RPBUDHANIL',  array['RATNAPARK','JAMAL','LAZIMPAT','PANIPOKHARI','MAHARAJGUNJ','CHAKRAPATH','GOLFUTAR','BUDHANILKANTHA']),
    ('LAGANKHELRP', array['LAGANKHEL','JAWALAKHEL','PULCHOWK','KUPONDOLE','THAPATHALI','MAITIGHAR','RATNAPARK']),
    ('RPKIRTIPUR',  array['RATNAPARK','SUNDHARA','TRIPURESHWOR','TEKU','KULESHWOR','BALKHU','KIRTIPUR']),
    ('RPGONGABU',   array['RATNAPARK','JAMAL','LAINCHAUR','SORHAKHUTTE','BALAJU','MACHHAPOKHARI','GONGABU']),
    ('RPJORPATI',   array['RATNAPARK','PUTALISADAK','DILLIBAZAR','GAUSHALA','CHABAHIL','BOUDHA','JORPATI'])
  ) as r(route_id, codes)
  cross join lateral unnest(r.codes) with ordinality as s(stop_code, ordinal)
on conflict do nothing;

/*
  Stage fares for the new routes, by R11's rule: Rs 15 minimum, Rs 5 per
  further stop, capped at Rs 25. A placeholder until the owner loads the
  published table for the route, and the reason it is generated rather than
  typed is the same as in 0002: it cannot disagree with itself.
*/
insert into fares (route_id, boarding_stop, alighting_stop, amount)
select a.route_id, a.stop_code, b.stop_code, least(25, 15 + (b.ordinal - a.ordinal - 1) * 5)
  from route_stops a
  join route_stops b on b.route_id = a.route_id and b.ordinal > a.ordinal
 where a.route_id <> 'R11'
on conflict (route_id, boarding_stop, alighting_stop) do nothing;

-- A route with its stops in order, for the dashboard.
create or replace view route_directory as
select
  r.id,
  r.name_ne,
  r.name_en,
  count(rs.stop_code)::int as stops,
  (array_agg(s.name_en order by rs.ordinal))[1] as first_stop,
  (array_agg(s.name_en order by rs.ordinal desc))[1] as last_stop,
  string_agg(s.name_en, ' · ' order by rs.ordinal) as via
from routes r
left join route_stops rs on rs.route_id = r.id
left join stops s on s.code = rs.stop_code
group by r.id, r.name_ne, r.name_en;

grant select on route_directory to anon, authenticated;
