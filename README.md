# Bhada — भाडा

**Transparent bus fares for Kathmandu, even without internet.**

Bhada is an offline-first, hybrid fare and ride-verification system for public buses. It
digitises the stage fare system Kathmandu buses already use. It does not invent a new fare.

> Bhada digitises the existing stage-based bus fare system. GPS verifies the journey, Bhada
> identifies the boarding and exit stages, applies the configured fare rule, and creates a
> signed receipt even when the bus is offline.

- Live: [bhada-one.vercel.app](https://bhada-one.vercel.app)
- Engineering record: [docs/engineering.md](docs/engineering.md)
- Fraud matrix, with what is and is not built: [docs/PAYMENT_BREACH_MATRIX.md](docs/PAYMENT_BREACH_MATRIX.md)

---

## The problem

On a Kathmandu bus the fare depends on the stage you got on at and the stage you got off at.
In practice the conductor names a price, the passenger argues, cash changes hands and nobody
gets a receipt. The owner has to trust whatever cash comes back. Signal drops under flyovers
and in traffic, so an app that needs the internet at the door does not work.

## What Bhada does

```
BUS GPS ─► ROUTE + STAGE ─► BOARDING STAGE ─► JOURNEY ─► EXIT STAGE
        ─► FARE TABLE ─► FARE ─► SIGNED RECEIPT ─► SAVED OFFLINE
        ─► CONNECTION RETURNS ─► SYNC ─► RECONCILED
```

- **GPS is the measurement layer.** It finds where the bus is on its route, which stage a
  passenger got on at and which stage they got off at. It also records the journey (distance,
  time) as evidence.
- **The fare table is the pricing layer.** The fare is the table's amount from the boarding
  stage to the exit stage. The distance travelled is shown on the receipt but does not set the
  price.
- **Offline first, online later.** The ride, the fare and the signed receipt are all made with
  no internet. Synchronisation, reconciliation, reports and payment settlement happen when a
  connection returns.

**Offline doesn't mean unaccounted. It means not settled yet.**

---

## A ride, step by step

**Passenger (Bhada app, `/app`)**

1. Taps **चढ्नुहोस्** and shows the ride code at the door. The code is a QR signed by a key
   that never leaves the phone, renewed every 30 seconds.
2. The conductor's phone scans it and the ride opens. Nothing is charged yet. The bus's GPS
   records the **boarding stage**.
3. During the ride the phone shows **Boarded · Now at · Fare so far** in stages. The
   distance shows underneath as journey information. All of this works offline.
4. To get off, the passenger shows the code again. The door finds the **exit stage**, takes the
   fare from the fare table and signs a receipt (**Ride verified**, **Payment pending**). The
   phone scans it and keeps it.
5. When the bus syncs, the fare is taken from the passenger's ride balance and the statement
   shows it.

**Conductor (Bhada Crew, `/crew`)**

Built for someone holding a rail on a moving bus, in Nepali first. The trip screen shows the
**current stage**, the fares this trip and passengers against the permitted capacity (बस भरियो
when full). Below them are two big buttons:

- **स्क्यान गर्नुहोस्**: scan the passenger's code. The phone knows whether they are getting
  on or off.
- **नगद यात्रु**: a passenger paying cash.

The shift screen signs the conductor on with one tap. When the bus is full, the door refuses
the next boarding. Everything else is folded under *थप विवरण · More*: who is aboard (boarded
stage, current stage, the fare if they got off here), the door interlock, rider cards, history
and engineering.

**Owner (Bhada Owner, `/owner`)**

Today's fares, rides, buses reporting and what is ready to pay out. Below that: each bus with
its route, papers and phone, then money by day, people, papers and reports. The owner no
longer has to take the cash count on trust.

---

## Fares

- A ride is priced from **boarding stage + exit stage + route + fare table version**.
- The current table is `R11-STAGE-DEMO-1` for route R11, Ratna Park to Koteshwor, seven
  stages. **It is a demo fare table, not a published one.** Its rule: Rs 15 to the next
  stage, Rs 5 for each stage after, at most Rs 25. Students and seniors pay half, rounded up.
- **Fare tables are added, never edited.** When official fares change, a new table is
  published under a new code. Every receipt names its table and is re-priced with that one,
  so old rides stay auditable.
- **Where the stages come from.** The boarding stage is the stage nearest the door's GPS fix
  when the passenger got on, which is signed into their boarding pass. The exit stage is the
  stage nearest the door's fix when they get off. With no fix at exit, it is the stage the
  measured distance reaches from the boarding stage. If that is ambiguous, or there was no GPS
  stage at boarding, the ride falls back to the older distance tariff, and the receipt says so.
- A stage receipt is a **BM2**: a BM1 that also signs both stage codes, so a stage cannot be
  changed after the bus signed it. Receipts issued before stage fares stay BM1 and keep
  verifying.
- Bhada makes no claim of government approval. It supports prescribed fare tables, and the
  real table is loaded when an operator provides it.

The stage-ticket path (BH1: the passenger picks stops, the conductor scans) also prices from
a stop-to-stop fare table (`fares`, route R11), cached on the phone for offline use.

---

## How it is built

### Stack

| Layer | What |
| --- | --- |
| Apps | React 19 + Vite 7, five builds (site, rider, crew, owner, staff), installable PWAs (vite-plugin-pwa) with their own service worker and manifest |
| On the device | IndexedDB (`idb`) for rides, receipts, keys and the outbox; the phone's GPS through the browser's Geolocation API; the camera for QR scanning (`jsqr`); Web NFC on Android Chrome; screen wake lock while riding |
| Signing | Ed25519 (`tweetnacl`); every code below is a signed, `\|`-separated text string carried in a QR |
| Backend | Supabase Postgres: 39 numbered migrations with row-level security, every money rule enforced in SQL functions; Edge Functions `sync` (settlement) and `payments` (eSewa) |
| Shared logic | `protocol/`: platform-free ESM used by the apps, the Edge Function and the proofs. The Edge Function's copy is generated (`npm run sync:protocol`), never edited by hand |
| Proofs | Node scripts; Postgres runs in-process with PGlite, so settlement is proven on a real database without a server |
| Maps | Leaflet with OpenStreetMap data and CARTO basemap tiles (free, no key) |
| Hosting | Vercel (the static site, deployed from GitHub `main`), Supabase (database and functions) |

### Architecture

```
                 ┌───────────────────────────┐
                 │ Fare table (tariff code)  │   protocol/meter.mjs + tariffs table
                 └─────────────┬─────────────┘
                               │
  GPS ─► route position ─► stage at boarding / stage at exit ─► fare
                               │
                     signed ride record (BM2)
                    ┌──────────┴──────────┐
               passenger phone        conductor phone (meter + door)
                    └──────────┬──────────┘
                   on-device store + outbox (offline)
                               │   connection returns
                        sync Edge Function
                               │   settleBatch(): verify signatures, taps, fares
                        Postgres settle_leg()  ─►  ledger, owner reports, payouts
```

### The signed codes

Every exchange between devices is a signed code shown as a QR, and each one is checked where
it lands, offline.

| Code | Signed by | What it says |
| --- | --- | --- |
| **BT1** ride code | Passenger | "I am getting on this bus now." Re-signed every 30 s, valid for 5 minutes, each one accepted once. Nothing settles without it (the tap on file) |
| **BG1** family code | Passenger | Up to several BT1s on one phone: a parent riding with children |
| **BO1** boarding pass | Bus | The ride is open: the leg id, the boarding odometer and the GPS position at the door. It lets a passenger get off at any door, with or without signal |
| **BM1 / BM2** receipt | Bus | The closed ride: distance, times, fare and tariff code. BM2 also signs the boarding and exit stages |
| **CT1** cash ticket | Bus | A cash fare recorded at the door |
| **BH1** stage ticket | Passenger | The stage-ticket path: boarding and alighting stop and the fare, scanned by the conductor |
| **BD1** claim | Passenger | "My phone died on this ride": the last distance and position the phone recorded |
| **CR1** sign-on | Conductor | The conductor is on this bus for this shift (the crew bonus follows this key) |
| **RS1** roster | Bus | Who is aboard, for an inspector's offline check |
| **AL1** account link | Passenger | Joins this phone's key to a login |
| **PK1** daily key link | Passenger | Ties a day's pseudonym key to the account, so an operator cannot follow a rider across days |
| **AT1** attestation | Issuer | A student or senior concession card |
| `BHSETUP1`, `BHPAIR1`, `BHJOIN1` | Owner / meter | Bus phone setup, door pairing, invitations |

### What happens at the door, in order

1. **Get on.** The door verifies the BT1 (signature, this bus, fresh, never seen) and checks
   capacity; the meter refuses when the bus is full. It records the stage from its GPS and
   issues a BO1 pass that carries the boarding position. The ride is written to the door's
   store and announced to the meter.
2. **Ride.** The meter integrates GPS fixes into an odometer, rejecting bad fixes and
   impossible speeds. The passenger's phone runs the same odometer for a second opinion and
   finds its own stage.
3. **Get off.** The door matches the passenger to their open ride, measures the journey, finds
   the exit stage, prices the stage pair from the fare table, and signs a BM2 receipt. The
   receipt goes on screen as a QR for the passenger and into the outbox.
4. **Nobody taps out.** At the end of the trip, the meter closes any ride still open at the
   route cap (the unclosed fare). The passenger can claim against it with a BD1.

### Sync and settlement

- Each device keeps an **outbox**. When a signal appears, a sync pill shows how many items are
  waiting and sends them by itself; nobody presses "send".
- The `sync` Edge Function passes each batch to **`settleBatch()`**
  (`protocol/settle.mjs`), the only place a batch is verified. It checks the bus's signature,
  re-prices the receipt with the tariff it names, requires the passenger's own BT1 tap, and
  refuses replays.
- **`settle_leg()`** in Postgres moves the money on the rider's account
  (`wallet_for(key)`), once. A receipt sent twice is a replay, not a second charge.
- Anything a newer client sends that the backend does not understand yet stays queued on the
  device rather than being lost.

### Data kept

- **On the passenger's phone:** their key, daily pseudonym keys, ride codes, the current ride
  (stages, distance, time), receipts and any claims. Nothing leaves the phone except through
  sync.
- **On the bus phone:** the bus key, open and closed rides, cash tickets, the door tape, and
  the outbox.
- **In Postgres:** settled legs, taps, tariffs and fare tables, accounts, operators, buses,
  papers, agreements, payouts and fees.

---

## Money

**Bhada is not a bank or a wallet provider and does not hold anyone's money.** Holding
customer funds needs a Payment Service Provider licence from Nepal Rastra Bank (Payment and
Settlement Act 2075).

| Bhada | The licensed payment partner |
| --- | --- |
| Finds stages, prices rides, signs receipts | Holds customer funds |
| Stores rides offline, syncs, reconciles | Takes top-ups (eSewa today) |
| Keeps the ledger of who owes whom | Moves money and makes payouts |
| Reports to operators | Settles |

A payout is Bhada's instruction to the partner, marked paid with the partner's reference.
**The partner agreement has not been signed.** The live site runs on eSewa's test merchant
and must not take real money until it is.

- **Payment states.** A ride is *Ride verified* the moment the door signs it. It is *Payment
  pending* until the bus syncs, then *Settled*. Rides are completed and verified offline;
  payment is reconciled online.
- **Ride balance.** What the passenger sees is their balance on Bhada's ledger. A metered ride
  may leave a passenger up to Rs 50 short (`OVERDRAFT_NPR`, enforced in SQL), and the next
  top-up clears it. This allowance is open to every account and has no identity check, so
  decide before going live whether to keep it.
- **Crew bonus.** A trip whose door count matches the rides on record pays its crew Rs 50,
  once. It comes out of the operator's fare payable, never out of a passenger's fare.
- **What Bhada earns.** No commission on fares. It charges a monthly fee per bus that ran, a
  flat top-up fee and a flat payout fee. All start at Rs 0 until an admin sets them.

---

## What is real, what is simulated, what is not built

**Built and proven** (by the five proofs below):

- Offline QR exchange between the passenger's phone and the door; NFC tap on Android Chrome.
- Stage pricing: all 49 stage pairs, both directions, concessions; BM2 receipts verify and a
  changed stage or fare is refused; a stage ride settles on Postgres under its tariff row.
- Signed receipts stored on the device (IndexedDB on phones, SQLite on the Pi), uploaded later.
- Settlement charges a ride only with the passenger's own signed boarding tap, and only once.
- Replay refusal, the capacity interlock, the clean-trip crew bonus, the power-loss record,
  and dead-phone claims.
- The Raspberry Pi door validator, in software, against simulated parts.

**Simulated or sample, and labelled in the apps:**

- The fleet map and the buses on the route screens: positions are generated in the browser
  (`src/lib/fleet-simulator.js`). They move live, but the data is synthetic and the operator
  names are made-up demo names. Tagged **Demo fleet** / **Simulated**.
- The owner's fraud audit page: every row is sample data. Tagged **Sample data**.
- The fare tables (`R11-STAGE-DEMO-1` and the route calculator's rule): **Demo fare table**.
- The Crew bench drive: scripted GPS fixes along the route.

**Not built or not proven:**

- Real GPS from a moving bus: proven on simulated roads only; `npm run trace:replay` is
  how recorded traces will be scored.
- The Pi validator on its real parts.
- A door counter (break-beam or optical) wired to a bus.
- The payment partner agreement.
- Runtime fare-table editing by an admin. Today a new table is a new tariff code in
  `protocol/meter.mjs` plus a migration.
- Owner trip details by stage. Stages are in the signed receipt, not yet in the owner's tables.
- Dead-phone claims are still priced by distance, because a ride nobody closed has no exit
  stage.

**How devices talk.** The passenger's phone and the bus exchange data only by QR, plus NFC
where the phone supports it. Offline devices do not share a live database. On one phone, the
meter and the door talk inside the browser, and over Supabase Realtime when online. A Pi
validator hears a meter box over RS-485. When a connection returns, each device uploads its
own signed records and the backend reconciles them.

---

## The apps

One repository, one Supabase backend, five builds. Every app is light (white, one red, the
Mukta typeface) whatever the phone's dark-mode setting. They all use the same kit in `src/ui`,
and the भाडा mark at the top left always leads back to the front page, which links every app.

| App | Path | For | Main screens |
| --- | --- | --- | --- |
| **Bhada** | `/app` | Passengers | Home (current ride by stage, or get on), ride code, receipts, routes (search by stop, route cards, stops in order, demo buses, map), fare calculator, stage tickets, account and eSewa top-up |
| **Bhada Crew** | `/crew` | Conductors | Trip (current stage, fares, passengers, scan, cash, end trip), tickets, door, shift (one-tap sign-on) |
| **Bhada Owner** | `/owner` | Company owners, managers, bus owners | Today, buses, money, people, papers, reports, agreements; demo fleet map and sample audit from Today |
| **Bhada Staff** | `/staff` | Bhada staff | Companies, buses from their papers, paper review, routes, payouts, rates |
| Site | `/` | Everyone | Front page, how-it-works tour, `/demo` (a simulated trip), `/inspect` (inspector's offline check), `/admin` |

The map uses OpenStreetMap data with CARTO's free basemap tiles. No API key is needed; the
attribution shows on the map.

---

## How a company joins

Bhada staff onboard each company in person; companies do not sign themselves up.

1. **Agreements.** The service agreement, the payout mandate and the data consent notice,
   signed on paper and scanned, accepted in the app, or both.
2. **Company papers.** Registration, PAN/VAT, tax clearance, the directors' citizenship and
   DoTM registration, each checked by a reviewer.
3. **Buses from their papers.** Staff enter each bus from its bluebook and route permit. The
   permitted capacity is what the door interlock enforces.
4. **People.** The owner invites managers, conductors and bus owners by code.
5. **Live.** A platform admin takes the company live and payouts open. Fares settle from the
   first ride either way.

Sources: [docs/legal/2026-10-03-onboarding-research.md](docs/legal/2026-10-03-onboarding-research.md).

---

## Proofs and tests

Nothing in `protocol/` counts as changed until all five proofs pass. Vercel runs them before
every build, and a failing proof stops the deploy.

| Command | What it holds |
| --- | --- |
| `npm run proof` | The offline stage-ticket handshake |
| `npm run proof:meter` | Odometer accuracy on simulated roads; fares over 400 random rides; the stage fare table (49 pairs, symmetry, concessions, stage finding, BM2 receipts); doors; frame |
| `npm run proof:reconcile` | Stage-ticket settlement on real Postgres (PGlite) |
| `npm run proof:legs` | Every migration, metered and stage settlement, tap consent, replay, unclosed rides, dead-phone claims, roles, money, papers, onboarding, and a sweep of every staff function |
| `npm run proof:validator` | The Pi door validator in software |
| `npm run proof:all` | All five |
| `npm test` | UI unit tests |

---

## Running it locally

Needs Node 20+.

```bash
npm install
npm run sync:local        # local backend on :8787: every migration on PGlite, demo logins seeded
BHADA_LOCAL_DB=1 VITE_SYNC_URL=http://localhost:8787/sync BHADA_HTTP=1 npm run dev
# open http://localhost:5199 — it serves /, /app, /crew, /owner and /staff
```

**`.env.local` points at the live backend.** Always override `VITE_SYNC_URL` as above, or test
rides upload to production.

Local demo logins (password `bhada-demo-2026`, local backend only): `owner@`, `manager@`,
`busowner@`, `conductor@`, `reviewer@`, `admin@` and `rider@demo.bhada.np`. Delete `.pgdata`
and `.pgdata-files` to start again.

---

## A five-minute demo

1. **Front page (`/`).** The one-line pitch, *who are you*, how a ride works, and the stage
   fare table marked as a demo.
2. **Crew (`/crew`).** Choose the demo bus. On **सिफ्ट**, tap *Sign on to this bus*. Under
   *Engineering, inspection and bench controls*, start the **bench drive** so the bus moves
   along R11; the trip screen shows the current stage.
3. **Passenger (`/app`, on a second phone or window).** Tap **चढ्नुहोस्**. On Crew, tap
   **स्क्यान गर्नुहोस्** and scan the code. Passengers goes up by one; the rider's home shows
   *Boarded: Ratna Park*.
4. **Go offline** on both. The ride carries on and *Now at* changes stage by stage. The fare
   changes only when the stage does.
5. **Get off.** Scan the code again at the door; the door shows the receipt. Scan it on the
   passenger's phone to see **Ride completed**, boarded and got-off stages, the final fare,
   the fare rule (*Stage 1 → Stage 5*), the journey in km, **Ride verified** and **Payment
   pending**.
6. **Back online.** The sync pill clears and the fare settles once.
7. **Owner (`/owner`).** Today's fares and rides, then the demo fleet map and the sample
   audit, both labelled.
8. **Routes → Fare calculator** on the passenger app, to show any stop-to-stop fare.

---

## Deploying

Release order: **database, then functions, then the site.** The site deploys from GitHub on
every push to `main`, so push a migration or function change to Supabase before pushing the
code that needs it.

```bash
supabase db push
npm run sync:protocol
supabase functions deploy sync --no-verify-jwt    # buses upload without a login; signatures authorise them
supabase functions deploy payments
git push origin main                              # Vercel builds: npm run proof:all && npm run build
```

Once, on a new backend:

- Make the first platform admin in SQL.
- Publish the real agreement texts from **Staff → Rates**.
- Set the payments secrets (`ESEWA_ENV`, `ESEWA_PRODUCT_CODE`, `ESEWA_SECRET_KEY`,
  `SITE_URL`).
- Unset `SIGNUP_CREDIT_NPR` before real money.
- Set the Supabase Auth site URL.

Rollbacks and key rotation: [docs/RUNBOOK.md](docs/RUNBOOK.md).

---

## Where things are

```
protocol/            platform-free ESM: signing, stages and fare tables, the meter, settlement
  stages.mjs         each route's stages in running order
supabase/migrations  the schema; every money rule is enforced here (0039: the stage tariff)
supabase/functions   sync (settlement through settleBatch) and payments (eSewa)
src/apps/            rider, crew, owner, staff
src/ui/              the UI kit and design tokens every app uses
src/screens/         the ride card, meter, door and conductor screens
src/device/          the meter, the door, sync and the on-device stores
src/pages/           front page and tour
validator/           the Raspberry Pi door validator (runs src/device/terminal.js unchanged)
scripts/             the proofs, the local backend, builds
docs/                engineering record, breach matrix, legal research, runbook
```

Rules that are easy to break are in [AGENTS.md](AGENTS.md). Read it before changing anything
that prices a ride or moves money.

## Licence

MIT.
