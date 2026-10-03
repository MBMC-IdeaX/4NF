# Bhada — भाडा

**Bus fares by the kilometre in Kathmandu, paid from a phone, with no signal needed.**

Kathmandu's buses have no fixed stops and price fares from a stage table, so the
conductor guesses, the rider argues and the cash comes back short. Bhada prices
each ride by the distance actually ridden, takes the fare with a tap at the
door, and works with every phone offline. A phone needs a connection only later,
when the money moves.

Bhada is software for bus companies. It does not hold riders' money and takes no
cut of any fare.

- Live: [bhada-one.vercel.app](https://bhada-one.vercel.app)
- How the meter, the signed protocol and the proofs work: [docs/engineering.md](docs/engineering.md)

---

## The apps

One repository and one Supabase backend. Five separate builds, each with its own
bundle, service worker and on-device database, which talk to each other only
through the API.

| App | Path | Who uses it | What it does |
| --- | --- | --- | --- |
| **Bhada** (Rider) | `/app` | Passengers | A wallet on the phone, a signed ride code to show at the door, the phone's own odometer, signed receipts, eSewa top-up, a login that recovers the money if the phone is lost |
| **Bhada Crew** | `/crew` | Conductors (खलासी) | The conductor's phone *is* the bus: the meter, the door (tap on and off, cash tickets, the capacity interlock), and the shift. It is set up once by scanning a code from the owner |
| **Bhada Owner** | `/owner` | The company's owner and managers, and bus owners inside a company | Today's checklist and figures, buses, people, papers, money, reports, agreements. A bus owner sees only their own buses and their own money |
| **Bhada Staff** | `/staff` | Bhada's onboarding officers, reviewers and admins | Onboarding companies, entering buses from their papers, checking every paper, building routes, payouts, Bhada's rates and agreement texts |
| Site | `/` | Everyone | Landing page and a swipe-through "how it works"; also `/inspect` (an inspector's offline check), `/admin` (wallets and top-ups) and `/demo` |

Rider, Crew and Owner install as PWAs and keep working offline. Each queues what
it did and syncs on its own whenever a signal comes back. Nobody presses "send".

---

## How a company joins

Companies do not sign themselves up. The company is the holder of the route
permits; Bhada onboards it in person, then serves every bus that runs under
those permits.

1. **Agreements first.** These are the service agreement, the payout mandate and
   the data consent notice. Each is signed on paper and scanned by staff, or
   accepted by the owner in the app, or both. Every acceptance keeps a hash of
   the exact words accepted. A new version of a text has to be accepted again.
2. **Company papers.** Staff file the company's five papers from the originals:
   registration, PAN/VAT, tax clearance, directors' citizenship and DoTM
   registration. A reviewer approves each one, with its expiry date where it
   has one.
3. **Buses from their papers.** Staff enter each bus from its bluebook and route
   permit. Owners do not type in buses, routes or seat counts. They ask, with
   photos of the papers attached, and staff enter what the papers say. The seat
   count is the permitted capacity the door interlock enforces.
4. **People.** Bhada gives the owner an invite code. The owner then invites
   managers, conductors and bus owners, each with their own code and role.
5. **Live.** A platform admin takes the company live once the three agreements
   are current and the company papers are approved. Payouts open then. Fares
   settle from the first ride either way.

Every bus and driver also files their own papers: a bus files its bluebook,
pollution test, tax clearance, insurance and route permit, and a driver files a
licence and an agreement with the bus. A bus or driver is *verified* while
every paper is approved and in date. Nothing here ever stops a fare.

A route that Bhada does not have yet is built by a reviewer from the route
permit: the stops in running order, with each new stop's position. It is then
there for every company holding a permit for it.

---

## Money

**Bhada never holds funds.** Holding customer money needs a Payment Service
Provider licence from Nepal Rastra Bank (Payment and Settlement Act 2075). So
rider money is held by a licensed partner under a written agreement. Bhada keeps
the ledger of who is owed what and instructs the partner. A payout is that
instruction: staff carry it out with the partner and mark it paid with the
partner's reference.

**Who is owed.** A company may run its own buses and buses owned by its members
(role `bus_owner`). Each is a separate party with its own balance:

- **A bus owner** gets the fares their buses carried, less refunds, crew
  bonuses, the company's levy and their own payout fees.
- **The company** gets the fares its own buses carried, less the same, plus the
  levy from every member bus, less Bhada's charges.

The **levy** is the company's flat charge for each day a member's bus runs, as
set in the service agreement. A fare belongs to whoever owned the bus on the day
it was carried. When a bus changes hands, its past stays with the old owner.

**What Bhada earns.** Bhada takes no commission on fares. It earns from:

| Rate | Charged to | How |
| --- | --- | --- |
| App fee, per bus a month | The company | For each bus that carried a fare that month, billed after the month ends |
| Top-up fee | The rider | A flat amount added to an eSewa top-up as eSewa's service charge; not credited to the wallet |
| Payout fee | Whoever is paid | A flat amount per payout |

Rates and levies are dated rows, added and never edited, so a past charge keeps
the rate it was made under. Every rate starts at zero, and nothing is charged
until a platform admin sets one.

---

## Legal basis

The full research, with sources, is in
[docs/legal/2026-10-03-onboarding-research.md](docs/legal/2026-10-03-onboarding-research.md).
In short:

- **Operators.** Route permits are held by transport companies and committees
  (Transport Management Directive, amended 2018). The Urban Area Public
  Transport (Management) Authority Act 2079 sets up the authority that will
  regulate valley routes. Bhada onboards the permit holder and serves every bus
  owner under it.
- **Money.** Bhada stays outside the Payment and Settlement Act 2075 by never
  holding funds: a licensed partner holds them and Bhada instructs it.
- **Contracts.** An agreement accepted in the app is a valid contract under the
  Electronic Transactions Act 2063. Paper copies are kept as well.
- **Personal data.** The Privacy Act 2075 asks for informed, specific consent;
  that is the data consent notice. Passengers sign rides with a fresh key each
  day, so an operator cannot link two days' rides to one wallet.
- **Buses and crews.** Bluebook, third-party insurance, pollution test and route
  permit for each bus; a category G licence for bus drivers; a written contract
  for employees under the Labour Act 2074. These are the papers each app asks
  for.

---

## What is proven, and what is not

Before anything in `protocol/` counts as changed, five proofs must pass.
`npm run proof:all` runs them all, and Vercel will not deploy a build whose
proofs fail.

| Proof | What it holds |
| --- | --- |
| `npm run proof` | The offline stage-fare handshake |
| `npm run proof:meter` | Odometer within ±2% of true road distance at every traffic speed; fares over 400 random rides; the tariff promise; doors; the frame |
| `npm run proof:reconcile` | Stage-fare settlement on real Postgres (PGlite) |
| `npm run proof:legs` | Every migration on Postgres, plus metered settlement, tap consent, replay, dead-phone claims, roles, the vehicle registry, money by party with the levy and dated ownership, papers, onboarding, requests and routes, and a sweep of every staff function |
| `npm run proof:validator` | The Raspberry Pi door validator in software: scanner, card reader, clock, RS-485, screens |

`npm test` runs the UI unit tests.

**Not proven yet:**
- **Real GNSS.** The meter has not been scored on real GNSS from a moving bus;
  `npm run trace:replay` is how recorded traces will be scored.
- **The Pi validator.** It has not been run on its actual parts.
- **The door counter.** The break-beam is not yet wired to a bus.
- **The payment partner.** The partner agreement is a business step outside this
  repository.

---

## Running it locally

Needs Node 20+ (tested on 25).

```bash
npm install
npm run sync:local        # local backend on :8787 — every migration on PGlite, demo logins seeded
BHADA_LOCAL_DB=1 VITE_SYNC_URL=http://localhost:8787/sync BHADA_HTTP=1 npm run dev
# open http://localhost:5199 — it proxies /app, /crew, /owner and /staff
```

`BHADA_LOCAL_DB=1` points the office screens (Owner, Staff, accounts) at the
local server instead of Supabase. Row-level security, grants and every
function's own checks still decide what each login sees. **`.env.local` points
at the live backend**, so always override `VITE_SYNC_URL` as above when testing
locally.

Demo logins on the local backend all use the password `bhada-demo-2026`:

| Login | Is |
| --- | --- |
| `owner@demo.bhada.np` | Owner of Mayur Yatayat (live, three buses) |
| `manager@demo.bhada.np` | Its manager |
| `busowner@demo.bhada.np` | A bus owner in it, owning BA2KHA7003 |
| `conductor@demo.bhada.np` | A conductor on BA2KHA7001 |
| `reviewer@demo.bhada.np` | Bhada staff, reviewer |
| `admin@demo.bhada.np` | Bhada staff, platform admin |
| `rider@demo.bhada.np` | A passenger |

A second company, Nilo Yatayat, is created but not onboarded, so you can carry
it through the Staff site. The seeded agreement texts are placeholders. Delete
`.pgdata` and `.pgdata-files` to start again from nothing.

Other commands:

```bash
npm run build             # all five builds into dist/ (the site first; it empties dist/)
npm run dev:owner         # one app's dev server alone (also dev:site, dev:rider, dev:crew)
npm run serve             # serve dist/ with the production headers
npm run sync:protocol     # after editing protocol/: regenerate the Edge Function's copy
```

---

## Deploying

Release order: **database, then functions, then the site.** Devices keep
anything a newer client sends queued until the backend understands it, so
nothing is lost in between.

```bash
supabase db push                                  # migrations
npm run sync:protocol
supabase functions deploy sync --no-verify-jwt    # a bus uploads with no login; signatures authorise it
supabase functions deploy payments
vercel --prod                                     # builds with npm run proof:all && npm run build
```

**Once, on a new backend:**

- **First platform admin.** Make one in SQL:
  `insert into platform_admins (user_id) select id from auth.users where email = '…';`.
  Reviewers are then made from **Staff → Rates → Reviewers**.
- **Agreement texts.** Publish the real texts from **Staff → Rates → Agreement
  texts** before onboarding any company.
- **Payments secrets.** `ESEWA_ENV` (`test` uses eSewa's test merchant;
  `live` needs `ESEWA_PRODUCT_CODE` and `ESEWA_SECRET_KEY`) and `SITE_URL`.
  eSewa sandbox login: 9711111111 / Test@123 / token 123456. The sandbox has a
  reCAPTCHA, so a test payment is finished by hand.
- **`SIGNUP_CREDIT_NPR`.** It gives every new wallet a demo balance. Unset it
  before real money.
- **Supabase Auth.** Set the Site URL and redirect list to the deployed domain,
  or confirmation emails point at `localhost`.

`vercel.json` routes each app's paths to its own build, keeps every service
worker uncached and sends the security headers. Rollbacks, backups and key
rotation are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

---

## Where things are

```
protocol/            platform-free ESM shared by the apps, the Edge Function and the proofs
                     (signing, the meter, settlement, tariffs, disputes, crew rules)
supabase/migrations  the schema, numbered; every money rule is enforced here
supabase/functions   sync (settlement, through settleBatch) and payments (eSewa)
apps/<name>/         each build's index.html
src/apps/            rider, crew, owner, staff
src/ui/              the UI kit every app is built from
src/device/          the meter, the door, sync and the on-device stores
src/screens/         the meter, door and conductor screens the Crew app mounts
src/pages/           the landing page and the tour
src/portals/         the account (wallet) screens and the older admin console
validator/           the Raspberry Pi door validator (runs src/device/terminal.js unchanged)
scripts/             the proofs, the local backend, builds, fonts, icons, voice
docs/                engineering record, legal research, specs, runbook
```

Rules that are easy to break are listed in [AGENTS.md](AGENTS.md). Read it
before changing anything that touches money.

---

## Further reading

- [docs/engineering.md](docs/engineering.md): how the kilometres are known to
  be right, the security model, wire formats, the door interlock, crew
  economics, the validator, and the September 2026 audit.
- [docs/legal/2026-10-03-onboarding-research.md](docs/legal/2026-10-03-onboarding-research.md):
  what the law asks of operators, buses, crews and Bhada.
- [docs/superpowers/specs/2026-10-03-three-apps-design.md](docs/superpowers/specs/2026-10-03-three-apps-design.md):
  the design of the apps.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): when something is wrong in production.

## Licence

MIT.
