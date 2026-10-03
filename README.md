# Bhada — भाडा

**Transparent bus fares for Kathmandu, even without internet.**

Bhada is an offline-first, hybrid fare and ride-verification system for public buses. It
digitises the stage fare system Kathmandu buses already use. It does not invent a new fare.

> Bhada digitises the existing stage-based bus fare system. GPS verifies the journey, Bhada
> identifies the boarding and exit stages, applies the configured fare rule, and creates a
> signed receipt even when the bus is offline.

- Live: [bhada-one.vercel.app](https://bhada-one.vercel.app)
- Engineering record (the meter, signed formats, the September audit): [docs/engineering.md](docs/engineering.md)
- How every part is built and connected: [Inside Bhada](#inside-bhada-every-part-and-how-it-connects), below
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
| Maps | Leaflet with OpenStreetMap tiles (free, no key) |
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
- **Ride balance and unpaid fares.** What the passenger sees is their balance on Bhada's ledger.
  The door cannot check a balance offline, so a passenger with too little still rides. When the
  fare is more than the balance, the payment has failed and the passenger owes that fare to the
  bus company: the app shows *Payment failed — रु X owed* and the next top-up clears it. Bhada
  does not lend; it records the unpaid fare. Up to Rs 50 can be owed (`OVERDRAFT_NPR`,
  enforced in SQL); a fare that would go past that is refused at settlement (`insufficient_balance`).
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

The map uses OpenStreetMap's own tiles: free, no API key, attribution shown on the map. That
is fine for a demo's traffic; heavy production use needs our own tile provider under the OSM
tile usage policy.

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

## Running the demo

There are three ways to show Bhada. Pick by what you have.

| Way | Needs | Shows | Time |
| --- | --- | --- | --- |
| **A. The simulated trip** (`/demo`) | One laptop or phone, nothing else | A whole bus trip on one screen: boarding, stages, a full bus, cash, an inspector, sync, settlement | 3 minutes |
| **B. Two phones, local backend** (recommended) | A laptop running the local backend, two phones or two browser windows | The real apps end to end: ride code, scan, stages, offline, receipt, sync, owner | 10 minutes |
| **C. The live site** | Internet | Every screen as a judge would open it | 5 minutes |

### A. The simulated trip (`/demo`)

1. Open `/demo` (live: <https://bhada-one.vercel.app/demo>, or locally after `npm run dev`).
2. Press **Start the bus**. A Postgres backend starts inside the browser; the counter at the
   top shows that nothing goes to the internet.
3. Press **Next** (or Space / →) for each scene: passengers board with ride codes, a family on
   one code, cash riders, the bus fills and the door refuses the next person, people get off
   and each fare comes from the stage table, an inspector checks who is aboard, and at the end
   the bus reaches signal, uploads, and every fare settles once.
4. **← भाडा** at the top goes back to the front page.

Everything on this screen is a simulated bus, and the screen says so.

### B. Two phones on the local backend (recommended)

This is the real system, on your laptop, with nothing touching the live database.

**Set up (once, about 2 minutes)**

```bash
npm ci
npm run demo:phones
```

- The command starts the local backend and all five HTTPS apps, checks readiness, and prints
  the discovered LAN links for Site, Rider, Crew, Owner and Staff. No live service is used.
- Open the printed HTTPS address on the laptop and on phones connected to the same Wi-Fi.
  Accept the local development certificate once, then allow camera and GPS when asked.
- Stop with Ctrl+C. Local database contents and demo credentials are preserved.
- For a presentation on a fresh demo device, open `/crew?presentation=1` and choose
  **Start local presentation**. This selects DEMOBUS01 and starts simulated GPS after that
  explicit action. It is gated to the local backend and refuses a real bus.
- See [debug and automation delivery notes](docs/debug-automation.md) for checks, recovery
  rules, warnings and remaining limits.
- Two browser windows on one laptop also work. Show the passenger's code to the laptop camera,
  or use one phone and one laptop.

**Conductor phone: the bus**

1. Open **/crew**. On the setup screen, choose **the demo bus** (route R11, Ratna Park ↔
   Koteshwor, 42 places).
2. Go to **सिफ्ट (Shift)** and tap **यो बसमा साइन इन · Sign on to this bus**. It shows
   *✓ Signed on*. A clean trip now pays this conductor the bonus.
3. Back on **यात्रा (Trip)**, open *Engineering, inspection and bench controls* at the bottom
   and press **Run bench drive**. The bus now moves along R11 on simulated GPS, marked
   **Simulated**, and *अहिले · Now at* shows the current stage.

**Passenger phone**

4. Open **/app**. Tap **चढ्नुहोस्** to see the ride code, which renews every 30 seconds.
5. On the conductor phone tap **स्क्यान गर्नुहोस्** and point the camera at the passenger's
   code. The door says *चढ्नुभयो · boarded*, the passenger count goes up by one, and the
   passenger keeps the boarding pass shown on the door if asked.
6. On the passenger phone tap **म चढें · I'm on**. Home becomes the journey card:
   **Boarded · Now at · Fare so far**, with the journey in km underneath.

**Offline**

7. Turn off Wi-Fi or mobile data on both phones. The sync pill shows how many items are
   waiting. Nothing else changes: the ride goes on, and *Now at* and the fare change stage by
   stage. The fare only changes when the stage does.

**Getting off**

8. On the conductor phone tap **स्क्यान गर्नुहोस्** again and scan the passenger's code. The
   door shows the fare and a receipt QR.
9. On the passenger phone tap **यात्रा सकियो · Finish ride** and scan the receipt. It shows
   **Ride completed**, the bus, the boarded and got-off stages, the **final fare**, the fare
   rule (for example *Stage 1 → Stage 5*), the journey in km, **Ride verified** and **Payment
   pending**. *Fare breakdown and security details* opens the signed details.

**Cash and a full bus (optional)**

10. **नगद यात्रु** on the trip screen records a cash passenger.
11. In *थप विवरण · More → Door interlock*, lower *Permitted capacity* to the number aboard;
    the next scan is refused with *बस भरियो · Full*.

**Back online**

12. Turn the network back on. Both sync pills clear by themselves. The ride settles once, and
    sending it again would be a replay, not a second charge.
13. **यात्रा सकियो · End trip** on the trip screen closes the trip. Anyone still aboard is
    charged the unclosed fare and can claim it back if their phone died.

**Owner and staff**

14. Open **/owner** and sign in as `owner@demo.bhada.np` / `bhada-demo-2026`. *Today* shows
    fares recorded, rides, buses reporting and what is ready to pay out. Under *Demo screens*
    are the simulated fleet map and the sample fraud audit.
15. Open **/staff** as `admin@demo.bhada.np` / `bhada-demo-2026` to show company onboarding,
    paper review and payouts. The second company, Nilo Yatayat, is waiting to be onboarded.
16. On the passenger app, **मार्गहरू (Routes) → भाडा कति? (Fare calculator)** shows any
    stop-to-stop fare.

### C. The live site

Open <https://bhada-one.vercel.app> and walk through the front page, **/app** (home, routes,
fare calculator, ride code), **/crew**, **/owner** and **/staff** (sign-in screens), and
**/demo**.

- The live site has no demo logins. Owner and staff screens need real accounts.
- **Do not run the Crew demo bus on the live site with the network on.** The demo bus is
  `BA2KHA4412`, which is a real plate, and a Crew phone that syncs registers its key for that
  bus. For a full ride, use way B.

### If something goes wrong

| Symptom | Fix |
| --- | --- |
| The camera does not open | Allow camera permission. Phones need `https` or `localhost`, so use the dev server's Network address with `BHADA_HTTP=1` (as above) or the live site |
| *Now at* says *Stage not known yet* | GPS is off or indoors; start the **bench drive** |
| The fare shows `—` on the passenger phone | The phone has no GPS fix near the route yet. The door still prices the ride from its own GPS |
| The door refuses with *stale* | The ride code is older than 5 minutes, or the phone's clock is far off; show a fresh code |
| The sync pill will not clear | Check that the local backend (`npm run sync:local`) is running and that `VITE_SYNC_URL` points at it |
| An old screen after an update | The service worker cached it. Reload twice, or clear site data |

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

## Inside Bhada: every part and how it connects

The complete map: every module, what it does, what calls it and where the data goes.

### 1. The whole system on one page

```
 PASSENGER PHONE (/app)                     BUS: CONDUCTOR PHONE (/crew)
 ┌────────────────────────────┐             ┌──────────────────────────────────────┐
 │ identity.js  key + day keys│  BT1 (QR)   │ terminal.js  the door                │
 │ Ride.jsx     ride code ────┼────────────►│   verifyTap → board → BO1 pass       │
 │              own odometer  │◄────────────┼─  BO1 (QR)                           │
 │              stage finder  │             │ meter.js     the meter               │
 │              receipt check │◄────────────┼─  BM2 receipt (QR) ← alight          │
 │ db.js (IndexedDB)          │             │   odometer, capacity, trips, crew    │
 │ outbox / sync.js           │             │ link.js      door ⇄ meter messages   │
 └────────────┬───────────────┘             │ db.js (IndexedDB) + outbox / sync.js │
              │                             └───────────────┬──────────────────────┘
              │      both upload when a signal returns      │
              ▼                                             ▼
        ┌──────────────────────────────────────────────────────────┐
        │ Supabase Edge Function `sync`  →  settleBatch()          │
        │   (protocol/settle.mjs: signatures, taps, fares, replay) │
        └───────────────────────────┬──────────────────────────────┘
                                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │ Postgres: settle_leg(), settle_fare(), ledgers, views    │
        └───────────────────────────┬──────────────────────────────┘
                                    ▼
             Owner app (/owner) · Staff app (/staff) · Admin (/admin)
```

`protocol/` is the same code in all three places: the phones, the Edge Function (a generated
copy) and the proofs. A rule lives in one file and is enforced everywhere.

---

### 2. The life of one ride, function by function

| Step | Where | Functions |
| --- | --- | --- |
| Passenger opens Bhada | `src/device/identity.js` | `loadIdentity()` makes or loads the master key, then derives today's key (`deriveDailyKeypair`, `protocol/pseudonym.mjs`) |
| Shows the ride code | `src/screens/Ride.jsx` | `buildTap` + `signTap` (`protocol/leg.mjs`) → BT1; re-signed every 30 s; `buildGroup` for a family (BG1); `writeNfc` offers it over NFC |
| Conductor scans | `src/screens/Terminal.jsx` → `useQrCamera` / `readNfc` | `present(text)` in `src/device/terminal.js` |
| Door decides on/off | `terminal.js` `present()` | `verifyTap` (signature, this bus, fresh, nonce unseen); an open ride for this key → `alight()`, otherwise `board()` |
| Boarding | `terminal.js` `board()` | capacity check against the meter's `busState`; `buildPass` + `signPass` → BO1 carrying `boardOdoM` and the GPS position; ride row saved to IndexedDB; `link.send('boarded')` to the meter |
| Meter counts | `src/device/meter.js` | on `boarded`: `occupancyState` and `doorDecision` (`protocol/meter.mjs`) update capacity and the interlock |
| Bus moves | `positioning.js` → `meter.js` / `terminal.js` | `fixFromPosition` → `applyFix` (odometer fusion with accuracy, speed and Doppler gates) → `odometerReading` |
| Passenger rides | `Ride.jsx` | the phone's own `applyFix` odometer; `stageNear(CURRENT_TARIFF, fix)` gives the boarding and current stage; fare so far = `priceDistance(..., { boardStage, alightStage })` |
| Getting off | `terminal.js` `alight()` | `verifyPass`; `resolveDistance` (odometer, else route-snapped GPS, else stage chainage); `stageNear` on the boarding position from the pass and on the door's fix now, else `stageAlong`; `priceDistance` with the stage tariff; `buildLeg` + `signLeg` → **BM2**; `link.send('alighted')` |
| Passenger keeps receipt | `Ride.jsx` `onScan('receipt')` | `decodeLeg`; re-priced with the receipt's own tariff code and stages; `compareDistances` against the phone's reading; saved to `passengerReceipts` |
| Nobody taps out | `meter.js` `endTrip()` | open rides closed at `unclosedLegFare` (distance tariff, `distanceSource: 'unclosed'`) |
| Signal returns | `src/lib/useSyncStatus.js` → `src/device/sync.js` | `syncTerminal` / `syncMeter` / `syncPassenger` POST a batch to `/functions/v1/sync`; `sync-schedule.mjs` decides when; `outbox.js` counts what is waiting |
| Backend verifies | `supabase/functions/sync/index.ts` → `settleBatch()` | `verifyLeg` (bus signature, re-price), `verifyLegConsent` (the passenger's BT1), replay, crew `verifySignOn`, `verifyCashTicket`, `assessDispute` |
| Money moves | Postgres `settle_leg()` | debits `wallet_for(passenger key)`, writes `legs`, `leg_taps`, `wallet_moves`; the overdraft floor; concessions |
| Owner sees it | `src/apps/owner/*` | views `owner_fleet`, `operator_daily`, `operator_distance`, functions `owner_money`, `owner_statement` |

---

### 3. protocol/: the shared rules

Every file is platform-free ES modules: no browser or Node APIs. The random source is
injected with `useRandomSource`, and positions and times are always passed in.

| File | Exports | What it is for |
| --- | --- | --- |
| `base64url.mjs` | `toBase64url`, `fromBase64url`, `utf8Bytes` | Encoding keys and signatures into QR-safe text |
| `random.mjs` | `useRandomSource`, `randomBytes` | One injected randomness source (browser crypto or Node crypto) |
| `token.mjs` | `TOKEN_VERSION` (BH1), `createKeypair`, `keypairFromSecret`, `newNonce`, `buildToken`, `signToken`, `decodeToken`, `verifyQr`, `assertCode`, `assertWholeNumber`, `FIELD_SEPARATOR` | Keys, and the stage-ticket token a passenger signs and a conductor verifies |
| `stages.mjs` | `ROUTE_STAGES` | Each route's stages in order, with position and road chainage |
| `meter.mjs` | `haversineMetres`, `FUSION`, `FIX_QUALITY`, `initialOdometer`, `applyFix`, `odometerReading`, `CIRCUITY_FACTOR`, `snapToRoute`, `routeDistanceM`, `resolveDistance`, `DISTANCE_SOURCE`, `ODO_CREDIBLE_M`, `TARIFF`, `STAGE_TARIFF`, `CURRENT_TARIFF`, `TARIFFS`, `stageNear`, `stageAlong`, `stageName`, `priceDistance`, `CONCESSION_RATE`, `DOOR_ROLE`, `DOOR_STATE`, `occupancyState`, `doorDecision`, `admitDecision`, `CREEP_SPEED_MPS` | The odometer (GPS fusion), distance resolution, every tariff (distance and stage), stage finding, pricing, capacity and the door interlock |
| `leg.mjs` | `TAP_VERSION` (BT1), `buildTap`, `signTap`, `decodeTap`, `verifyTap`, `TAP_MAX_AGE_S`, `GROUP_VERSION` (BG1), `buildGroup`, `splitGroup`, `GROUP_MAX`, `PASS_VERSION` (BO1), `buildPass`, `signPass`, `decodePass`, `verifyPass`, `PASS_MAX_AGE_S`, `LEG_VERSION` (BM1), `LEG_VERSION_STAGED` (BM2), `buildLeg`, `signLeg`, `decodeLeg`, `verifyLeg`, `verifyLegConsent`, `toMicro`, `fromMicro` | The metered ride's codes: ride code, family code, boarding pass, receipt |
| `cash.mjs` | `CASH_VERSION` (CT1), `buildCashTicket`, `signCashTicket`, `decodeCashTicket`, `verifyCashTicket` | A cash fare recorded at the door, signed by the bus |
| `dispute.mjs` | `DISPUTE_VERSION` (BD1), `buildDispute`, `signDispute`, `decodeDispute`, `verifyDispute`, `assessDispute`, `DISPUTE_MAX_AGE_S`, `WITNESS_GAP_S` | The dead-phone claim against an unclosed ride, and the rule that decides it |
| `crew.mjs` | `CREW_VERSION` (CR1), `buildSignOn`, `signSignOn`, `decodeSignOn`, `verifySignOn`, `SIGNON_MAX_AGE_S`, `SHIFT_MAX_AGE_S`, `cleanTripVerdict`, `assessPower`, `POWER_GRACE_S`, `POWER_MOVING_WINDOW_S` | Crew sign-on, what makes a trip clean (the bonus), and when a lost charger counts as a pulled plug |
| `pseudonym.mjs` | `createMasterSeed`, `dayIndex`, `deriveDailyKeypair`, `deriveCompanionKeypair`, `MAX_COMPANIONS`, `LINK_VERSION` (PK1), `buildLink`, `signLink`, `decodeLink`, `verifyLink` | A fresh key per day (and per companion) so rides cannot be linked across days, plus the signed link that tells the backend which account pays |
| `account.mjs` | `ACCOUNT_LINK_VERSION` (AL1), `buildAccountLink`, `signAccountLink`, `decodeAccountLink`, `verifyAccountLink`, `ACCOUNT_LINK_MAX_AGE_S` | Joining a phone's key to a login |
| `attest.mjs` | `ATTEST_VERSION` (AT1), `ATTESTABLE`, `buildAttestation`, `signAttestation`, `decodeAttestation`, `verifyAttestation`, `concessionFor` | Student and senior concession cards issued by a registered issuer |
| `inspect.mjs` | `ROSTER_VERSION` (RS1), `buildRoster`, `signRoster`, `decodeRoster`, `verifyRoster`, `checkRider`, `tallyInspection`, `KEY_PREFIX`, `ROSTER_MAX_AGE_S` | The inspector's offline check: who the bus says is aboard |
| `plausibility.mjs` | `PLAUSIBLE`, `scoreLeg`, `scoreTrip` | Flags rides whose distance or speed does not fit the route |
| `frame.mjs` | `FRAME_VERSION`, `FRAME_BYTES`, `FLAG`, `crc32`, `encodeFrame`, `decodeFrame`, `frameToBase64url`, `frameFromBase64url`, `frameToHex` | The 32-byte RS-485 heartbeat a meter box sends to a Pi door |
| `gateway.mjs` | `GATEWAYS`, `ESEWA`, `KHALTI`, `MANUAL_METHODS`, `esewaMessage`, `esewaForm`, `readEsewaReturn`, `esewaSettled`, `khaltiInitiateBody`, `khaltiSettled` | Building and checking payment-gateway messages (eSewa in use) |
| `policy.mjs` | `OVERDRAFT_NPR`, `OFFLINE_SPEND_CAP`, `SETTLEMENT_WINDOW_SECONDS`, `offlineAllowance`, `canPayOffline`, `CLEAN_TRIP_BONUS_NPR`, `CLEAN_TRIP_MIN_LEGS`, `RECORDED_SHARE_MIN_PCT`, `MAX_CORRIDOR_HOLD_NPR`, `calculateExitReconciliation`, `isOverdraftAllowed` | The numbers money rules use. `offlineAllowance`/`canPayOffline` cap what a stage-ticket phone may spend before it syncs. `MAX_CORRIDOR_HOLD_NPR`, `calculateExitReconciliation` and `isOverdraftAllowed` are display-only or unused; no money is held at boarding |
| `settle.mjs` | `readBatch`, `settleBatch`, `MAX_BATCH`, `MAX_TOKEN_AGE_SECONDS` | **The single place a sync batch is verified.** The Edge Function and the local backend call it with a ledger of database methods |
| `index.mjs` | re-exports everything | |

**How pricing connects.** `priceDistance(metres, opts)` takes a tariff by code (`TARIFFS`).
On a *distance* tariff it prices kilometres; on a *stage* tariff it prices `opts.boardStage →
opts.alightStage` from the table and ignores the kilometres; with `unclosed` it charges the
unclosed fare. `verifyLeg` calls it with the receipt's own tariff code and stages, so the
door, the passenger's phone, the Edge Function and the proofs all compute the same number.

---

### 4. src/device/: the bus and the phone

| File | What it does | Talks to |
| --- | --- | --- |
| `identity.js` | Makes the device key on first launch with no network; daily pseudonym keys; companions; balance as last seen; `installRandomSource` | `protocol/pseudonym.mjs`, `storage/db.js` |
| `fleet.js` | Which bus this phone is (`currentVehicle`, `provisionVehicle` from the owner's `BHSETUP1` code, `isProvisioned`, `plateFromId`) | Crew setup, meter, door |
| `positioning.js` | `fixFromPosition` (browser position → fix), `holdScreenOn` (wake lock), trace download | meter, door, ride card |
| `meter.js` | The bus unit: boots, owns the odometer, trips (`endTrip`), capacity and doors, crew sign-on (`signOnCrew`), power events, bench drive (`simulate`, scripted GPS), cash, the inspection roster, pairing codes for door phones, unclosed rides at trip end, upload queue | `protocol/meter.mjs`, `crew.mjs`, `inspect.mjs`, `link.js`, `sync.js` |
| `terminal.js` | A door: `present()` routes a scan; `board()` issues BO1; `alight()` prices and signs BM2; cash tickets (CT1); rider cards on NFC tags; pairing to the meter; mirrors open rides to the other door (`open-legs`) | `protocol/leg.mjs`, `meter.mjs`, `cash.mjs`, `link.js`, `nfc.js` |
| `link.js` | The vehicle bus between meter and doors: BroadcastChannel inside one browser plus Supabase Realtime when online; messages deduplicated by id; peer hello every 4 s | meter, door |
| `nfc.js` | Web NFC read/write (`readNfc`, `writeNfc`, `nfcSupported`) | door, ride card |
| `collect.js` | `collectFare` on the stage-ticket path: verify the BH1, refuse a replayed sequence number, write to the ledger | `protocol/token.mjs` |
| `sync.js` | `syncPassenger`, `syncConductor`, `syncTerminal`, `syncMeter`: build the batch, POST it, mark what settled | Edge Function `sync` |
| `outbox.js` | `pendingPassenger`, `pendingConductor`: how much is waiting | sync pill |

---

### 5. src/lib/ and src/storage/: helpers and on-device data

| File | What it does |
| --- | --- |
| `storage/db.js` | IndexedDB stores: `meter` (keys, rides, receipts, settings), `legs`, `payments`, `ledger`, `meta` (fare table) and more; `currentTripId` |
| `storage/carry-over.js` | One-time move of an older phone's data into the Crew app's own database |
| `lib/fares.js` | Stage-ticket fare table: bundled copy, cached copy, `refreshFareTable` from the `fares` table, `fareFor`, `onwardStops` |
| `lib/nepali.js` | Devanagari numerals, `rupees`, and `STOPS` (read from `protocol/stages.mjs`), `stageMetres`, `chainageFor`, `stop` |
| `lib/useSyncStatus.js` + `sync-schedule.mjs` + `sync-label.mjs` | Sync that runs by itself: when to try, backoff, and what the pill says in Nepali and English |
| `lib/useQrCamera.js` + `qr-read.mjs` | The single camera loop every scanner uses; how a frame becomes QR text (`jsqr`) |
| `lib/scan-input.js` | Hardware barcode scanners that type like a keyboard |
| `lib/code-kind.mjs` | Tells what a scanned code is (ride code, pass, receipt BM1/BM2, setup, join…) before anything verifies it, so a wrong code gets a helpful refusal |
| `lib/router.js` + `surface.mjs` | A small router; which app owns a path; redirects for old links |
| `lib/supabase.js`, `supabase-local.js`, `supabase-fixtures.js` | The office apps' Supabase client: live, local backend, or fixtures for looking without a login |
| `lib/fleet-simulator.js` + `data/valley-routes.js` | The **simulated** demo fleet: buses moving along valley routes every 1.5 s, seats, current and next stop, ETA |
| `lib/gnss-sim.js` | A simulated GPS receiver on a bus, used by the bench drive and by `proof:meter` |
| `lib/voice.js`, `feedback.js` | Recorded Nepali voice prompts and haptics at the door |
| `lib/report.js` | Sends a crash to `client_errors` |

---

### 6. The apps and their screens

All apps use `src/ui` (tokens, `Button`, `TopBar`, `TabBar`, `Stats`, `List`, `Empty`,
`Note`, `Sheet`, `Plate`, `Stamp`, `Status`, `DemoTag`, `Segmented`, `AppFrame`, `SyncPill`,
`AppSignIn`).

**Site (`/`)**: `src/pages/Home.jsx` (front page), `Tour.jsx` (swipe intro);
`src/screens/Demo.jsx` (`/demo`, a simulated trip with a real backend in the browser);
`Inspect.jsx` (`/inspect`); `src/portals/admin` (`/admin`).

**Bhada, passenger (`/app`)**: `src/apps/rider/RiderApp.jsx`
- *Home* `RiderHome.jsx`: the journey card while riding (boarded and current stage, fare so
  far, journey km), or get on; ride balance; recent rides with Verified / To send.
- *Routes* `RiderRoutes.jsx`: search by stop, route cards, a route's demo buses, numbered
  stops, map (`src/ui/OsmFleetMap.jsx`, Leaflet), fare calculator.
- *Ride* `src/screens/Ride.jsx`: ride code, the phone's own odometer and stage, receipt
  view, dead-phone claim.
- *Ticket* `src/screens/Passenger.jsx`: the stage-ticket path (BH1).
- *Account* `src/portals/account`: link the phone to a login, statement, eSewa top-up, settings.

**Bhada Crew, conductor (`/crew`)**: `src/apps/crew/CrewApp.jsx`
- *Setup* `Setup.jsx`: scan the owner's bus setup code, or choose the demo bus;
  `UnitStatus.jsx` shows whether the backend has confirmed this phone.
- *Trip* `src/screens/Device.jsx`: the glance (current stage, fares, passengers, GPS, uploads,
  scan, cash, end trip), then *More* (aboard list by stage, doors, closed rides, crew) and
  *Engineering* (readouts, corridor, accuracy, registry, telemetry, door tape, bench).
- *Tickets* `src/screens/Conductor.jsx`: scanning stage tickets (BH1).
- *Door* `src/screens/Terminal.jsx` (simple mode): the count, scan, cash, and More.
- *Shift* `src/screens/Crew.jsx`: one-tap sign-on (CR1) to the meter on this phone.

**Bhada Owner (`/owner`)**: `src/apps/owner/OwnerApp.jsx`, with data helpers in `data.js`
- `Today.jsx` (onboarding checklist, today's figures, buses, demo pages), `Buses.jsx` (bus
  pages, setup code), `Money.jsx` (balance, levy, payouts, statement), `People.jsx`
  (invites, roles), `Papers.jsx`, `Reports.jsx` (uses `src/portals/operator` views),
  `Agreements.jsx`, `BusOwnerHome.jsx`, `Start.jsx` (join by invite code),
  `OwnerFleetMap.jsx` (simulated), `FraudAudit.jsx` (sample data).

**Bhada Staff (`/staff`)**: `src/apps/staff/StaffApp.jsx`
- `Companies.jsx` and `Company.jsx` (create a company, record agreements, papers, invite the
  owner, go live), `Review.jsx` (paper queue), `Requests.jsx` (new buses, route builder),
  `Payouts.jsx` (marked paid with the partner's reference), `Platform.jsx` (fees, levies,
  agreement texts, reviewers).

---

### 7. Backend: Edge Functions

| Function | What it does |
| --- | --- |
| `supabase/functions/sync/index.ts` | `POST /functions/v1/sync`. An adapter over `settleBatch()`: it supplies the database methods (`register_meter`, `record_tap`, `settle_leg`, `settle_fare`, `file_dispute`, `append_meter_events`, `award_clean_trip`, `record_cash_ticket`, `record_trip_count`, `link_account`, `register_pseudonym`) and nothing else. Deployed `--no-verify-jwt`, because a bus uploads without a login and the signatures are the authorisation |
| `supabase/functions/payments/index.ts` | `POST /functions/v1/payments`. Opens an eSewa top-up, checks eSewa's signature and its status API for this reference and amount, then calls `gateway_complete_topup()`. Nothing else credits a top-up |
| `supabase/functions/_shared/` | `guard.ts` (request checks) and the generated copy of `protocol/` |

---

### 8. Backend: the database, migration by migration

Every money rule is in SQL, behind row-level security. No table is granted to logged-in users
for writing; screens call functions that check the caller themselves (`is_platform_admin()`,
`is_reviewer()`, `current_operator_id()`).

| Migration | Tables / views | Functions |
| --- | --- | --- |
| 0001 bhada | `routes`, `stops`, `fares`, `vehicles`, `operators`, `passengers`, `trips`, `transactions`; views `trip_totals`, `ridership_by_hour` | `settle_fare` (stage tickets) |
| 0002 seed | R11 stops and stage fares | |
| 0003 topups | `wallet_topups`; `wallet_audit` | `credit_wallet`, `register_device` |
| 0004 lockdown | grants and RLS | |
| 0005 operators | `operator_users`; operator views | `current_operator_id`, `set_concession` |
| 0006 / 0019 operator signup | | `my_operator`, `register_operator` |
| 0007 meter | `tariffs`, `legs`, `door_events`; `leg_economics`, `overload_log` | `register_meter`, `settle_leg` |
| 0008 tap consent | `leg_taps` | `record_tap`, `settle_leg` (no tap, no settle) |
| 0009 tariff 3 km | tariff `NPR-KTM-2026B` | |
| 0010 unclosed legs | unclosed rides | |
| 0011 operator meter | `operator_distance`, `operator_overloads`, `operator_vehicles` | |
| 0012 dead-phone claims | `leg_disputes`; `dispute_load` | `file_dispute`, `settle_leg` |
| 0013 route distance | route length | |
| 0014 concessions | `concession_issuers`; `concession_claims` | `settle_leg` |
| 0015 DoTM returns | `dotm_daily_return`, `dotm_overload_register` | |
| 0016 pseudonyms | `passenger_keys` | `register_pseudonym`, `wallet_for`, `settle_leg` |
| 0017 plausibility | `meter_plausibility` | `flag_leg` |
| 0018 overdraft | `wallet_overdrafts` | `settle_leg` (floor at −Rs 50) |
| 0020 valley routes | `route_stops`; `route_directory` | |
| 0021 Kathmandu time | views by Nepal day | |
| 0022 portals | `passenger_accounts`, `platform_admins`, `platform_settings`, `topup_requests`, `wallet_adjustments` | `link_account`, `my_account`, `my_statement`, `request_topup`, `is_platform_admin`, `admin_*` |
| 0023 / 0024 / 0032 gateway top-ups | | `gateway_open_topup`, `gateway_attach_topup`, `gateway_complete_topup`, `gateway_fail_topup`, `expire_gateway_topups` |
| 0025 / 0026 crew economics | `crew_bonuses`, `meter_events`; bonus and tamper views | `note_crew`, `trip_evidence`, `award_clean_trip`, `append_meter_events` |
| 0027 client errors | `client_errors` | `report_client_error`, `admin_client_errors` |
| 0028 views as caller | views run with the caller's rights | |
| 0029 wallet moves | `wallet_moves` | `move_wallet`, `wallet_statement`, `settle_leg`, `settle_fare` |
| 0030 counts and cash | `cash_tickets`; `operator_trip_count` | `record_cash_ticket`, `record_trip_count` |
| 0031 inspection | | `vehicle_public_keys` |
| 0033 company roles | `operator_invites` | `owner_invite`, `accept_invite`, `owner_members`, `owner_set_member`, `member_role` |
| 0034 vehicle registry | `vehicle_owners`, `vehicle_enrolments`, `vehicle_changes`; `owner_fleet` | `admin_register_vehicle`, `set_vehicle_owner`, `fare_party`, `register_meter` (setup code), `owner_bus_setup`, `my_buses` |
| 0035 SaaS billing | `platform_fees`, `operator_levies`, `operator_charges`, `operator_payouts` | `fee_at`, `levy_at`, `bus_days`, `party_payable`, `owner_money`, `owner_statement`, `request_payout`, `admin_bill_month`, `admin_decide_payout` |
| 0036 compliance documents | `compliance_documents`, `operator_drivers`, `platform_reviewers` | `file_document`, `review_document`, `review_queue`, `compliance_for`, `owner_compliance` |
| 0037 company requests | `company_requests` | `owner_request`, `review_requests`, `admin_build_route` |
| 0038 onboarding | `agreement_texts`, `operator_agreements` | `accept_agreement`, `admin_create_company`, `admin_set_company_live`, `my_onboarding` |
| 0039 stage tariff | `tariffs.kind`, `tariffs.stage_fares` | tariff row `R11-STAGE-DEMO-1` (demo stage fare table) |

---

### 9. The Raspberry Pi door validator

`validator/` runs `src/device/terminal.js` unchanged on a Pi. `loader.mjs` swaps only four
modules for Pi adapters:

| Swapped module | Pi adapter |
| --- | --- |
| `storage/db` | `adapters/store.mjs` (SQLite) |
| `device/link` | `adapters/link.mjs` (RS-485 heartbeat frames) |
| `device/nfc` | `adapters/nfc.mjs` (PN532 card reader) |
| `device/positioning` | `adapters/positioning.mjs` |

`core.mjs` adds the scanner (GM65/GM805), the DS3231 clock (it refuses taps when no clock is
trusted), and the screen. `uplink.mjs` uploads queued rides with backoff and keeps settled
ones for 14 days. `bench.mjs` runs it on a laptop with no hardware. It is proven in software
(`proof:validator`), not yet on real parts. No GPIO pin drives a door.

---

### 10. Proofs, tests and the local backend

| Script | Holds |
| --- | --- |
| `scripts/handshake-proof.mjs` (`proof`) | The offline stage-ticket handshake |
| `scripts/meter-proof.mjs` (`proof:meter`) | Odometer accuracy at every traffic speed with and without Doppler; 400 random rides; the distance tariff's promise over 21 stage pairs; the stage fare table (49 pairs, symmetry, concessions, stage finding, BM2); taps, consent, doors, frames, groups, inspection, cash |
| `scripts/reconcile-proof.mjs` (`proof:reconcile`) | Stage-ticket settlement on PGlite |
| `scripts/legs-proof.mjs` (`proof:legs`) | Every migration on PGlite through `scripts/lib/pg-backend.mjs`: sections 1–37, from honest rides and attacks to roles, money, papers, onboarding, the admin-function sweep, and stage-fare settlement |
| `scripts/validator-proof.mjs` (`proof:validator`) | The Pi validator: adapters, offline, scanner, PN532, DS3231, RS-485, screens (every QR decoded from pixels), power |
| `npm test` | UI unit tests (sync schedule, labels, code kinds, routing and more) |

Local backend: `scripts/lib/pg-core.mjs` (Postgres half), `pg-backend.mjs` (`settleBatch` over
PGlite), `local-supabase.mjs` (the office screens' calls), `scripts/local-sync-server.mjs`
(`npm run sync:local`, port 8787, demo logins seeded).

---

### 11. Builds, routing and deployment

- `scripts/apps.mjs` builds five apps with `BHADA_APP=site|rider|crew|owner|staff`, each with
  its own entry (`apps/<name>/index.html`), service worker, manifest and IndexedDB. The site
  builds first, because it empties `dist/`.
- `vercel.json` sends each path prefix to its build, keeps service workers uncached, and sets
  the security headers: the CSP allows Supabase, eSewa forms and the OpenStreetMap tiles.
- Vercel builds from GitHub `main` with `npm run proof:all && npm run build`; a failing proof
  stops the deploy.
- Release order: `supabase db push` → `npm run sync:protocol` → `supabase functions deploy
  sync --no-verify-jwt` and `payments` → `git push`.

---

### 12. Security model in one table

| Threat | Stopped by |
| --- | --- |
| Charging someone who never rode | No settlement without the passenger's own BT1 (`leg_taps`, `verifyLegConsent`) |
| Charging twice | Leg ids and tap nonces are single-use; `settle_leg` is idempotent |
| A forged or edited receipt | Bus Ed25519 signature; re-priced in `settleBatch` from its tariff code and stages |
| A changed stage | The stages are inside the BM2 signature |
| A screenshot of a ride code | Re-signed every 30 s, valid 5 minutes, accepted once |
| Tracking a rider across days | A new key each day (0016); the operator sees pseudonyms |
| An admin screen with too much power | Every `admin_*` / `review_*` function checks the caller; `proof:legs` calls each one as an owner, a rider and nobody |
| A top-up nobody paid | Credited only by `gateway_complete_topup()` after eSewa's signature and status check |
| Money on the wrong account | Money moves on `wallet_for(key)`, never the key a receipt names |

---

## Licence

MIT.
