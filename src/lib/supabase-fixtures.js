// A stand-in backend for looking at the portals without a login.
//
// The office screens need a Supabase session, and there are good reasons not to
// hand one out casually — so design and rendering work stalls behind a password
// that nobody should be typing into a test browser. This module answers the
// same calls with fixed rows, so the screens can be rendered, screenshotted and
// judged on a laptop with no network and no credentials.
//
// It is switched on by `BHADA_FIXTURES=1 npm run build` (or `npm run dev`), and
// `vite.config.js` aliases `lib/supabase.js` to this file only in that mode. It
// can never be reached in a normal build.
//
// The rows are the shapes the real views return, copied from a live query, so a
// screen that renders correctly here renders correctly against Postgres. What
// it does NOT check is row-level security or the SQL itself — those are what
// `npm run proof:legs` is for.

export const supabaseConfigured = true;

const SESSION = {
  access_token: 'fixture',
  user: { id: '00000000-0000-0000-0000-000000000000', email: 'owner@example.np' },
};

const PLATE = 'BA2KHA4412';
const OTHER = 'BA5KHA2087';

const today = new Date();
const at = (hoursAgo) => new Date(today.getTime() - hoursAgo * 3600_000).toISOString();

// The three views migration 0025 adds, in the shape the live database returned
// them during the 18 Sep end-to-end run.
const CREW_BONUSES = [
  { vehicle_plate: PLATE, day: at(6), trips: 6, clean_trips: 4, unpaid_no_wallet: 1, bonus_npr: 200, fares_npr: 4180, net_npr: 3980 },
  { vehicle_plate: OTHER, day: at(6), trips: 5, clean_trips: 3, unpaid_no_wallet: 0, bonus_npr: 150, fares_npr: 3610, net_npr: 3460 },
];

const BONUS_MISSES = [
  {
    trip_id: 'TMU6MAJXQA1RX', vehicle_plate: PLATE, crew_public_key: 'CNcXq6pNml-f308fF-4hv6WQVGopAJk3o3z121VND84',
    legs: 22, fares: 486, outcome: 'missed', awarded_at: at(2),
    reasons: [{ code: 'power_lost', value: 1, message: 'The meter lost power 1 time while the bus was moving.' }],
  },
  {
    trip_id: 'TMTSMVFSZK8FV', vehicle_plate: OTHER, crew_public_key: 'pNSWKpP67FTijblvAoJWLQVnd_w3yOmm24TlxGo6gdk',
    legs: 31, fares: 702, outcome: 'missed', awarded_at: at(5),
    reasons: [{ code: 'door_override', value: 2, message: 'The capacity interlock was overridden 2 times.' }],
  },
  {
    trip_id: 'TMU2PPQ1ZX40A', vehicle_plate: PLATE, crew_public_key: '1rUkr4NadWc1o8zoYoxdOwa_MtGzcxYmcPKPlbzWgMg',
    legs: 3, fares: 54, outcome: 'missed', awarded_at: at(9),
    reasons: [{ code: 'too_few_legs', value: 3, limit: 5, message: '3 rides on this trip; a bonus needs 5.' }],
  },
  {
    trip_id: 'TMU9KKD2LL77B', vehicle_plate: OTHER, crew_public_key: 'z9hbo_MKAx8PmPeElKMwFkp3ocZi0sZR3uUh6pgIv6c',
    legs: 19, fares: 402, outcome: 'no_wallet', awarded_at: at(11), reasons: [],
  },
];

const POWER_TAMPER = [
  { vehicle_plate: PLATE, trip_id: 'TMU6MAJXQA1RX', at: at(2), kind: 'power_lost', moving: true, note: 'feed pulled' },
  { vehicle_plate: OTHER, trip_id: 'TMU0AABB1122', at: at(26), kind: 'power_lost', moving: true, note: null },
];

const DISTANCE = [
  { vehicle_plate: PLATE, day: at(6), rides: 61, passenger_km: 236.7, collected: 1115, npr_per_km: 4.71, mean_ride_km: 3.88, measured: 59, unclosed: 2 },
  { vehicle_plate: OTHER, day: at(6), rides: 44, passenger_km: 171.2, collected: 806, npr_per_km: 4.71, mean_ride_km: 3.89, measured: 44, unclosed: 0 },
];

const VEHICLES = [
  { plate: PLATE, route_id: 'R11', lifetime_fares: 120, lifetime_collected: 2400, last_sync: at(1), lifetime_rides_metered: 61, capacity: 42 },
  { plate: OTHER, route_id: 'R11', lifetime_fares: 90, lifetime_collected: 1800, last_sync: at(3), lifetime_rides_metered: 44, capacity: 42 },
];

const OVERLOADS = [
  { vehicle_plate: OTHER, at: at(5), kind: 'override_on', door: 'A', onboard: 44, capacity: 42, note: null },
  { vehicle_plate: PLATE, at: at(7), kind: 'locked', door: 'A', onboard: 42, capacity: 42, note: null },
];

const TRIPS = [
  { id: 'T1', vehicle_plate: PLATE, passengers: 61, collected: 1115, started_at: at(6) },
  { id: 'T2', vehicle_plate: OTHER, passengers: 44, collected: 806, started_at: at(5) },
];

const STOPS = [
  { code: 'RATNAPARK', name_ne: 'रत्नपार्क', name_en: 'Ratna Park' },
  { code: 'KOTESHWOR', name_ne: 'कोटेश्वर', name_en: 'Koteshwor' },
];

const TABLES = {
  operator_crew_bonuses: CREW_BONUSES,
  operator_bonus_misses: BONUS_MISSES,
  operator_power_tamper: POWER_TAMPER,
  operator_distance: DISTANCE,
  operator_vehicles: VEHICLES,
  operator_overloads: OVERLOADS,
  operator_trips: TRIPS,
  operator_segments: [],
  operator_hourly: [],
  stops: STOPS,
  routes: [],
  route_directory: [],
};

// Every builder method returns the same thenable, so any chain of
// .select().eq().order().limit() resolves to the table's rows.
function query(name) {
  const rows = TABLES[name] ?? [];
  const result = { data: rows, error: null };
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => chain,
    range: () => chain,
    single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then: (resolve) => Promise.resolve(result).then(resolve),
  };
  return chain;
}

const RPC = {
  // The shape my_operator() actually returns (migration 0006), not a guess.
  my_operator: {
    registered: true,
    operator_id: 'SAJHA',
    name: 'Sajha Yatayat',
    display_name: 'Owner',
    vehicles: VEHICLES.length,
  },
  my_statement: {
    ok: true,
    balance: 1284,
    entries: [
      { at: at(3), kind: 'topup', title: 'Top-up · eSewa', detail: '000AWEO', amount: 250, balance_after: 1284 },
      { at: at(8), kind: 'ride', title: 'माइतीघर → नयाँ बानेश्वर', detail: '3.1 km · बा २ ख ४४१२', amount: -18, balance_after: 1034 },
      { at: at(26), kind: 'ride', title: 'रत्नपार्क → कोटेश्वर', detail: '7.5 km · बा ५ ख २०८७', amount: -25, balance_after: 1052 },
      { at: at(50), kind: 'opening', title: 'Opening balance', detail: '', amount: 0, balance_after: 1077 },
    ],
  },
  my_topup_requests: [],
  my_account: { ok: true, wallet: 'CNcXq6pNml-f308fF-4hv6WQVGopAJk3o3z121VND84', balance: 1284, overdraft: 50, owed: 0 },
};

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: SESSION }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
    getUser: async () => ({ data: { user: SESSION.user }, error: null }),
  },
  from: (name) => query(name),
  rpc: async (name) => ({ data: name === 'my_account' ? await myAccount() : RPC[name] ?? null, error: null }),
};

// The account portal compares the login's wallet with this phone's. By default
// the fixture login is linked to this very phone; `?elsewhere` makes it a login
// whose money is on another phone, and `?unlinked` one with no wallet yet.
async function myAccount() {
  const search = window.location.search;
  if (search.includes('unlinked')) return { linked: false, email: SESSION.user.email };
  const { walletKey } = await import('../device/sync');
  const here = await walletKey().catch(() => null);
  return {
    ...RPC.my_account,
    linked: true,
    email: SESSION.user.email,
    wallet: search.includes('elsewhere') ? RPC.my_account.wallet : here ?? RPC.my_account.wallet,
  };
}
