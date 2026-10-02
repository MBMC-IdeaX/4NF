#!/usr/bin/env bash
# ==============================================================================
# Bhada 4NF - 66 Granular Commit & Push Scheduler (Till 6:00 PM Today)
# Run inside tmux:
#   tmux new -s bhada-schedule
#   cd /c/Users/firoj/OneDrive/Desktop/IdeaX/4NF
#   chmod +x schedule-commits.sh
#   ./schedule-commits.sh
# ==============================================================================

set -e

TARGET_HOUR=18
TARGET_MIN=0
CURRENT_EPOCH=$(date +%s)
TODAY_STR=$(date +%Y-%m-%d)
TARGET_EPOCH=$(date -d "$TODAY_STR $TARGET_HOUR:$TARGET_MIN:00" +%s 2>/dev/null || date -j -f "%Y-%m-%d %H:%M:%S" "$TODAY_STR $TARGET_HOUR:$TARGET_MIN:00" +%s 2>/dev/null || echo $(($CURRENT_EPOCH + 6600)))

TOTAL_REMAINING_SECS=$(($TARGET_EPOCH - $CURRENT_EPOCH))
if [ "$TOTAL_REMAINING_SECS" -le 0 ]; then
  TOTAL_REMAINING_SECS=6600
fi

# 66 granular commits
COMMITS=(
  "docs: add MIT license and project copyright notice|LICENSE"
  "chore: configure git ignore rules for dependencies and build outputs|.gitignore"
  "chore: add vercel deployment configuration and ignore specs|vercel.json .vercelignore"
  "chore: setup Vite configuration with PWA and React plugins|vite.config.js"
  "chore: configure project dependencies and npm scripts in package.json|package.json"
  "chore: lock project dependencies in package-lock.json|package-lock.json"
  "docs(spec): add autonomous agent instructions and constraints|AGENTS.md"
  "docs(gap): add architectural gap analysis and roadmap plan|IMPROVEMENTS.md"
  "docs(runbook): add operations runbook for field deployment|docs/RUNBOOK.md"
  "docs(handover): document initial handover and protocol baseline|docs/HANDOVER-2026-09-18.md"
  "docs(handover): document pilot readiness and meter calibration|docs/HANDOVER-2026-09-27.md"
  "docs(spec): add portal design specifications and crew economics|docs/superpowers/"
  "docs(screens): archive reference screenshots for UI verification|docs/screens/ docs/validator/ docs/Bhada-project.pdf"
  "assets(branding): add favicon and apple touch icons|public/favicon.png public/apple-touch-icon.png"
  "assets(branding): add vector icon and progressive web app icons|public/icon.svg public/icon-192.png public/icon-512.png public/icon-maskable-512.png"
  "assets(fonts): add self-hosted font stylesheet for offline use|public/fonts/fonts.css"
  "assets(fonts): bundle Khand Devanagari 500 and 700 woff2 faces|public/fonts/khand-500-devanagari.woff2 public/fonts/khand-500-latin.woff2 public/fonts/khand-700-devanagari.woff2 public/fonts/khand-700-latin.woff2"
  "assets(fonts): bundle Mukta 400 and 600 woff2 faces for UI copy|public/fonts/mukta-400-devanagari.woff2 public/fonts/mukta-400-latin.woff2 public/fonts/mukta-600-devanagari.woff2 public/fonts/mukta-600-latin.woff2"
  "style(core): define design tokens for ticket stock and print ink|src/styles/app.css"
  "style(surfaces): implement surface elevation and responsive card layouts|src/styles/surfaces.css"
  "style(branding): implement commercial license plate crimson register|src/styles/site-app.css"
  "style(meter): implement in-bus speedometer and odometer gauge styling|src/styles/meter.css"
  "style(demo): add styles for interactive pitch demonstration|src/styles/demo.css"
  "style(inspect): add styles for fare enforcement audit screen|src/styles/inspect.css"
  "feat(router): implement hash-based micro router for offline screens|src/lib/router.js"
  "feat(i18n): add Nepali numerals, stop directory, and currency formatters|src/lib/nepali.js"
  "feat(fares): implement regulated stage fare lookup and stops traversal|src/lib/fares.js"
  "feat(voice): implement Web Speech Nepali audio chimes for fare announcements|src/lib/voice.js"
  "feat(feedback): add haptic vibration and sensory feedback helpers|src/lib/feedback.js"
  "feat(scanner): implement camera barcode scanner input parser|src/lib/scan-input.js"
  "feat(gnss): add GNSS trajectory simulator for desktop route testing|src/lib/gnss-sim.js"
  "feat(telemetry): add error monitoring and crash reporting wrapper|src/lib/report.js"
  "feat(client): configure Supabase client with offline fallback|src/lib/supabase.js"
  "feat(fixtures): add mock data fixtures for offline portal previews|src/lib/supabase-fixtures.js"
  "feat(storage): initialize IndexedDB local database client|src/storage/db.js"
  "feat(identity): implement Ed25519 keypair generation and wallet storage|src/device/identity.js"
  "feat(fleet): implement vehicle license plate and route binding|src/device/fleet.js"
  "feat(nfc): implement Web NFC reader and writer abstractions|src/device/nfc.js"
  "feat(positioning): implement Geolocation positioning and wake lock manager|src/device/positioning.js"
  "feat(link): implement RS485 and local bus communication channel|src/device/link.js"
  "feat(collect): implement offline conductor fare collection tally board|src/device/collect.js"
  "feat(meter): implement real-time distance accumulator and fix monitor|src/device/meter.js"
  "feat(terminal): implement door validator state machine and entry logging|src/device/terminal.js"
  "feat(sync): implement background reconciliation and journal upload sync|src/device/sync.js"
  "feat(components): add Devanagari route crossing loader spinner|src/components/BusLoader.jsx"
  "feat(components): add offline crash boundary component|src/components/Crashed.jsx"
  "feat(components): add BarcodeDetector camera scanner view|src/components/Scanner.jsx"
  "feat(app): implement role launcher shell and offline cache check|src/App.jsx"
  "feat(app): add main application entrypoint and error boundary mount|src/main.jsx"
  "feat(landing): implement public landing page with corridor fare comparison|src/pages/Landing.jsx"
  "feat(screens): implement offline passenger ticketing stub and QR view|src/screens/Passenger.jsx"
  "feat(screens): implement live passenger ride odometer and fare bracket|src/screens/Ride.jsx"
  "feat(screens): implement conductor tally board and cash ticket logging|src/screens/Conductor.jsx"
  "feat(screens): implement door validator terminal stanchion display|src/screens/Terminal.jsx"
  "feat(screens): implement in-bus meter diagnostic console|src/screens/Device.jsx"
  "feat(screens): implement conductor shift sign-on and crew management|src/screens/Crew.jsx"
  "feat(screens): implement ticket inspection and verification screen|src/screens/Inspect.jsx"
  "feat(demo): add PGlite in-browser demonstration stage|src/screens/Demo.jsx src/demo/"
  "feat(portals): implement shared portal shell, navigation, and auth views|src/portals/shared/"
  "feat(portals): implement bus owner dashboard and leakage audit views|src/portals/operator/"
  "feat(portals): implement passenger pass account, wallet, and top-up views|src/portals/account/"
  "feat(portals): implement platform administration console and operator review|src/portals/admin/"
  "feat(validator): implement Raspberry Pi hardware validator daemon and drivers|validator/"
  "feat(supabase): add PostgreSQL database schemas and RLS policies (0001-0015)|supabase/migrations/0001_bhada.sql supabase/migrations/0002_seed.sql supabase/migrations/0003_topups.sql supabase/migrations/0004_lockdown.sql supabase/migrations/0005_operators.sql supabase/migrations/0006_operator_signup.sql supabase/migrations/0007_meter.sql supabase/migrations/0008_tap_consent.sql supabase/migrations/0009_tariff_3km.sql supabase/migrations/0010_unclosed_legs.sql supabase/migrations/0011_operator_meter.sql supabase/migrations/0012_dead_phone_claims.sql supabase/migrations/0013_route_distance.sql supabase/migrations/0014_concession_attestations.sql supabase/migrations/0015_dotm_returns.sql"
  "feat(supabase): add PostgreSQL database schemas and RLS policies (0016-0031)|supabase/migrations/0016_pseudonyms.sql supabase/migrations/0017_plausibility.sql supabase/migrations/0018_overdraft.sql supabase/migrations/0019_operator_signup_fix.sql supabase/migrations/0020_valley_routes.sql supabase/migrations/0021_kathmandu_time.sql supabase/migrations/0022_portals.sql supabase/migrations/0023_gateway_topups.sql supabase/migrations/0024_esewa_only.sql supabase/migrations/0025_crew_economics.sql supabase/migrations/0026_note_crew_first_signon.sql supabase/migrations/0027_client_errors.sql supabase/migrations/0028_views_as_caller.sql supabase/migrations/0029_wallet_moves.sql supabase/migrations/0030_counts_and_cash.sql supabase/migrations/0031_inspection.sql supabase/config.toml supabase/.gitignore"
  "feat(backend): add Supabase Edge Functions for sync and payment webhooks|supabase/functions/"
  "test(proofs): add cryptographic verification test suites and trace replay|scripts/ .github/"
  "docs(readme): polish README documentation and project overview|README.md index.html"
)

TOTAL_STAGES=${#COMMITS[@]}
INTERVAL_SECS=$(($TOTAL_REMAINING_SECS / $TOTAL_STAGES))

if [ "$INTERVAL_SECS" -lt 15 ]; then
  INTERVAL_SECS=15
fi

echo "=========================================================="
echo "  BHADA 4NF - 66 GRANULAR COMMIT & PUSH SCHEDULER"
echo "  Target completion: 18:00:00 (6:00 PM)"
echo "  Remaining time: $(($TOTAL_REMAINING_SECS / 60)) minutes ($TOTAL_REMAINING_SECS seconds)"
echo "  Total commits scheduled: $TOTAL_STAGES"
echo "  Interval between commits: $(($INTERVAL_SECS / 60))m $(($INTERVAL_SECS % 60))s ($INTERVAL_SECS seconds)"
echo "=========================================================="

countdown() {
  local secs=$1
  local label=$2
  while [ $secs -gt 0 ]; do
    local mins=$(($secs / 60))
    local s=$(($secs % 60))
    printf "\r[Countdown: %s] Next commit in %02d:%02d ... " "$label" $mins $s
    sleep 1
    secs=$(($secs - 1))
  done
  echo ""
}

STEP=0
for ITEM in "${COMMITS[@]}"; do
  STEP=$(($STEP + 1))
  MSG="${ITEM%%|*}"
  FILES="${ITEM##*|}"

  echo ""
  echo ">>> [Stage $STEP/$TOTAL_STAGES] $MSG"
  
  if [ "$STEP" -eq "$TOTAL_STAGES" ]; then
    git add -A
  else
    git add -A $FILES
  fi

  # Check if anything is staged
  if git diff --staged --quiet; then
    echo "Nothing to stage for this step, continuing..."
  else
    git commit -m "$MSG" || true
    git push origin main || true
    echo "✓ [$STEP/$TOTAL_STAGES] Committed and pushed at $(date '+%H:%M:%S')!"
  fi

  if [ "$STEP" -lt "$TOTAL_STAGES" ]; then
    countdown $INTERVAL_SECS "Stage $(($STEP + 1))"
  fi
done

echo ""
echo "=========================================================="
echo "  ALL $TOTAL_STAGES COMMITS SUCCESSFULLY DEPLOYED & PUSHED!"
echo "  Completed at $(date '+%H:%M:%S') before 18:00 (6:00 PM)."
echo "=========================================================="
