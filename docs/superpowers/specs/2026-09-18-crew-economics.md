# Crew economics: the clean-trip bonus and the power tamper

Approved 18 Sep 2026.

## Why

A metered fare system takes something away from a conductor. Under cash, an
uncounted passenger is the conductor's own money; under Bhada every boarding
runs through a door terminal and there is nothing left to skim. The mentor
review's Round 3 point is that a system which only takes is a system the crew
will defeat, and the cheapest way to defeat it is to reach under the seat and
pull the meter's power.

So two things, together. The pull has to leave a mark, and the honest trip has
to pay.

## The mark: `power_lost`

The meter phone runs off the bus's 12 V supply. The Battery Status API will not
say how hot the phone is — `watchPower()` in `src/device/positioning.js` already
works around that — but it does say whether the phone is charging, and a meter
that stops charging while the bus is working is a meter whose feed was pulled.

- `charging` false for `POWER_GRACE_S` (120 s) while a trip is open and the
  odometer has moved inside `POWER_MOVING_WINDOW_S` (600 s) raises `power_lost`.
- Charging again raises `power_restored`.
- Both land in a new `meter_events` table, not in `door_events`: the door tape is
  the interlock record a regulator reads and it should stay about doors.

A bus parked with the ignition off loses the same socket, which is why the
odometer window is in the condition: no movement, no event. It is still a score
and not an accusation — nothing refuses a settlement over it.

## The pay: Rs 50 a clean trip

Flat, not a percentage, because a conductor can hold a flat number in their head
and argue about it. `CLEAN_TRIP_BONUS_NPR = 50` in `protocol/policy.mjs`.

A trip is clean when all four hold:

1. at least `CLEAN_TRIP_MIN_LEGS` (5) legs settled on it — a bonus for a trip
   that carried nobody is free money;
2. no `power_lost` event on the trip;
3. no `override_on` door event on the trip — the override is the one way past
   the capacity interlock;
4. no leg on the trip scored `plausibility = 'high'`.

Legs priced at the unclosed cap are deliberately **not** in the list. A tap-out
is the passenger's to give and a crew cannot make a flat phone produce one;
docking the crew for it would teach them to refuse boarding to anyone whose
battery looks low.

## Where the money comes from

Bhada holds passenger balances and owes the operator the fares their vehicles
collected. The bonus is not minted: it is Rs 50 moved out of that payable and
into the crew member's wallet. `crew_bonuses` records both sides in one row, and
the operator dashboard shows fares less bonuses.

## Who the crew is

There is no crew identity in the schema today — a vehicle is its own conductor
id. Rather than invent an employee record, the crew member holds an ordinary
Bhada wallet, the same one they ride on, and signs on at the meter console with
a **CR1** token their phone signs: their key, the vehicle, the minute. It is the
mirror of the passenger's BT1 tap. A tap is consent to be charged; a sign-on is
consent to be credited and named on the trip.

The credit lands on `wallet_for(crewKey)`, never on the key CR1 names, because
since daily pseudonyms (0016) that key may be a day key with no money behind it.

## Surfaces

- Meter console: a crew strip — who is signed on, sign on by paste or NFC, sign
  off. Power state is already on the console; `power_lost` joins the event log.
- Operator portal: bonuses paid this week, and the tamper events behind any trip
  that missed one. A crew that loses a bonus should be able to see why.

## Proofs

- `proof:meter` — the power watcher: grace period, the parked-bus case, restore.
- `proof:legs` — CR1 sign-on and its refusals, the four clean-trip conditions
  one at a time, once-only award, the money conservation (crew credit equals
  operator debit), and that a bonus never moves on the key CR1 names when that
  key is a pseudonym.
