# Bhada — भाडा

**Bus fares by distance. Even without a signal.**

Kathmandu buses charge by stage: the conductor names a price, the passenger argues, and
nobody can check either side. Bhada measures the ride instead. The passenger shows a code at
the door, the bus counts the kilometres, and at the exit the passenger gets a signed receipt
with the distance and the fare. All of this works with no internet. The fare is charged later,
when a device on the bus gets a connection and syncs.

- Live: [bhada-one.vercel.app](https://bhada-one.vercel.app)
- Engineering record (the meter, the signed formats, the proofs): [docs/engineering.md](docs/engineering.md)

---

## What a ride looks like

**Passenger**

1. Opens Bhada and taps **चढ्नुहोस्** (get on). The phone shows a ride code: a QR signed by a
   key that never leaves the phone, renewed every 30 seconds.
2. Shows it at the door. The door checks the signature, opens the ride and gives back a
   boarding pass. Nothing is charged yet.
3. Rides. The phone runs the same odometer the bus runs, so the passenger can see the distance
   and the fare so far, and has their own reading to compare.
4. Gets off and shows the code again. The door closes the ride at the bus's distance and shows
   a signed receipt. The phone scans it, checks the arithmetic against the tariff the receipt
   names, and keeps it. The receipt says **Ride verified** and **Payment pending**.
5. When the bus syncs, the fare is taken from the passenger's ride balance. The statement in
   the app shows it once it has been.

**Conductor (Bhada Crew)**

The conductor's phone is the bus's meter and its door. Its home screen shows one trip at a
glance: distance, fares this trip, passengers against the permitted capacity, GPS state and
whether anything is waiting to upload. Big buttons board or exit a passenger, sell a cash or
stage ticket, and end the trip. When the bus is full the door refuses the next boarding.

**Owner (Bhada Owner)**

Today's fares recorded, rides, buses reporting and what is ready to pay out; each bus with its
route, papers and phone; money by day; people; papers; reports.

---

## What works today, what is simulated, what is not built

Be precise about this when you present it.

**Built and proven** (held by the five proofs below):

- Offline QR exchange between the passenger's phone and the door, with signatures checked on
  both sides.
- Signed ride records and receipts, stored on the device (IndexedDB on phones, SQLite on the
  Pi) and uploaded when a connection returns.
- Distance-based fares, with every receipt re-priced under the tariff it names.
- Settlement on the backend: a ride is charged only with the passenger's own signed boarding
  tap on file, once, whatever order the uploads arrive in.
- Replay refusal: a code is accepted once and only for five minutes.
- The capacity interlock, the clean-trip crew bonus, the power-loss record, dead-phone claims.
- The Raspberry Pi door validator, in software, against simulated parts.

**Simulated or sample, and labelled as such in the apps:**

- The fleet map and route explorer. Bus positions are generated in the browser
  (`src/lib/fleet-simulator.js`), and the operators on it are made-up demo names. Tagged
  **Demo fleet** / **Simulated**.
- The owner's fraud audit page. Every row is sample data. Tagged **Sample data**.
- The bench drive on the Crew meter feeds scripted GPS fixes. Shown as **Simulated** when on.

**Not proven yet:**

- **Real GPS on a moving bus.** The meter is proven on simulated roads; `npm run trace:replay`
  is how recorded traces will be scored.
- **The Pi validator on its actual parts.**
- **The door counter.** No break-beam or optical counter is wired to a bus.
- **The payment partner agreement** (see Money).

**How devices talk.** The passenger's phone and the bus exchange data only by QR (and NFC tap
on Android Chrome). Offline devices do not share a live database. The phone's meter and door
talk to each other inside one browser, and over Supabase Realtime when online; a Pi validator
hears a meter box over RS-485. When a connection returns, each device uploads its own signed
records and the backend reconciles them.

What each kind of fraud is met with, row by row and with status, is in
[docs/PAYMENT_BREACH_MATRIX.md](docs/PAYMENT_BREACH_MATRIX.md).

---

## Money

**Bhada is not a bank or a wallet provider and does not hold anyone's money.** Holding customer
funds needs a Payment Service Provider licence from Nepal Rastra Bank (Payment and Settlement Act
2075). The model is:

- **Bhada** measures rides, prices them, keeps the signed records and the ledger of who owes
  whom, and reports to operators.
- **A licensed payment partner** holds the funds, takes top-ups and makes payouts. Top-ups go
  through eSewa today. Bhada's payout is an instruction to the partner, marked paid with the
  partner's reference.

The partner agreement has not been signed. Until it is, the live site runs on eSewa's test
merchant and must not take real money.

**The ride balance.** What the passenger sees is their balance on Bhada's ledger, read from the
phone so it shows offline. A metered ride may leave a passenger up to Rs 50 short
(`OVERDRAFT_NPR`, enforced in SQL); the next top-up clears it. Stage-fare tickets stop at zero.
This allowance is open to every account today and has no identity check: decide whether to keep
it before going live.

**The crew bonus.** A trip whose door count matches the rides on record pays its crew Rs 50,
once. It is taken out of the operator's fare payable, not out of any passenger's fare.

**What Bhada earns.** No commission on fares. A monthly fee per bus that ran that month, a flat
top-up fee and a flat payout fee. All start at Rs 0 and are set by a platform admin as dated
rows that are never edited.

**Who is owed.** A company can run its own buses and buses owned by members. Each is paid for
the fares its buses carried on the days it owned them, less refunds, crew bonuses, the company
levy and fees.

---

## The apps

One repository, one Supabase backend, five builds. Each has its own bundle, service worker and
on-device database, and they talk to each other only through the API.

| App | Path | For | Main screens |
| --- | --- | --- | --- |
| **Bhada** | `/app` | Passengers | Home (current ride or get on), ride code, receipts, routes (demo fleet), stage tickets, account and eSewa top-up |
| **Bhada Crew** | `/crew` | Conductors | Trip (meter with the glance on top), tickets, door, shift. Set up once by scanning a code from the owner |
| **Bhada Owner** | `/owner` | Company owners, managers, bus owners | Today, buses, money, people, papers, reports, agreements; demo fleet map and sample audit from Today |
| **Bhada Staff** | `/staff` | Bhada's onboarding officers, reviewers, admins | Companies, buses from their papers, paper review, routes, payouts, rates |
| Site | `/` | Everyone | Landing page and tour; `/inspect` (inspector's offline check), `/admin`, `/demo` |

Rider, Crew and Owner install as PWAs, keep working offline, and sync by themselves when a
signal returns.

---

## How a company joins

Companies are onboarded by Bhada staff in person; they do not sign themselves up.

1. **Agreements:** service agreement, payout mandate, data consent notice. Signed on paper and
   scanned, or accepted in the app, or both.
2. **Company papers:** registration, PAN/VAT, tax clearance, directors' citizenship, DoTM
   registration, each checked by a reviewer.
3. **Buses from their papers:** staff enter each bus from its bluebook and route permit. The
   permitted capacity is what the door interlock enforces.
4. **People:** the owner invites managers, conductors and bus owners by code.
5. **Live:** a platform admin takes the company live; payouts open then. Fares settle from the
   first ride either way.

Background and sources: [docs/legal/2026-10-03-onboarding-research.md](docs/legal/2026-10-03-onboarding-research.md).

---

## Proofs and tests

Nothing in `protocol/` counts as changed until all five proofs pass. Vercel will not deploy a
build whose proofs fail.

| Command | What it holds |
| --- | --- |
| `npm run proof` | The offline stage-fare handshake |
| `npm run proof:meter` | Odometer accuracy on simulated roads at every traffic speed; fares over 400 random rides; the tariff promise; taps, doors, frame |
| `npm run proof:reconcile` | Stage-fare settlement on real Postgres (PGlite) |
| `npm run proof:legs` | Every migration, metered settlement, tap consent, replay, unclosed rides, dead-phone claims, roles, money by party, papers, onboarding, and a sweep of every staff function |
| `npm run proof:validator` | The Pi door validator in software: scanner, card reader, clock, RS-485, screens, power |
| `npm run proof:all` | All five |
| `npm test` | UI unit tests |

---

## Running it locally

Needs Node 20+.

```bash
npm install
npm run sync:local        # local backend on :8787, every migration on PGlite, demo logins seeded
BHADA_LOCAL_DB=1 VITE_SYNC_URL=http://localhost:8787/sync BHADA_HTTP=1 npm run dev
# open http://localhost:5199 — it serves /, /app, /crew, /owner and /staff
```

**`.env.local` points at the live backend.** Always override `VITE_SYNC_URL` as above when
testing, or test rides upload to production.

Local demo logins (password `bhada-demo-2026`, local backend only):

| Login | Is |
| --- | --- |
| `owner@demo.bhada.np` | Owner of Mayur Yatayat (live, three buses) |
| `manager@demo.bhada.np` | Its manager |
| `busowner@demo.bhada.np` | A bus owner, owning BA2KHA7003 |
| `conductor@demo.bhada.np` | A conductor on BA2KHA7001 |
| `reviewer@demo.bhada.np` | Bhada staff, reviewer |
| `admin@demo.bhada.np` | Bhada staff, platform admin |
| `rider@demo.bhada.np` | A passenger |

Delete `.pgdata` and `.pgdata-files` to start again from nothing.

---

## A demo in five minutes

1. **Landing (`/`)** — the one-line pitch and the phone showing a ride.
2. **Crew (`/crew`)** — choose the demo bus. The trip screen shows distance, fares, passengers
   against capacity. Open *Engineering, inspection and bench controls* and start the **bench
   drive** (simulated GPS) so the kilometres move.
3. **Passenger (`/app`, a second phone or window)** — tap **चढ्नुहोस्**, show the code to the
   Crew **ढोका** (door) tab. Passengers goes up by one; the rider's home turns into the journey
   card.
4. Turn the network off on both. Keep riding; the distance and fare keep moving.
5. Show the code again at the door to get off. The door shows the receipt; scan it on the
   passenger phone: **Ride completed**, distance, final fare, **Ride verified**, **Payment
   pending**.
6. Turn the network back on. The Crew sync pill clears; the fare settles on the backend.
7. **Owner (`/owner`)** — today's fares and rides, the bus, money. Then the demo fleet map and
   the sample audit from Today, both labelled as demo.

---

## Deploying

Release order: **database, then functions, then the site.**

```bash
supabase db push
npm run sync:protocol
supabase functions deploy sync --no-verify-jwt    # buses upload without a login; signatures authorise them
supabase functions deploy payments
vercel --prod                                     # runs npm run proof:all && npm run build
```

Once, on a new backend: make the first platform admin in SQL
(`insert into platform_admins (user_id) select id from auth.users where email = '…';`), publish
the real agreement texts from **Staff → Rates**, set the payments secrets (`ESEWA_ENV`,
`ESEWA_PRODUCT_CODE`, `ESEWA_SECRET_KEY`, `SITE_URL`), unset `SIGNUP_CREDIT_NPR` before real
money, and set the Supabase Auth site URL. Rollbacks and key rotation: [docs/RUNBOOK.md](docs/RUNBOOK.md).

---

## Where things are

```
protocol/            platform-free ESM shared by the apps, the Edge Function and the proofs
supabase/migrations  the schema; every money rule is enforced here
supabase/functions   sync (settlement through settleBatch) and payments (eSewa)
src/apps/            rider, crew, owner, staff
src/ui/              the UI kit and design tokens every app uses
src/screens/         the ride card, meter, door and conductor screens
src/device/          the meter, the door, sync and the on-device stores
src/pages/           landing page and tour
validator/           the Raspberry Pi door validator (runs src/device/terminal.js unchanged)
scripts/             the proofs, the local backend, builds
docs/                engineering record, breach matrix, legal research, specs, runbook
```

Rules that are easy to break are in [AGENTS.md](AGENTS.md). Read it before touching anything
that moves money.

## Licence

MIT.
