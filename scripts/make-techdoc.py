"""
Builds Bhada-tech-and-prep.pdf — the technical dossier and the preparation plan.

Three documents ship for the pitch and they do different jobs:

    Bhada-slides.pptx        what is on the wall. Headlines and numbers.
    Bhada-pitch.pdf          what you read from. Every word you say.
    Bhada-tech-and-prep.pdf  this. What you need to KNOW, and what you need to DO.

This one is not read aloud. It is the thing you study the night before and the
thing you hand a technical judge who asks "so what is it actually built on".
Every claim in it is checkable against the repository, and where something is
not built yet it says so in the same voice as everything else.

    python scripts/make-techdoc.py
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "Bhada-tech-and-prep.html"
PDF = ROOT / "Bhada-tech-and-prep.pdf"

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "chromium",
]


def find_chrome():
    for c in CHROME_CANDIDATES:
        if os.path.isfile(c):
            return c
        found = shutil.which(c)
        if found:
            return found
    return None


# ============================================================== 1. the shape

SHAPE = [
    ("On the bus, offline", [
        "<b>Door terminal A</b> — a phone at the boarding door. Reads a tap, issues a "
        "signed boarding pass, refuses to open a ride when the bus is full.",
        "<b>The meter</b> — the unit under the seat. Turns GNSS fixes into an odometer, "
        "holds the roster, runs the door interlock, keeps the tape, emits telemetry.",
        "<b>Door terminal B</b> — a phone at the alighting door. Verifies the pass, "
        "resolves the distance, prices the ride, signs the receipt.",
        "They find each other over the <b>vehicle bus</b>. If that is down, the signed "
        "pass on the passenger carries the ride between them instead.",
    ]),
    ("When a network appears", [
        "<b>Edge Function (Deno)</b> — imports the same <code>protocol/</code> code the "
        "phones run, re-verifies both signatures, re-prices from the published tariff, "
        "and refuses anything whose arithmetic does not reproduce.",
        "<b>Postgres</b> — <code>settle_fare()</code> and <code>settle_leg()</code> own "
        "the money and the once-only rule. Unique indexes, not application code, are "
        "what actually stop a double charge.",
        "<b>Operator dashboard</b> — a separate lazy-loaded bundle. Never precached, "
        "because it is an office tool that always has a network.",
    ]),
]

# ============================================================== 2. the stack

STACK = [
    ("Application shell", "React 19 + Vite 7, installed as a PWA",
     "A PWA installs from a link — no store review, no APK to sideload, no update the "
     "fleet has to be told about. A conductor with a Rs 8,000 Android phone is running "
     "it in thirty seconds.",
     "React Native / Expo Go — Expo Go must fetch the JS bundle over the LAN before it "
     "runs, which fails the one requirement. A standalone APK works but costs a build "
     "pipeline and a per-device install."),

    ("Offline capability", "vite-plugin-pwa (Workbox), precache 1.4 MB",
     "Everything needed to cold-start in airplane mode is precached on install, "
     "Devanagari fonts included. The service worker serves the app with the radio off.",
     "Runtime caching alone — a phone that has never loaded a route while online would "
     "have nothing to serve."),

    ("Shared core", "Platform-free ESM in <code>protocol/</code>",
     "The same file runs in the browser, in Deno on the edge, and in Node in the proof "
     "scripts. A fare dispute is settled by re-running the arithmetic, and it has to be "
     "the same arithmetic.",
     "A shared npm package — versioning drift between three deployment targets is "
     "exactly the bug this rule exists to prevent."),

    ("Randomness", "Injected at startup via <code>useRandomSource()</code>",
     "Node, Deno and the browser all supply entropy differently. The protocol takes it "
     "as a parameter and stays platform-free.",
     "<code>import 'node:crypto'</code> — would break the browser and the edge."),

    ("Signatures", "ed25519 via tweetnacl",
     "6 KB, audited, identical behaviour everywhere. 64-byte signatures fit in a QR, "
     "verification is about a millisecond, which matters inside a scan loop.",
     "Web Crypto — no ed25519 in the browsers this has to run on. RSA — signatures too "
     "large for a QR code."),

    ("Encoding", "base64url, hand-written",
     "No <code>Buffer</code>, no <code>atob</code>. Both are platform-specific and one "
     "of them is missing wherever you need the other.",
     "A library — 40 lines is not worth a dependency that then has to be audited for "
     "platform assumptions."),

    ("On-device storage", "IndexedDB via <code>idb</code>, schema v3",
     "Real transactions and real unique indexes. Recording a fare and moving the wallet "
     "must be one atomic write, and the replay guard has to be enforced by the store.",
     "localStorage — no transactions, no indexes. A crash between two writes leaves a "
     "signed ticket the wallet has no record of paying for."),

    ("Distance sensing", "Geolocation <code>watchPosition</code> + a four-gate filter",
     "The cheapest distance sensor that exists on every phone and every ESP32 board. "
     "Raw integration is unusable, so the filter is the product.",
     "A maps or map-matching API — needs a network, costs money per request, and would "
     "put a third party on the path of taking a fare."),

    ("Vehicle bus", "BroadcastChannel + Supabase Realtime, dynamically imported",
     "Stands in for the RS-485 cable three boards share on real hardware. Both carriers "
     "are published to and deduplicated at the receiver, so losing either degrades the "
     "link rather than breaking it.",
     "Realtime alone — 220 KB in the precache for code that only works online. It is "
     "dynamically imported so a terminal that never sees a network never downloads it."),

    ("QR out", "<code>qrcode</code> to a data URL",
     "Renders straight to an <code>&lt;img&gt;</code>. No canvas plumbing.", ""),

    ("QR in", "<code>BarcodeDetector</code>, falling back to <code>jsQR</code>",
     "BarcodeDetector is native on Chrome Android — fast and battery-cheap. jsQR covers "
     "everything else, decoding a 640 px downscale at 8 frames a second.",
     "Full-resolution decoding every frame — heats a cheap phone and drains it."),

    ("Backend compute", "Supabase Edge Function on Deno",
     "One function, nothing to keep alive, and it imports the same protocol code. "
     "<code>npm run sync:protocol</code> copies <code>protocol/</code> in and pins bare "
     "specifiers, because Deno cannot import from outside its own tree.",
     "A long-running Node server — something else to pay for and to keep up during "
     "judging."),

    ("Database", "Supabase Postgres, ap-south-1 (Mumbai)",
     "Money rules live in <code>plpgsql</code> plus unique indexes, so correctness does "
     "not depend on application code being called correctly. Region chosen for latency "
     "from Kathmandu.",
     "Firestore or similar — no transactional guarantees of the shape a ledger needs."),

    ("Access control", "Row Level Security, anon key read-only on reference data",
     "The anon key ships inside the bundle; it is public by construction. RLS means it "
     "can read the fare table and the tariff and nothing else. All money moves through "
     "the Edge Function with the service role, after a signature check.",
     "Trusting the client — the anon key could otherwise INSERT into wallet top-ups."),

    ("Hosting", "Vercel, static output + SPA rewrites",
     "Static, HTTPS (the camera needs a secure origin), correct MIME types, free. "
     "<code>vercel.json</code> holds the rewrite that keeps deep links working and the "
     "cache headers that stop a stale service worker sticking.",
     "Supabase Storage — not a static host; wrong MIME types for a PWA."),

    ("Typography", "Khand + Mukta, self-hosted and subset",
     "Real Devanagari, condensed and signage-like. Self-hosted because a font CDN is "
     "unreachable in airplane mode and a fallback loses Devanagari entirely.",
     "Google Fonts CDN — the one asset that would break the offline claim."),

    ("Local testing", "PGlite (Postgres 18.3 in WASM)",
     "Runs the real migration and the real <code>settle_fare()</code> in-process, with "
     "no Docker, so the reconciliation proof tests the actual SQL.",
     "A mocked database — would prove nothing about the constraints that matter."),
]

REJECTED = [
    ("Blockchain", "Adds a network dependency to a system whose entire premise is not "
     "needing one, and solves a trust problem we solve with two signatures and a "
     "published tariff."),
    ("Any login", "There is no account system. A device is an account, identified by "
     "its public key. Nothing to forget, nothing to phish, nothing to sell."),
    ("Microservices", "One Edge Function and one database. The complexity budget is "
     "spent on the offline path, where it earns something."),
    ("An AI feature", "Nothing here is a prediction problem. Every number is measured "
     "or computed from a published rule, which is the only way a fare can be argued "
     "with."),
]

# ============================================================== 3. protocol

TOKENS = [
    ("BH1", "Stage fare ticket", "passenger", "conductor phone",
     "The original path: passenger picks two stops, signs the fare. Unchanged, still works."),
    ("BT1", "Tap", "passenger", "door terminal",
     "“I, this key, am boarding this vehicle at this door, now.” Valid 120 seconds."),
    ("BO1", "Boarding pass", "vehicle", "the other door terminal",
     "Carries the odometer reading and position at boarding. Travels on the passenger, "
     "which is what lets two doors work with no link between them. 198 characters."),
    ("BM1", "Leg receipt", "vehicle", "the backend",
     "The completed ride and its arithmetic. Re-verified and re-priced server-side "
     "before any value moves."),
]

FIELDS = [
    ("vehicleId", "which bus"),
    ("tripId", "which shift"),
    ("legId", "which ride — the replay key"),
    ("passengerPublicKey", "who — the account, 43 chars base64url"),
    ("boardDoorId / alightDoorId", "which door"),
    ("unitId", "which odometer the readings came from"),
    ("boardOdoM / alightOdoM", "metres, integers"),
    ("distanceM + distanceSource", "how far, and how we know"),
    ("boardAt / alightAt", "unix seconds"),
    ("concession", "none / student / senior / staff"),
    ("amount + tariffCode", "the fare and the rulebook it came from"),
    ("signature", "ed25519, 64 bytes, base64url"),
]

# ============================================================== 4. formulas

FORMULAS = [
    ("Distance between two fixes",
     "a = sin²(Δφ/2) + cos φ₁ · cos φ₂ · sin²(Δλ/2)\nd = 2R · asin(√a)      R = 6 371 008.8 m",
     "Haversine on the IUGG mean radius. Not the equirectangular shortcut, whose error "
     "grows with latitude."),
    ("The odometer",
     "odometer = Σ d(fixᵢ₋₁, fixᵢ)   over fixes passing all four gates\n\n"
     "  accuracy   ≤ 35 m        a vaguer fix says nothing about distance\n"
     "  deadband   ≥ 8 m         below this it is receiver wander, not travel\n"
     "  speed      ≤ 33 m/s      120 km/h is multipath, not a bus\n"
     "  gap        Δt > 45 s     counted, but marked unverified",
     "A rejected step adds no distance but still becomes the new anchor — otherwise "
     "every later fix is measured from a point the bus has left."),
    ("Road distance from endpoints",
     "road ≈ haversine(board, alight) × 1.3",
     "The circuity factor for a dense urban grid. Only ever used for an estimate, and "
     "an estimate is labelled as one on the receipt."),
    ("The fare",
     "fare  = min( 25 , 15 + ⌈ max(0, km − 2) / 1 ⌉ × 3 )\n"
     "final = ⌈ fare × concession ⌉        1.0 / 0.5 / 0.5 / 0",
     "Floor is today's minimum stage fare, ceiling is today's end-to-end fare. "
     "Rounded up to the rupee: a conductor cannot make change in paisa."),
    ("Occupancy",
     "seatsLeft    = capacity − onboard\n"
     "atCapacity   = onboard ≥ capacity\n"
     "nearCapacity = onboard / capacity ≥ 0.9",
     "42 on this vehicle — 30 seated plus 12 standing, from the route permit."),
    ("Uplink frame",
     "32 bytes, 1 Hz, CRC-32 over the first 28\n"
     "version · flags · occupancy · capacity · odometer · lat µ° · lon µ° ·\n"
     "speed cm/s · unix seconds · open legs · accrued · crc",
     "The same telemetry as JSON is ~210 bytes. Fits a LoRa SF9 payload; survives a "
     "2G SIM billed by the kilobyte."),
]

# ============================================================== 5. data model

TABLES = [
    ("passengers", "public key is the primary key — the device is the account"),
    ("vehicles", "plate, operator, route + public_key, capacity, firmware (0007)"),
    ("tariffs", "published distance tariff, never overwritten; a change is a new row"),
    ("transactions", "settled stage fares. UNIQUE(passenger, sequence) is the replay guard"),
    ("legs", "settled distance rides, with distance_source and the raw BM1 receipt"),
    ("door_events", "the interlock tape: every lock, refusal, override, with the counts"),
    ("wallet_topups", "every credit leaves a row with a source and a unique reference"),
    ("trips", "a conductor's shift"),
    ("views", "trip_totals · ridership_by_hour · leg_economics · overload_log · wallet_audit"),
]

# ============================================================== 6. security

THREATS = [
    ("Passenger clones their wallet",
     "Offline spend cap of Rs 500 and a 24-hour settlement window bound the exposure. "
     "Whichever copy settles first wins; the other is rejected as a replay."),
    ("Passenger denies the ride",
     "The leg was opened by a BT1 they signed. The backend re-verifies it."),
    ("Operator invents rides",
     "A receipt is signed by the vehicle but the ride it closes was opened by the "
     "passenger's own key. No passenger key, no fare."),
    ("Operator inflates the fare",
     "The Edge Function re-prices from the published tariff and refuses a mismatch."),
    ("Operator feeds the box fake GPS",
     "Not eliminated — the same surface every taximeter has. Mitigated by keeping the "
     "trace and by <code>leg_economics</code> exposing a route whose distances stop "
     "matching its geometry. Stated as a limit, not hidden."),
    ("Someone reuses a boarding pass",
     "legId is the replay key, checked on the terminal and again in Postgres."),
    ("Someone swaps the meter for a cloned box",
     "The vehicle key is frozen on first sight. A second key for the same plate comes "
     "back as <code>key_mismatch</code> and needs an operator decision."),
    ("Anon key abuse",
     "RLS: read-only on stops, routes, fares and tariffs. Nothing else. All writes go "
     "through the Edge Function behind a signature check."),
    ("Crew forces the door",
     "Override always opens — safety first — and always writes an audited row with the "
     "passenger count at that moment."),
]

# ============================================================== 7. commands

COMMANDS = [
    ("npm run dev", "Vite dev server with a self-signed cert, so the camera works over the LAN"),
    ("npm run build", "production build into dist/, precache manifest included"),
    ("npm run serve", "plain-HTTP static server for testing the service worker on localhost"),
    ("npm run proof", "the offline handshake, headless — no browser, no server"),
    ("npm run proof:meter", "odometer, tariff, doors, receipts, CRC — 21 assertions"),
    ("npm run proof:reconcile", "settlement against real Postgres in WASM (PGlite)"),
    ("npm run sync:protocol", "copy protocol/ into the Edge Function tree. Run after every protocol edit"),
    ("npm run sync:local", "the sync endpoint locally, on real Postgres"),
    ("npm run fonts / icons", "regenerate the subset typefaces and the PWA icons"),
    ("python scripts/make-deck.py", "rebuild Bhada-slides.pptx"),
    ("python scripts/make-pitch.py", "rebuild Bhada-pitch.pdf"),
    ("python scripts/make-techdoc.py", "rebuild this document"),
    ("vercel deploy --prod --yes", "ship it"),
]

ENV = [
    ("VITE_SUPABASE_URL", "project URL. Public."),
    ("VITE_SUPABASE_ANON_KEY", "public by design — safe because of RLS."),
    ("VITE_SYNC_URL", "the Edge Function endpoint. Without it, everything still works offline; "
                      "the upload button is simply disabled."),
    ("SIGNUP_CREDIT_NPR", "server-side. Demo credit for an unseen device. Unset it before "
                          "this is near real money."),
]

ROUTES = [
    ("/", "landing page — the operator-facing pitch"),
    ("/app", "role picker: passenger or conductor (the stage-fare path)"),
    ("/device", "the meter console. The bus interface."),
    ("/terminal?door=A", "boarding door terminal"),
    ("/terminal?door=B", "alighting door terminal"),
    ("/operator", "operator dashboard, online only"),
]

# ============================================================== 8. preparation

PREP_NIGHT = [
    "Read <b>Bhada-pitch.pdf</b> out loud twice, standing up, with a timer. Three "
    "minutes total. If you run over, cut sentences from slide 6 first — it is the most "
    "compressible.",
    "Run <code>npm run proof:meter</code> once so you have seen the output. A judge may "
    "ask you to run it.",
    "Open <code>bhada-one.vercel.app/device</code> on the laptop and "
    "<code>/terminal?door=A</code> and <code>?door=B</code> on both phones. Pair both "
    "phones. Do this tonight, not tomorrow — pairing is the only step that needs a "
    "camera and good light.",
    "Enrol four cards with real-sounding names. They persist, so they will still be "
    "there tomorrow.",
    "Charge both phones and the laptop to 100%. Put both phones on a charger overnight.",
    "Decide who says which slide, and who drives the demo. Two people minimum: one "
    "talking, one tapping.",
    "Fill in the four team names on slides 1 and 7 of the PPTX. Do not leave "
    "[Name] on the screen.",
]

PREP_MORNING = [
    "Phones: brightness to maximum, auto-lock to <b>never</b>, do-not-disturb on, "
    "airplane mode <b>off</b> for now.",
    "Laptop: notifications off, dock hidden, browser in a clean window with only the "
    "three tabs open. Zoom at 100%.",
    "Test the projector early. The deck is 16:9. If the projector is 4:3 the slides "
    "letterbox and still read — do not rebuild anything on the day.",
    "Open the three tabs and leave them open. Do not reload during the pitch; the "
    "meter's uptime and odometer are more convincing when they have been running.",
    "Start the bench drive on the laptop about five minutes before you go on, so the "
    "odometer already reads a few kilometres when the slide comes up.",
    "Put the PDF on paper. Not on the phone you are about to demo with.",
]

PREP_STAGE = [
    "Laptop on the projector shows the slides. The meter console lives on a second tab, "
    "one keystroke away.",
    "Phone A to the person who will board. Phone B stays with you or with a second "
    "presenter, at the other side of the stage if there is room.",
    "Talk to the room, not the screen. You only need to look at the deck twice: slide 2 "
    "for the two numbers, slide 3 for the console.",
    "When you say “turn the wifi off”, actually turn it off on phone A. That sentence "
    "is worth more demonstrated than claimed.",
    "If a judge interrupts, answer the question and then say “which brings me to…” and "
    "rejoin. Do not restart the slide.",
]

FAILURES = [
    ("No GPS indoors", "Press <b>Run bench drive</b> on the meter console. It feeds "
     "scripted fixes through exactly the same filter. Say so out loud — it is a bench "
     "harness, not a fake, and the honesty plays better than pretending."),
    ("No wifi / no mobile data at the venue",
     "Open all three surfaces as tabs on the one laptop. They find each other over "
     "BroadcastChannel. The whole demo runs with the network cable pulled out."),
    ("A phone will not pair", "Use <b>Type a pass instead</b> on the terminal and paste "
     "the pairing code from the console's text box. Same result, no camera."),
    ("A phone dies", "Every card and every open ride is in the browser's storage on the "
     "other device too. Carry on with one phone: tap in and tap out on the same one — "
     "it prices from the meter's odometer either way."),
    ("The demo refuses a tap", "Read the reason on screen. It is almost certainly "
     "<i>bus is full</i> — the capacity is at 42 by default but you may have lowered it "
     "for the overload demo. Raise it with the + button."),
    ("The projector cannot see the browser",
     "Every number on the console also appears in the deck. Talk to slide 3 and skip "
     "the live demo; the offer to run it afterwards is enough."),
    ("You run out of time", "Cut slide 6 to one sentence: “it is all built, twenty-one "
     "tests pass, ask me anything.” Never cut slide 7 — the roadmap and the live link "
     "are what they remember."),
]

BRING = [
    "Laptop + charger", "Two Android phones, charged", "Both phone chargers",
    "HDMI adapter for the laptop", "Bhada-pitch.pdf printed",
    "A phone hotspot as a network fallback", "Something to point with",
]

REHEARSE = [
    ("Round 1 — alone, sitting", "Read the PDF end to end. Fix any sentence you stumble "
     "on. Do not memorise; make it sound like you."),
    ("Round 2 — standing, with the deck", "Click through the real slides. Learn where "
     "each click falls. Time it."),
    ("Round 3 — full dress", "Phones out, demo running, someone playing judge and "
     "interrupting once. Practise rejoining after an interruption."),
]

LIMITS = [
    "It has never run on a moving bus. The odometer is proven against a scripted drive "
    "with injected receiver noise; real Kathmandu multipath is untested.",
    "The door actuator is not wired to anything. The interlock decides, refuses and "
    "logs; on a bus with no actuator that is advice to the conductor, not a mechanism.",
    "The camera scan path has not been tested on real phone hardware — headless "
    "browsers have no camera. The paste path through identical code is proven.",
    "The distance tariff is a proposal, not a gazetted fare.",
    "Offline double-spend is bounded by the Rs 500 cap, not eliminated.",
    "A device is an account: no recovery, no key rotation, no multi-device.",
    "iOS is second class. Demo on Android.",
]

GLOSSARY = [
    ("GNSS", "the general name for satellite positioning. GPS is one of them."),
    ("Odometer", "the running total of distance the vehicle has travelled."),
    ("Fix", "one position reading from the satellite receiver."),
    ("Multipath", "a satellite signal bouncing off a building before it arrives, which "
     "makes the receiver think the bus jumped sideways."),
    ("Deadband", "a movement small enough that we treat it as noise rather than travel."),
    ("PWA", "a website that installs like an app and works offline."),
    ("Signature", "a stamp made with a secret key that anyone can check but nobody can "
     "forge."),
    ("Replay", "trying to use the same ticket twice."),
    ("Leg", "one passenger's ride, from tap-in to tap-out."),
    ("Tariff", "the published rulebook that turns a distance into a price."),
    ("Interlock", "a safety rule wired into the machine, not left to the operator."),
    ("Settlement", "moving the money after the ride, once there is a network."),
]

CSS = """
@page { size: A4; margin: 15mm 15mm 14mm; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font: 10pt/1.5 "Segoe UI", system-ui, sans-serif; color: #16130f; }
code { font: 9pt/1.4 Consolas, ui-monospace, monospace; background: #f0eee7; padding: 0 2pt; }

.mast { border-bottom: 2.5pt solid #a8202f; padding-bottom: 9pt; margin-bottom: 12pt; }
.mast h1 { font: 700 25pt/1 "Bahnschrift SemiBold Condensed", "Segoe UI", sans-serif; }
.mast p { color: #6d675c; font-size: 10pt; margin-top: 4pt; }

h2 { font: 700 17pt/1.1 "Bahnschrift SemiBold Condensed", "Segoe UI", sans-serif;
     margin: 16pt 0 9pt; padding-top: 10pt; border-top: 2.5pt solid #a8202f; break-after: avoid; }
/* The masthead already draws a rule; a second one directly under it reads as a
   printing mistake rather than a section break. */
h2:first-of-type { border-top: 0; padding-top: 0; margin-top: 2pt; }
h3 { font: 700 12pt/1.2 "Bahnschrift SemiBold Condensed", "Segoe UI", sans-serif;
     margin: 11pt 0 5pt; break-after: avoid; }
p.lede { color: #3c372f; margin-bottom: 8pt; }

table { width: 100%; border-collapse: collapse; margin-bottom: 8pt; }
td, th { padding: 5pt 8pt 5pt 0; border-bottom: 1px solid #e6e2d9; vertical-align: top;
         text-align: left; font-size: 9.5pt; }
th { font-size: 8pt; text-transform: uppercase; letter-spacing: .07em; color: #6d675c;
     border-bottom: 1.5pt solid #a8202f; font-weight: 600; }
tr { break-inside: avoid; }
td.k { font-weight: 600; width: 26%; }
td.k2 { font-weight: 600; width: 20%; color: #a8202f; }
td.mono { font: 9pt/1.4 Consolas, monospace; width: 30%; }
td.why { color: #3c372f; }
td.no { color: #6d675c; font-size: 9pt; }

ul, ol { padding-left: 15pt; margin-bottom: 8pt; }
li { margin-bottom: 3pt; break-inside: avoid; }
ul.tight li { margin-bottom: 2pt; }

.box { background: #f4f2ec; border-left: 3pt solid #16130f; padding: 9pt 11pt; margin-bottom: 10pt;
       break-inside: avoid; }
.box h3 { margin-top: 0; }
.box p { font-size: 9.5pt; margin-bottom: 4pt; }
.box p:last-child { margin-bottom: 0; }
.box ul { margin-bottom: 0; }

pre { font: 9pt/1.45 Consolas, monospace; background: #f0eee7; padding: 7pt 9pt;
      margin: 4pt 0 5pt; white-space: pre-wrap; break-inside: avoid; }
.note { font-size: 9pt; color: #6d675c; margin-bottom: 9pt; }

.chips { font-size: 9.5pt; color: #3c372f; }
.chips b { color: #16130f; }
"""


def rows(items, classes):
    out = []
    for item in items:
        cells = "".join(f"<td class='{c}'>{v}</td>" for c, v in zip(classes, item))
        out.append(f"<tr>{cells}</tr>")
    return "".join(out)


def html():
    p = ["<!doctype html><html><head><meta charset='utf-8'>",
         "<title>Bhada — tech stack and preparation</title>",
         f"<style>{CSS}</style></head><body>"]

    p.append("<div class='mast'><h1>Bhada — the tech, A to Z, and how we prepare</h1>"
             "<p>Not read aloud. This is what you study the night before, and what you "
             "hand a judge who asks what it is actually built on. Everything here is "
             "checkable against the repository.</p></div>")

    # ---- the shape
    p.append("<h2>1 · What the thing is</h2>")
    p.append("<p class='lede'>Three devices on a bus that do not need the internet, and "
             "a backend that checks their work when they eventually find some.</p>")
    for title, lines in SHAPE:
        p.append(f"<h3>{title}</h3><ul class='tight'>")
        for line in lines:
            p.append(f"<li>{line}</li>")
        p.append("</ul>")

    p.append("<div class='box'><h3>The one architectural rule</h3>"
             "<p><code>protocol/</code> must never import anything platform-specific. It "
             "is the only code that runs in all three places — browser, Deno, Node — and "
             "a single <code>import 'node:crypto'</code> would break two of them. "
             "Randomness is injected; position fixes and timestamps are handed in.</p></div>")

    # ---- the stack
    p.append("<h2>2 · The stack, layer by layer</h2>")
    p.append("<table><tr><th>Layer</th><th>Choice</th><th>Why</th><th>Rejected</th></tr>")
    p.append(rows(STACK, ["k", "mono", "why", "no"]))
    p.append("</table>")

    p.append("<h3>Deliberately not used</h3><table>")
    p.append(rows(REJECTED, ["k", "why"]))
    p.append("</table>")

    # ---- protocol
    p.append("<h2>3 · The protocol</h2>")
    p.append("<p class='lede'>Four token formats. Every one is a single line of text that "
             "fits in a QR code, and every one carries its own signature.</p>")
    p.append("<table><tr><th>Token</th><th>What</th><th>Signed by</th><th>Checked by</th>"
             "<th>Notes</th></tr>")
    p.append(rows(TOKENS, ["k2", "k", "why", "why", "no"]))
    p.append("</table>")
    p.append("<h3>Fields a leg receipt carries</h3><table>")
    p.append(rows(FIELDS, ["mono", "why"]))
    p.append("</table>")
    p.append("<p class='note'>Fields are joined with <code>|</code> and every free-text "
             "field is restricted to the base64url alphabet, so no field can impersonate "
             "another by containing the separator.</p>")

    # ---- formulas
    p.append("<h2>4 · Every formula</h2>")
    for title, formula, why in FORMULAS:
        p.append(f"<h3>{title}</h3><pre>{formula}</pre><p class='note'>{why}</p>")

    # ---- data
    p.append("<h2>5 · The database</h2>")
    p.append("<p class='lede'>Seven migrations. Devices are the source of truth for what "
             "happened on the bus; this schema is the source of truth for money, and it "
             "only moves value after a signature has been checked, once.</p>")
    p.append("<table>")
    p.append(rows(TABLES, ["mono", "why"]))
    p.append("</table>")
    p.append("<div class='box'><h3>The load-bearing constraints</h3>"
             "<p><code>UNIQUE (passenger_public_key, sequence_number)</code> on "
             "transactions, and <code>legs.leg_id</code> as a primary key. Two devices "
             "syncing the same fare at the same moment race past any existence check; "
             "the index is what actually enforces once-only, and both settlement "
             "functions catch <code>unique_violation</code> and report it as a replay "
             "rather than an error.</p></div>")

    # ---- security
    p.append("<h2>6 · Threats, and what stops them</h2><table>")
    p.append("<tr><th>Someone tries to…</th><th>What happens</th></tr>")
    p.append(rows(THREATS, ["k", "why"]))
    p.append("</table>")

    # ---- running it
    p.append("<h2>7 · Running it</h2>")
    p.append("<h3>Commands</h3><table>")
    p.append(rows(COMMANDS, ["mono", "why"]))
    p.append("</table>")
    p.append("<h3>Environment</h3><table>")
    p.append(rows(ENV, ["mono", "why"]))
    p.append("</table>")
    p.append("<h3>Routes</h3><table>")
    p.append(rows(ROUTES, ["mono", "why"]))
    p.append("</table>")

    # ---- preparation
    p.append("<h2>8 · Preparation — the night before</h2><ol>")
    for step in PREP_NIGHT:
        p.append(f"<li>{step}</li>")
    p.append("</ol>")

    p.append("<h3>Rehearsal, three rounds</h3><table>")
    p.append(rows(REHEARSE, ["k", "why"]))
    p.append("</table>")

    p.append("<h2>9 · The morning, and the stage</h2>")
    p.append("<h3>Before you leave</h3><ol>")
    for step in PREP_MORNING:
        p.append(f"<li>{step}</li>")
    p.append("</ol>")
    p.append("<h3>On stage</h3><ol>")
    for step in PREP_STAGE:
        p.append(f"<li>{step}</li>")
    p.append("</ol>")
    p.append("<h3>Bring</h3><p class='chips'>" + " &nbsp;·&nbsp; ".join(f"<b>{b}</b>" for b in BRING) + "</p>")

    p.append("<h2>10 · When something breaks</h2>")
    p.append("<p class='lede'>Every one of these has a fix that takes under ten seconds. "
             "Read this page twice; you will not have time to look it up.</p><table>")
    p.append("<tr><th>If</th><th>Then</th></tr>")
    p.append(rows(FAILURES, ["k", "why"]))
    p.append("</table>")

    p.append("<h2>11 · What we do not claim</h2>")
    p.append("<p class='lede'>Say these before a judge finds them. A demo that hides its "
             "limits is the reason the last three attempts are remembered badly.</p><ul>")
    for limit in LIMITS:
        p.append(f"<li>{limit}</li>")
    p.append("</ul>")

    p.append("<h2>12 · Words a judge might not know</h2><table>")
    p.append(rows(GLOSSARY, ["k", "why"]))
    p.append("</table>")

    p.append("</body></html>")
    return "\n".join(p)


def main():
    HTML.write_text(html(), encoding="utf-8")
    chrome = find_chrome()
    if not chrome:
        print(f"wrote {HTML.name}. No Chrome found — open it and print to PDF by hand.")
        return 0
    subprocess.run(
        [chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer",
         f"--print-to-pdf={PDF}", HTML.as_uri()],
        check=True, capture_output=True,
    )
    print(f"wrote {PDF.name} (from {HTML.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
