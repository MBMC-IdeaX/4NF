# Bhada — three apps, one system

Date: 3 Oct 2026. Status: design, awaiting review. Not committed (owner's instruction).

## 1. What the owner asked for

- The site is too complex. Replace it with three apps: **Rider** (passenger),
  **Crew** (conductor) and **Owner** (bus owner).
- Production quality on the level of eSewa or Khalti. Not generic.
- Interconnected and offline-first: everything works without signal, and
  everything is brought up to date by itself once the phone is back online.
- The IoT door validator is kept for the future. It is explained, not sold:
  an interactive 3D model shows what it is and how a tap travels.
- New landing pages. Design inspiration from `datajewellery-main/`.
- The conductor's QR scan does not work. Fix it.
- Every feature already built stays exactly as it is. This is a new face over
  the same engine, not new rules.

## 2. Decisions taken (the owner delegated them)

| Question | Decision | Why |
|---|---|---|
| What runs the bus with the IoT unit parked? | **The conductor's phone is the bus unit.** The Crew app runs the meter (`src/device/meter.js`) and the door (`src/device/terminal.js`) in one page. | One phone per bus is the only rollout a Nepali operator will accept. The Pi validator still drops in later because `terminal.js` stays unchanged. |
| One build or three? | **One build, three installable apps.** Three web manifests, each with its own name, icon, `start_url` and `scope`; one service worker. | A phone installs only the app it needs; the protocol code is shared, not copied. |
| The two visual registers (bus "print" vs portal "app") | **Replaced by one design system** with a "glance mode" for in-ride screens. | The owner rejected the current look as a whole. What made the bus register work (huge figures, glare contrast, no decoration while moving) survives as a mode, not a separate language. |
| Admin console (`/admin`) and inspector (`/inspect`) | **Kept, out of scope except a reskin at the end.** | Internal tools; not one of the three apps. |
| `/demo` | **Kept unchanged**, linked from the landing. | It is the pitch; it still works. |
| Old routes | `/operator` redirects to `/owner`. `/device`, `/terminal`, `/crew` redirect into the Crew app. `/app` and `/app/account` become the Rider app. | No printed QR or bookmark breaks. |
| Where the 3D comes from | **Built here with three.js**, procedural (no downloaded model file). `datajewellery-main/` has no 3D at all; its contribution is the design discipline (see §4). | Keeps the asset small enough for Nepali data plans and keeps the model honest to the real parts list. |

## 3. The three apps

### 3.1 Rider (`/app`, installs as "Bhada")

Home is the wallet, like eSewa: balance up top, one big **Ride** button, recent
trips below.

- **Ride** — the BT1 ride code (refreshes every 30 s), the phone's own
  odometer running, live fare estimate, and the receipt on alighting with the
  bus-vs-phone distance check. Unchanged logic from `src/screens/Ride.jsx`.
- **Family / group** — BG1 group code and companions (unchanged).
- **Stage-fare ticket** — BH1 path from `src/screens/Passenger.jsx`, reached
  from Ride when the bus is stage-fare.
- **Wallet** — balance with "as of" time when offline, statement, eSewa top-up,
  overdraft shown honestly (down to −Rs 50).
- **Trips** — receipts, each re-checkable; a stranded ride's claim (BD1) is a
  button on that trip, with the one-claim rule stated.
- **Me** — account link (AL1), passkey lock, NFC card, daily pseudonym note,
  language (Nepali / English), sign out.

Offline: everything except top-up and statement refresh. A queued receipt or
claim shows a small "will send" mark, never an error.

### 3.2 Crew (`/crew`, installs as "Bhada Crew")

The conductor's phone becomes the bus.

1. **Pair** — scan the owner's pairing QR once (existing `fleet.js`
   provisioning). Until paired, nothing else opens.
2. **Sign on** — CR1 from the conductor's own wallet (existing `Crew.jsx`
   logic). Shift lasts up to 14 h.
3. **Trip screen** (glance mode) — one camera viewfinder that reads every code
   a passenger can show and routes it by prefix:
   - `BT1` metered ride code: board or alight at the one door
     (`DOOR_ROLE.BOTH`), fare shown and spoken in recorded Nepali.
   - `BH1` stage-fare token: collected as today.
   - `BG1` group code, rider passes, NFC cards.
   Big tallies: passengers aboard / permit, collected, odometer.
   **Cash ride** button issues a CT1 ticket.
4. **Bus** — the instrument panel from `/device` folded into one sheet: fix
   quality, odometer, door tape, power, crew. The engineer detail sits behind
   "Details", not on the main screen.
5. **Shift** — the trip's clean-trip progress (5 legs, 90 % recorded share),
   the Rs 50 bonus status, and the sync queue.

The meter and door run in one tab and talk over the existing
`BroadcastChannel` link (two channel objects in one page do hear each other;
the plan verifies this before relying on it). `terminal.js` is not edited, so
`proof:validator` keeps holding.

### 3.3 Owner (`/owner`, installs as "Bhada Owner")

Online-first, but the last snapshot is kept in IndexedDB, so it opens with no
signal and says how old the figures are.

- **Today** — money in today, rides, buses running, a live map-free list of
  buses with their latest tally (Supabase Realtime when online).
- **Buses** — register by plate (zone / lot / series / number), routes, the
  pairing QR for a conductor's phone, per-bus history.
- **Crew** — conductors, clean-trip bonuses paid, power tamper events.
- **Money** — fare payable, bonuses taken out of it, settlement statement,
  and **withdraw** (asked for on 3 Oct): the owner requests a payout of the
  settled balance to a named eSewa or bank account; the platform admin approves
  and marks it paid. Nothing like this exists in the backend yet, so it is a new
  migration with an `admin_*` approve function and a `proof:legs` section
  (never more than settled-and-unpaid, one open request at a time, bonuses
  already netted out) before any screen offers it.
- **Reports** — DoTM return CSV, plausibility and dispute load.
- **The device** — the 3D validator model (§5), as a "coming to your bus"
  page.

Every section that `src/portals/operator/` has today is carried over; none is
dropped.

## 4. Design system

Taken from `datajewellery-main/` as discipline, not as a copy:

- **Restrained palette, one accent that carries meaning.** Jewellers: ivory,
  charcoal, antique gold. Bhada: warm paper `#f6f3ec`, ink `#15130f`, and
  **plate red `#a8202f`** for the primary action and the key figure only.
  Money in is green `#0c6b46`; the sign is always written.
- **Eyebrow labels** — small, tracked, uppercase over a large heading.
- **Hairline grids** — features and stats share one surface split by 1 px
  lines, never floating cards.
- **Trade language** — written for a Nepali bus, in Nepali first: "खलासी",
  "भाडा", "बिल्ला", stop names, not "resource" or "entity".
- **Tabular figures** everywhere money or distance appears.

Bhada's own additions:

- Type: Khand (figures, headings) and Mukta (body), already self-hosted.
- **Glance mode** — Ride and Trip screens: 56 pt+ figures, 7:1 contrast,
  no motion except the confirmation, readable in sun while holding a rail.
- **Dark mode** for all three apps, tokens on `:root` with a dark override.
- Motion: 140–200 ms, one easing; `prefers-reduced-motion` respected.
- Each app has its own tint of the same system (Rider: paper; Crew: ink, for
  night shifts and battery; Owner: paper with denser tables) so a phone held
  up is identifiable at a glance.
- Icons: the existing hand-drawn set in `src/portals/shared/Icon.jsx`, extended.
  No icon library (2G precache budget).
- Every list: loaded, loading (skeleton in the row's shape), empty, error.
- Tap targets 48 px; inputs 16 px.

Stack: stays React + plain CSS (no Tailwind added). One `tokens.css` and
component styles per app replace the seven current stylesheets as each app is
rebuilt; old sheets are deleted when nothing imports them.

## 5. Landing and the 3D model

Landing (`/`) is rebuilt around three doors: **Ride**, **Run a bus**,
**Work on a bus**, each a link into its app, plus the demo.

The 3D section: a procedural low-poly Sajha-style bus with the door validator
on the pillar, in three.js.

- Drag to orbit, scroll to walk through one ride: phone shows code → validator
  reads it → meter counts metres → fare on the screen → receipt back → sync
  when signal returns. Each step lights the part it uses.
- Tap a part (QR scanner, PN532 NFC, 2.8" screen, DS3231 clock, RS-485 line,
  DC-DC supply) for a card with what it does — taken from `validator/README.md`,
  saying plainly which parts are not yet proven on hardware.
- Loaded only when scrolled into view; excluded from the service-worker
  precache; under 250 KB gzipped with three.js tree-shaken.
- Fallback: a static drawing when WebGL is missing, the device is weak, or
  reduced motion is set.

The same component is reused on the Owner app's "The device" page.

## 6. Offline and sync

The engine exists (`src/device/sync.js`, IndexedDB outboxes). What is added is
behaviour the user sees:

- **One sync status** per app: online/offline, items waiting, last synced.
  A quiet pill, not a banner.
- **Automatic**: on the `online` event, on app focus, and every 30 s while
  online with items waiting; Background Sync where the browser has it.
- **Pull after push**: once the outbox drains, the Rider wallet and trips and
  the Owner snapshot refresh themselves.
- Nothing is ever lost by going offline mid-action; every write goes to the
  outbox first.

## 7. The conductor QR fault

Diagnosed before any redesign, as its own fix: the conductor screen carries its
own copy of the camera loop (`src/screens/Conductor.jsx:60-115`) instead of
`src/components/Scanner.jsx`, and it only accepts BH1 stage-fare tokens while
riders on metered buses now show BT1. Both are suspects; the fix is proven on a
phone camera, not assumed. The new Crew trip screen then uses one shared
scanner with prefix routing (§3.2).

## 8. What does not change

- `protocol/`, the migrations, both Edge Functions, `settleBatch()`, every rule
  in `AGENTS.md`.
- `src/device/terminal.js` and `validator/`.
- All five proofs pass before each phase is called done.

## 9. Phases

Each phase gets its own plan and is reviewed on screen before the next starts.

0. Conductor QR fix.
1. Design tokens, app shells, three manifests, routing and redirects, sync
   status.
2. Landing and the 3D model.
3. Rider app.
4. Crew app.
5. Owner app.
6. Reskin `/admin` and `/inspect`; delete the old stylesheets and screens.

## 10. Risks

- **Crew phone as the bus unit**: GNSS on a conductor's phone in a pocket is
  worse than a mounted unit. The meter's accuracy claims come from
  `proof:meter`; the trip screen asks for the phone to sit in a holder and
  shows fix quality plainly.
- **`datajewellery-main/` sits untracked inside the repo.** It must never be
  committed or uploaded by `vercel deploy`; it should go in `.gitignore` and
  `.vercelignore`, or move out of the repo.
- **Size**: three.js only on the landing and the Owner device page; the Rider
  and Crew precache must not grow by it.
- **Testing**: the portals need a login Claude does not type, so Owner screens
  are built against a mock with real-shaped data, then checked live by the
  owner.
