# Bhada — fraud and breach matrix

Ten ways someone could cheat a bus fare system in Kathmandu, and what Bhada does
about each **today**. Every row says whether the defence is built and proven,
built but not proven on real hardware, or only designed. Where a defence is not
built, the row says so; do not quote this document as if it were.

Status key:

- **Proven**: built, and held by one of the five proofs (`npm run proof:all`).
- **Built**: in the code, but not yet tried on real buses or real hardware.
- **Designed**: an idea with no code behind it yet.
- **Open**: a known gap.

| # | Threat | Who | What Bhada does today | Status |
| :-: | :-- | :-- | :-- | :-- |
| 01 | **Tap in, never tap out.** Rides 16 km, slips out of the back door. | Passenger | A ride left open at the end of a trip is charged the unclosed-ride fare, which is the tariff cap (Rs 25 on the current tariff, half for concessions). A passenger whose phone died can claim back the difference once, priced at the distance their own phone signed (BD1, migration 0012); a refused claim is final. There is **no Rs 50 hold at tap-in and no refund at exit**. `calculateExitReconciliation()` in `protocol/policy.mjs` only computes a figure for display; no money is held or returned. | Proven (cap, claim) |
| 02 | **Screenshot of a ride code** sent to a friend. | Passenger | The ride code (BT1) is signed by the passenger's key and re-signed every 30 s. A door takes each code once (its nonce is remembered) and only within `TAP_MAX_AGE_S` (300 s), which is duplicated in SQL in `settle_leg()`. A second tap by someone already on board is read as getting off, not as a second boarding. The extra "already riding" check added to `board()` in `src/device/terminal.js` is never reached, because `present()` routes an open rider to tap-out first. | Proven (nonce, window) |
| 03 | **Phone clock moved back** to revive an old code. | Passenger | The door judges a code by its own clock, not the phone's, and refuses codes outside the window. The Pi validator refuses every tap when no clock source is trusted (DS3231 RTC or network time). A phone door uses its own phone clock and records the skew it sees. | Proven in software; RTC not tried on real parts |
| 04 | **Edited balance** in the browser's storage. | Passenger | The balance on the phone is a display. Money moves only in `settle_leg()` on the backend, on `wallet_for(key)`, against the backend's own balance. The door never checks a balance. There are no server-signed "pass vouchers". | Proven |
| 05 | **Burner accounts** to ride on the short allowance and walk away. | Passenger | Any account may go Rs 50 below zero on a metered ride (`OVERDRAFT_NPR`, enforced in SQL). There is **no KYC gate**: `isOverdraftAllowed()` in `protocol/policy.mjs` is not called anywhere. New wallets on the live backend get a demo signup credit (`SIGNUP_CREDIT_NPR`) that must be unset before real money. | Open |
| 06 | **Conductor pockets cash** and issues no ticket. | Conductor | The meter compares the door count with the rides and cash tickets on record. A trip whose count matches pays the crew a flat Rs 50 clean-trip bonus once (`cleanTripVerdict()`, `award_clean_trip()`), taken from the operator's fare payable. The door count comes from a counter input; **no break-beam or optical counter is wired to a bus yet**. | Proven (rule); counter hardware not built |
| 07 | **Meter unplugged** to claim a broken machine. | Conductor | When the charger goes away while the bus is moving, the meter files `power_lost` in `meter_events` (never on the door tape) and the trip misses the bonus. A parked bus losing the same socket does not raise it (`assessPower()`). There is **no supercapacitor watchdog** or signed last-gasp event. | Proven (rule) |
| 08 | **Invented trips** to claim fares or subsidy. | Owner | A metered ride never settles without the passenger's own signed BT1 tap on file (`leg_taps`, migration 0008). The odometer rejects fixes implying more than 120 km/h and other implausible jumps (`FUSION` in `protocol/meter.mjs`). | Proven |
| 09 | **Days offline** fill the device. | System | Phones keep rides in IndexedDB, the Pi in SQLite, and both upload in the same signed batches when a signal returns. Nothing is deleted until the backend has ruled on it; the Pi keeps settled rides for 14 days then prunes them. There is **no Merkle hash chain**. | Proven (Pi store and upload) |
| 10 | **Owner does not pay** the monthly fee. | Owner | The per-bus monthly app fee is deducted from the owner's payout under the signed payout mandate (migration 0035). Payouts themselves are carried out by the licensed payment partner; Bhada keeps the ledger. Every fee starts at Rs 0 until an admin sets one. | Proven (ledger) |

## What would change these rows

- Rows 03, 06 and 07 move to *Proven* only after the Pi validator and a door
  counter have run on a real bus.
- Row 05 needs a decision: gate the short allowance on a verified identity, or
  remove it. Both are a migration plus a `proof:legs` section, not a UI change.
- Row 01's display-only reconciliation in `src/device/terminal.js` and the
  "corridor hold" lines on the door screen (`src/screens/Terminal.jsx`) should be
  removed, since they describe money that never moves.
