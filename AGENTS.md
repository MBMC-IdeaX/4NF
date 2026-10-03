# Bhada

Offline-first bus fare payment for Nepal. React + Vite PWA, deployed as a static
site; Supabase Postgres and an Edge Function handle sync and reconciliation.

Fares are metered by distance, not by stop pair: an on-vehicle unit (`/device`)
integrates GNSS fixes into an odometer, two door terminals (`/terminal?door=A|B`)
open and close rides against it, and the same passenger count drives a boarding
door interlock at the vehicle's permitted capacity. Passengers carry their own
key: the ride card (`/app`, passenger) shows a signed BT1 ride code, measures the
ride with the phone's own odometer, and keeps the signed BM1 receipt. The
stage-fare path (passenger + conductor, BH1 tokens) is unchanged and still works
underneath.

`protocol/` is platform-free ESM shared by the app, the Supabase Edge Function
and the Node proof scripts. It must never import anything browser- or
Node-specific: the random source is injected at startup instead, and position
fixes and timestamps are always handed in rather than read.

Before anything in `protocol/` is considered changed, all five proofs must pass —
`npm run proof:all` runs them:

- `npm run proof` — the offline BH1 handshake, headless
- `npm run proof:meter` — odometer accuracy against simulated roads (every
  traffic speed, with and without Doppler), fare agreement over 400 random rides,
  the tariff promise over all 21 stage pairs, taps and consent, doors, frame
- `npm run proof:reconcile` — stage-fare settlement on real Postgres (PGlite)
- `npm run proof:legs` — every migration on PGlite, metered settlement through
  `scripts/lib/pg-backend.mjs`: tap consent, replay, unclosed rides, dead-phone
  claims, owner views
- `npm run proof:validator` — the Raspberry Pi door validator (`validator/`):
  the unchanged door on its Pi adapters, offline, scanner, PN532, DS3231,
  RS-485 frame sync, screens (every QR decoded from pixels), power tape

After editing `protocol/`, run `npm run sync:protocol` — the Edge Function has a
generated copy that is never edited by hand.

Rules that are easy to break:

- A leg never settles without the passenger's BT1 tap on file (`leg_taps`,
  migration 0008). Anything that closes a ride must carry `tapQr` with it.
- Tariffs are added, never edited: a receipt is re-priced with the tariff code
  it names (`TARIFFS` in `protocol/meter.mjs`, `tariffs` table).
- A sync batch is verified in exactly one place: `settleBatch()` in
  `protocol/settle.mjs`. Both `supabase/functions/sync/index.ts` and
  `scripts/lib/pg-backend.mjs` are adapters over it, supplying a ledger of
  database methods and nothing else. Verification never goes back into either.
- A ride charged the unclosed cap can be claimed against once, with a BD1 signed
  by the passenger (`protocol/dispute.mjs`, migration 0012). The claim is priced
  at the distance the passenger's own phone recorded, so the refund can never
  exceed the cap minus the boarding charge — and a refused claim is final, or the
  reading gets tuned until it pays.
- The passenger tap window (`TAP_MAX_AGE_S`, 300 s) is duplicated in SQL, in
  `settle_leg()`. A door that accepts a tap the backend will refuse strands the
  fare; change both together.
- A metered leg may take a wallet down to `-OVERDRAFT_NPR` (Rs 50,
  `protocol/policy.mjs`), enforced in SQL by `settle_leg()` and the passengers
  balance check (migration 0018). The column default must equal the constant;
  `proof:legs` checks it. The stage-fare path still stops at zero.
- Money moves on `wallet_for(key)`, never on the key a ticket, receipt or claim
  names: since daily keys (0016) that key is a pseudonym with no money behind it.
  `settle_leg()`, `settle_fare()` and `file_dispute()` all follow this (0022).
- Every `admin_*` SQL function checks `is_platform_admin()` itself and returns
  `not_admin` otherwise — or, for the staff work a reviewer does (onboarding,
  buses, papers, routes), `is_reviewer()` and `not_reviewer`. Never grant a
  table to `authenticated` to make an admin screen work; add a function.
  `proof:legs` section 34 finds every `admin_*` and `review_*` function in the
  catalogue and calls it as an owner, a rider and nobody.
- A bus's fares belong to whoever owned it when it carried them: ownership is
  dated in `vehicle_owners` and changed only by `set_vehicle_owner()` (0034);
  party balances read it through `fare_party()`. Never write
  `vehicles.owner_member` directly.
- A login joins a wallet only through an AL1 signed by the wallet, verified in
  `settleBatch()` against the caller's access token (`protocol/account.mjs`).
- A gateway top-up is credited only by `gateway_complete_topup()`, after the
  payments function has checked the gateway's signature and its status API for
  this reference and this amount. Top-up is eSewa only (migration 0024); adding a
  wallet back means changing `request_topup()`, `gateway_open_topup()`, the
  payments function and the top-up screen together.
- The operator, account and admin portals live in `src/portals/` and use `op-`
  classes only; `.panel`, `.card` and `.chip` belong to the meter console and
  load globally.
- A clean trip pays its crew Rs 50 (`CLEAN_TRIP_BONUS_NPR`), once. The evidence
  is counted in SQL (`trip_evidence()`), judged in `cleanTripVerdict()`
  (`protocol/crew.mjs`) and paid by `award_clean_trip()` — never re-implement
  what makes a trip clean in SQL. The bonus moves on `wallet_for(crewKey)` like
  every other rupee, and is taken out of the operator's fare payable rather than
  minted: `crew_bonuses` is both sides of that in one row (migration 0025).
- A CR1 sign-on is checked twice with two windows: `SIGNON_MAX_AGE_S` (300 s) at
  the console, where a screenshot could be held up to a camera, and
  `SHIFT_MAX_AGE_S` (14 h) at the backend, because one sign-on covers a whole
  shift's trips.
- `power_lost` goes in `meter_events`, never in `door_events`: the door tape is
  the interlock record a regulator reads. The rule for when a charger going away
  is a pulled plug is `assessPower()` in `protocol/crew.mjs`, held by
  `proof:meter` — a parked bus loses the same socket and must not raise it.
- The odometer's accuracy claims come from `proof:meter`. Retune `FUSION` only
  against that proof, and replay real traces with `npm run trace:replay`.
- The Pi door validator (`validator/`) runs `src/device/terminal.js` unchanged:
  `validator/loader.mjs` swaps only `storage/db`, `device/link`, `device/nfc` and
  `device/positioning` for Pi adapters. Never copy door logic into `validator/`;
  a change to `terminal.js` is a change to the validator, and `proof:validator`
  holds it. The validator refuses before the door is asked when no clock source
  is trusted, and loads a pairing code through its scanner only while it has no
  key. No GPIO pin drives a door.
