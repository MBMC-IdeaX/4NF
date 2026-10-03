# Debug and automation delivery

## Changes and reproduced defects

- Map route/callback reference changes previously rebuilt layers and reset bounds. Geometry
  now determines rebuilds; callbacks use the latest snapshot. Markers retain their DOM across
  telemetry ticks, selection uses stable bus IDs, and Follow is an explicit action. Dragging,
  zoom controls and wheel input pause following. Resize observers, visibility listeners and
  animation frames are cleaned up on remount. Tooltip metadata is escaped; bus icons need no
  third-party marker assets. Rider map selection now displays fresh bus details.
- Fleet simulation previously used equal stop-index fractions and moved after a suspended
  tab's entire elapsed time. It now interpolates configured chainage, dwells at stops, reverses
  at terminals, limits a resumed tick to two seconds, and changes occupancy only at stops.
  Clock/random injection supports reproducible tests. Subscriptions own the timer. Seats,
  standing passengers and unknown permitted capacity are labelled separately.
- A rider with no BH1 ticket previously had zero queued work despite an unregistered day key.
  The outbox now counts each unacknowledged certificate, including companions added later.
  Acknowledgements match the exact signed certificate. Identity creation/rotation and companion
  updates use write transactions, avoiding first-launch and acknowledgement races.
- Passenger receipts previously never uploaded. They now upload in bounded batches through
  the existing single settlement verifier, preserving original key certificates. The original
  tap travels if available; otherwise SQL must resolve the already filed `leg_taps` consent.
  `awaiting_tap` means the bus or door still needs to upload its evidence. No tap requirement
  is bypassed. Local receipts retain the server's reconciliation result.
- HTTP 200 previously advanced event cursors even when event appends failed. Each tape now
  has an explicit acknowledgement. Migration 0041 adds per-device event IDs and duplicate-safe
  append RPCs; acknowledged cursors alone advance. Cash shares the full chunk queue, including
  more than 150 tickets. Trip closes wait for the associated evidence acknowledgements.
- Meter and door queues include receipts, cash, standalone taps, crew sign-on trips, closed
  trips, counts and power/door tapes. Door uploads now run automatically. All upload callers
  share single-flight locks. Requests time out after 20 seconds. Saved partial progress remains
  durable, while transient backend errors surface to the existing scheduler's backoff.
  Reconnection no longer resets a backend failure's backoff.
- Claims retain transport errors, server errors and unknown-leg races. Successful verdicts,
  replay and documented final refusals clear the queue without deleting signed evidence.
  Final refusal reasons: bad_signature, too_late, not_your_leg, not_disputable,
  witness_outside_ride, phone_was_alive, witness_exceeds_ride, no_refund,
  refund_exceeds_charge. Unsupported records and other refusals remain available for retry/review.
- Receipt fare arithmetic previously produced a verified label without authenticating the
  bus. Migration 0042 exposes only the bus registry's public key through a narrow read RPC.
  The configured backend supplies keys, cached in IndexedDB for offline verification. A scanned
  record never supplies its own trust anchor. Unknown keys remain pending; forged signatures
  are rejected while retaining the active ride. Records bind passenger, vehicle and leg.
  Historical stage labels use the receipt's tariff version. Unsupported tariffs stay reviewable.
- A confirmed pass automatically starts riding; a verified receipt automatically opens the
  completed journey. Receipt persistence and ride closure are one transaction. Unverified
  completion evidence preserves the active ride. Active rides keep their original consent
  identity across daily rotation. Ending without a receipt archives the unfinished ride.
  Persisted state distinguishes ready, awaiting boarding confirmation, riding, exit receipt
  saved, awaiting reconciliation, settled, unpaid and review required. Local measuring is
  explicitly distinguished from confirmed boarding; ledger status is distinct from an
  externally confirmed transfer.
- Owner/staff loads refresh on focus, visibility return, reconnect, successful related writes
  and a 30-second interval. In-flight loads do not overlap, stale dependency responses are
  ignored, and previous data remains available while forms retain their edits. Successful
  reads do not broadcast write notifications. Reports clarify the separate money records.

## Local demo

Run `npm ci`, then `npm run demo:phones`. This starts the backend on 8787 and the five HTTPS
servers on 5199, 5201, 5202, 5203 and 5204. The command validates dependencies, available ports
(including IPv6 conflicts), LAN addresses and server readiness. Its printed role links use
one discovered HTTPS LAN address through the existing proxy. Child failures stop its owned
processes; Ctrl+C stops the process tree. No local data is deleted on startup.

Credentials remain the existing local accounts, password `bhada-demo-2026`:
`owner@demo.bhada.np`, `manager@demo.bhada.np`, `conductor@demo.bhada.np`, `rider@demo.bhada.np`,
`reviewer@demo.bhada.np`, `admin@demo.bhada.np`, `busowner@demo.bhada.np` (use the actual startup
output as the definitive role/account list). These are not live accounts.

On a fresh local demo device, open `/crew?presentation=1`, then choose **Start local
presentation**. The single action selects DEMOBUS01 and starts the existing bench drive.
There is no synthetic crew sign-on or approval shortcut. Already configured real buses refuse
this shortcut. A device already configured for the demo uses its normal bench controls.

For an isolated second instance, set `BHADA_DEMO_BACKEND_PORT`, `BHADA_DEMO_PORT_OFFSET` and
`BHADA_LOCAL_DATA_DIR` to unused ports and a separate data directory. For example, the smoke
script uses backend 8891, port offset 200 and a new `.bench/demo-smoke-*` directory, with isolated
uploaded files. It preserves that directory for inspection. Do not open the same PGlite data
directory from two processes.

## Verification

Baseline: 74 Node tests, all five proofs, all five app builds passed.

Final checks:

- `npm test`: 82 tests, including real client outbox/uploads, acknowledgements, cash chunking,
  partial progress, transient claims, 20-second transport timeout, chainage and forged receipts.
- `npm run proof:all`: BH1 handshake, meter, reconciliation, legs and validator.
- `npm run sync:protocol`: generated backend protocol refreshed.
- `npm run build`: all five apps.
- `npm run test:browser`: three Chromium workflows. Map panning/zooming over 20+ updates,
  unchanged marker DOM, fresh click snapshots/callbacks, hide/show/remount and escaped tooltips;
  a cached offline ride through boarding, reload, forged receipt rejection, receipt save,
  automatic reconnect upload and repeated upload; owner refresh with stale responses and edits.
- `node scripts/demo-phones-smoke.mjs`: isolated backend and five HTTPS servers became ready
  and printed role links; its owned process tree was stopped.
- `git diff --check`: clean.

CI runs Node tests, all proofs, generated protocol checks, all app builds and Chromium checks.
For browser checks locally, run `npx playwright install chromium` once. The browser fixture
builds into `.bench/browser-build`, outside production `dist/`, and uses an in-memory local backend. Scanner
injection requires `VITE_BROWSER_TESTS=1` and localhost; normal builds omit it. The offline
check uses the actual Ride component, IndexedDB, a built service worker, registry verification
and sync client; test-generated records replace a physical camera exchange.

## Warnings and limits

- Existing Vite warnings include large chunks and PGlite browser externalisation/eval warnings.
  Browser test tooling also prints a harmless FORCE_COLOR/NO_COLOR warning.
- `npm audit` reports three development dependency findings: brace-expansion and fast-uri
  (high), serialize-javascript (low). `npm audit --omit=dev` reports zero findings. No broad
  dependency upgrades were included; Playwright is the sole added direct test dependency.
- Simulation remains straight interpolation between configured stops, not road-level GPS or a
  field trial. Seat values are synthetic and permitted total capacity is unknown when absent.
- The browser checks do not validate physical cameras, QR scanning angles, NFC, GNSS receivers,
  Pi hardware or two disconnected real phones. Physical taps and supported QR exchanges,
  browser permissions, operator approvals and payment agreements remain human actions.
- An offline phone needs a previously cached registry key to authenticate a bus immediately.
  Unknown boarding passes are saved pending verification. Registry key replacement can make an
  old receipt unverifiable locally; historical vehicle-key version provisioning is not added.
- A passenger receipt without its tap cannot settle before the original bus/door tap reaches
  the backend. A legacy active ride without a saved consent identity retains the older behaviour
  at rollover; new rides preserve their original identity. A replay establishes an existing
  ledger record but does not by itself report the wallet's current unpaid balance or prove an
  external payment. Account statements remain the authoritative wallet view.
- Rejected/unsupported evidence is retained. A corrupt record may keep the sync queue pending
  for review rather than being discarded. Local-only measurements are not confirmed boarding.
- Migrations 0041/0042 and the matching backend must be applied together before these clients
  are released. Legacy clients without event IDs retain their existing append behaviour.
- This delivery does not deploy production, publish official fares, change immutable tariffs,
  approve legal onboarding, create live demo accounts, accept real money or execute payouts.
