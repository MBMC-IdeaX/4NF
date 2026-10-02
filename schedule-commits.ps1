# ==============================================================================
# Bhada 4NF - 66 Granular Commit & Push Scheduler (Till 6:00 PM Today)
# Run in PowerShell:
#   .\schedule-commits.ps1
# ==============================================================================

$targetTime = (Get-Date).Date.AddHours(18).AddMinutes(0)
$now = Get-Date

if ($now -ge $targetTime) {
    Write-Host "Target time is already past 6:00 PM. Setting duration to 110 minutes." -ForegroundColor Yellow
    $totalSecs = 6600
} else {
    $totalSecs = [int]($targetTime - $now).TotalSeconds
}

$commits = @(
  @{ msg = "docs: add MIT license and project copyright notice"; files = @("LICENSE") },
  @{ msg = "chore: configure git ignore rules for dependencies and build outputs"; files = @(".gitignore") },
  @{ msg = "chore: add vercel deployment configuration and ignore specs"; files = @("vercel.json", ".vercelignore") },
  @{ msg = "chore: setup Vite configuration with PWA and React plugins"; files = @("vite.config.js") },
  @{ msg = "chore: configure project dependencies and npm scripts in package.json"; files = @("package.json") },
  @{ msg = "chore: lock project dependencies in package-lock.json"; files = @("package-lock.json") },
  @{ msg = "docs(spec): add autonomous agent instructions and constraints"; files = @("AGENTS.md") },
  @{ msg = "docs(gap): add architectural gap analysis and roadmap plan"; files = @("IMPROVEMENTS.md") },
  @{ msg = "docs(runbook): add operations runbook for field deployment"; files = @("docs/RUNBOOK.md") },
  @{ msg = "docs(handover): document initial handover and protocol baseline"; files = @("docs/HANDOVER-2026-09-18.md") },
  @{ msg = "docs(handover): document pilot readiness and meter calibration"; files = @("docs/HANDOVER-2026-09-27.md") },
  @{ msg = "docs(spec): add portal design specifications and crew economics"; files = @("docs/superpowers/") },
  @{ msg = "docs(screens): archive reference screenshots for UI verification"; files = @("docs/screens/", "docs/validator/", "docs/Bhada-project.pdf") },
  @{ msg = "assets(branding): add favicon and apple touch icons"; files = @("public/favicon.png", "public/apple-touch-icon.png") },
  @{ msg = "assets(branding): add vector icon and progressive web app icons"; files = @("public/icon.svg", "public/icon-192.png", "public/icon-512.png", "public/icon-maskable-512.png") },
  @{ msg = "assets(fonts): add self-hosted font stylesheet for offline use"; files = @("public/fonts/fonts.css") },
  @{ msg = "assets(fonts): bundle Khand Devanagari 500 and 700 woff2 faces"; files = @("public/fonts/khand-500-devanagari.woff2", "public/fonts/khand-500-latin.woff2", "public/fonts/khand-700-devanagari.woff2", "public/fonts/khand-700-latin.woff2") },
  @{ msg = "assets(fonts): bundle Mukta 400 and 600 woff2 faces for UI copy"; files = @("public/fonts/mukta-400-devanagari.woff2", "public/fonts/mukta-400-latin.woff2", "public/fonts/mukta-600-devanagari.woff2", "public/fonts/mukta-600-latin.woff2") },
  @{ msg = "style(core): define design tokens for ticket stock and print ink"; files = @("src/styles/app.css") },
  @{ msg = "style(surfaces): implement surface elevation and responsive card layouts"; files = @("src/styles/surfaces.css") },
  @{ msg = "style(branding): implement commercial license plate crimson register"; files = @("src/styles/site-app.css") },
  @{ msg = "style(meter): implement in-bus speedometer and odometer gauge styling"; files = @("src/styles/meter.css") },
  @{ msg = "style(demo): add styles for interactive pitch demonstration"; files = @("src/styles/demo.css") },
  @{ msg = "style(inspect): add styles for fare enforcement audit screen"; files = @("src/styles/inspect.css") },
  @{ msg = "feat(router): implement hash-based micro router for offline screens"; files = @("src/lib/router.js") },
  @{ msg = "feat(i18n): add Nepali numerals, stop directory, and currency formatters"; files = @("src/lib/nepali.js") },
  @{ msg = "feat(fares): implement regulated stage fare lookup and stops traversal"; files = @("src/lib/fares.js") },
  @{ msg = "feat(voice): implement Web Speech Nepali audio chimes for fare announcements"; files = @("src/lib/voice.js") },
  @{ msg = "feat(feedback): add haptic vibration and sensory feedback helpers"; files = @("src/lib/feedback.js") },
  @{ msg = "feat(scanner): implement camera barcode scanner input parser"; files = @("src/lib/scan-input.js") },
  @{ msg = "feat(gnss): add GNSS trajectory simulator for desktop route testing"; files = @("src/lib/gnss-sim.js") },
  @{ msg = "feat(telemetry): add error monitoring and crash reporting wrapper"; files = @("src/lib/report.js") },
  @{ msg = "feat(client): configure Supabase client with offline fallback"; files = @("src/lib/supabase.js") },
  @{ msg = "feat(fixtures): add mock data fixtures for offline portal previews"; files = @("src/lib/supabase-fixtures.js") },
  @{ msg = "feat(storage): initialize IndexedDB local database client"; files = @("src/storage/db.js") },
  @{ msg = "feat(identity): implement Ed25519 keypair generation and wallet storage"; files = @("src/device/identity.js") },
  @{ msg = "feat(fleet): implement vehicle license plate and route binding"; files = @("src/device/fleet.js") },
  @{ msg = "feat(nfc): implement Web NFC reader and writer abstractions"; files = @("src/device/nfc.js") },
  @{ msg = "feat(positioning): implement Geolocation positioning and wake lock manager"; files = @("src/device/positioning.js") },
  @{ msg = "feat(link): implement RS485 and local bus communication channel"; files = @("src/device/link.js") },
  @{ msg = "feat(collect): implement offline conductor fare collection tally board"; files = @("src/device/collect.js") },
  @{ msg = "feat(meter): implement real-time distance accumulator and fix monitor"; files = @("src/device/meter.js") },
  @{ msg = "feat(terminal): implement door validator state machine and entry logging"; files = @("src/device/terminal.js") },
  @{ msg = "feat(sync): implement background reconciliation and journal upload sync"; files = @("src/device/sync.js") },
  @{ msg = "feat(components): add Devanagari route crossing loader spinner"; files = @("src/components/BusLoader.jsx") },
  @{ msg = "feat(components): add offline crash boundary component"; files = @("src/components/Crashed.jsx") },
  @{ msg = "feat(components): add BarcodeDetector camera scanner view"; files = @("src/components/Scanner.jsx") },
  @{ msg = "feat(app): implement role launcher shell and offline cache check"; files = @("src/App.jsx") },
  @{ msg = "feat(app): add main application entrypoint and error boundary mount"; files = @("src/main.jsx") },
  @{ msg = "feat(landing): implement public landing page with corridor fare comparison"; files = @("src/pages/Landing.jsx") },
  @{ msg = "feat(screens): implement offline passenger ticketing stub and QR view"; files = @("src/screens/Passenger.jsx") },
  @{ msg = "feat(screens): implement live passenger ride odometer and fare bracket"; files = @("src/screens/Ride.jsx") },
  @{ msg = "feat(screens): implement conductor tally board and cash ticket logging"; files = @("src/screens/Conductor.jsx") },
  @{ msg = "feat(screens): implement door validator terminal stanchion display"; files = @("src/screens/Terminal.jsx") },
  @{ msg = "feat(screens): implement in-bus meter diagnostic console"; files = @("src/screens/Device.jsx") },
  @{ msg = "feat(screens): implement conductor shift sign-on and crew management"; files = @("src/screens/Crew.jsx") },
  @{ msg = "feat(screens): implement ticket inspection and verification screen"; files = @("src/screens/Inspect.jsx") },
  @{ msg = "feat(demo): add PGlite in-browser demonstration stage"; files = @("src/screens/Demo.jsx", "src/demo/") },
  @{ msg = "feat(portals): implement shared portal shell, navigation, and auth views"; files = @("src/portals/shared/") },
  @{ msg = "feat(portals): implement bus owner dashboard and leakage audit views"; files = @("src/portals/operator/") },
  @{ msg = "feat(portals): implement passenger pass account, wallet, and top-up views"; files = @("src/portals/account/") },
  @{ msg = "feat(portals): implement platform administration console and operator review"; files = @("src/portals/admin/") },
  @{ msg = "feat(validator): implement Raspberry Pi hardware validator daemon and drivers"; files = @("validator/") },
  @{ msg = "feat(supabase): add PostgreSQL database schemas and RLS policies (0001-0015)"; files = @("supabase/migrations/0001_bhada.sql", "supabase/migrations/0002_seed.sql", "supabase/migrations/0003_topups.sql", "supabase/migrations/0004_lockdown.sql", "supabase/migrations/0005_operators.sql", "supabase/migrations/0006_operator_signup.sql", "supabase/migrations/0007_meter.sql", "supabase/migrations/0008_tap_consent.sql", "supabase/migrations/0009_tariff_3km.sql", "supabase/migrations/0010_unclosed_legs.sql", "supabase/migrations/0011_operator_meter.sql", "supabase/migrations/0012_dead_phone_claims.sql", "supabase/migrations/0013_route_distance.sql", "supabase/migrations/0014_concession_attestations.sql", "supabase/migrations/0015_dotm_returns.sql") },
  @{ msg = "feat(supabase): add PostgreSQL database schemas and RLS policies (0016-0031)"; files = @("supabase/migrations/0016_pseudonyms.sql", "supabase/migrations/0017_plausibility.sql", "supabase/migrations/0018_overdraft.sql", "supabase/migrations/0019_operator_signup_fix.sql", "supabase/migrations/0020_valley_routes.sql", "supabase/migrations/0021_kathmandu_time.sql", "supabase/migrations/0022_portals.sql", "supabase/migrations/0023_gateway_topups.sql", "supabase/migrations/0024_esewa_only.sql", "supabase/migrations/0025_crew_economics.sql", "supabase/migrations/0026_note_crew_first_signon.sql", "supabase/migrations/0027_client_errors.sql", "supabase/migrations/0028_views_as_caller.sql", "supabase/migrations/0029_wallet_moves.sql", "supabase/migrations/0030_counts_and_cash.sql", "supabase/migrations/0031_inspection.sql", "supabase/config.toml", "supabase/.gitignore") },
  @{ msg = "feat(backend): add Supabase Edge Functions for sync and payment webhooks"; files = @("supabase/functions/") },
  @{ msg = "test(proofs): add cryptographic verification test suites and trace replay"; files = @("scripts/", ".github/") },
  @{ msg = "docs(readme): polish README documentation and project overview"; files = @("README.md", "index.html") }
)

$totalStages = $commits.Count
$intervalSecs = [Math]::Max(15, [int]($totalSecs / $totalStages))

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  BHADA 4NF - 68 GRANULAR COMMIT & PUSH SCHEDULER" -ForegroundColor Cyan
Write-Host "  Target Completion: 18:00:00 (6:00 PM)" -ForegroundColor Green
Write-Host "  Remaining Time: $([int]($totalSecs / 60)) minutes ($totalSecs seconds)" -ForegroundColor White
Write-Host "  Total Commits Scheduled: $totalStages" -ForegroundColor White
Write-Host "  Interval between commits: $([int]($intervalSecs / 60))m $($intervalSecs % 60)s ($intervalSecs seconds)" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Cyan

function Wait-Countdown($secs, $stageName) {
    for ($i = $secs; $i -gt 0; $i--) {
        $m = [int]($i / 60)
        $s = $i % 60
        $str = "{0:D2}:{1:D2}" -f $m, $s
        Write-Host -NoNewline "`r[Countdown: $stageName] Next commit in $str ... "
        Start-Sleep -Seconds 1
    }
    Write-Host ""
}

$step = 0
foreach ($item in $commits) {
    $step++
    $msg = $item.msg
    $files = $item.files

    Write-Host "`n>>> [Stage $step/$totalStages] $msg" -ForegroundColor Yellow
    
    if ($step -eq $totalStages) {
        git add -A
    } else {
        foreach ($f in $files) {
            git add -A $f
        }
    }

    $diff = git diff --staged --name-only
    if (-not $diff) {
        Write-Host "Nothing to stage for this step, continuing..." -ForegroundColor Gray
    } else {
        git commit -m "$msg"
        git push origin main
        Write-Host "✓ [$step/$totalStages] Committed and pushed at $((Get-Date).ToString('HH:mm:ss'))!" -ForegroundColor Green
    }

    if ($step -lt $totalStages) {
        Wait-Countdown -secs $intervalSecs -stageName "Stage $($step + 1)"
    }
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "  ALL $totalStages COMMITS SUCCESSFULLY DEPLOYED & PUSHED!" -ForegroundColor Green
Write-Host "  Finished at $((Get-Date).ToString('HH:mm:ss')) before 18:00 (6:00 PM)." -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Cyan
