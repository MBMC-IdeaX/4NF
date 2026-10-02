# ==============================================================================
# Finish Remaining 9 Commits for Bhada 4NF
# ==============================================================================

$remaining = @(
  @{ msg = "feat(portals): implement bus owner dashboard and leakage audit views"; files = @("src/portals/operator/") },
  @{ msg = "feat(portals): implement passenger pass account, wallet, and top-up views"; files = @("src/portals/account/") },
  @{ msg = "feat(portals): implement platform administration console and operator review"; files = @("src/portals/admin/") },
  @{ msg = "feat(validator): implement Raspberry Pi hardware validator daemon and drivers"; files = @("validator/") },
  @{ msg = "feat(supabase): add PostgreSQL database schemas and RLS policies (0001-0015)"; files = @("supabase/migrations/0001_bhada.sql", "supabase/migrations/0002_seed.sql", "supabase/migrations/0003_topups.sql", "supabase/migrations/0004_lockdown.sql", "supabase/migrations/0005_operators.sql", "supabase/migrations/0006_operator_signup.sql", "supabase/migrations/0007_meter.sql", "supabase/migrations/0008_tap_consent.sql", "supabase/migrations/0009_tariff_3km.sql", "supabase/migrations/0010_unclosed_legs.sql", "supabase/migrations/0011_operator_meter.sql", "supabase/migrations/0012_dead_phone_claims.sql", "supabase/migrations/0013_route_distance.sql", "supabase/migrations/0014_concession_attestations.sql", "supabase/migrations/0015_dotm_returns.sql") },
  @{ msg = "feat(supabase): add PostgreSQL database schemas and RLS policies (0016-0031)"; files = @("supabase/migrations/0016_pseudonyms.sql", "supabase/migrations/0017_plausibility.sql", "supabase/migrations/0018_overdraft.sql", "supabase/migrations/0019_operator_signup_fix.sql", "supabase/migrations/0020_valley_routes.sql", "supabase/migrations/0021_kathmandu_time.sql", "supabase/migrations/0022_portals.sql", "supabase/migrations/0023_gateway_topups.sql", "supabase/migrations/0024_esewa_only.sql", "supabase/migrations/0025_crew_economics.sql", "supabase/migrations/0026_note_crew_first_signon.sql", "supabase/migrations/0027_client_errors.sql", "supabase/migrations/0028_views_as_caller.sql", "supabase/migrations/0029_wallet_moves.sql", "supabase/migrations/0030_counts_and_cash.sql", "supabase/migrations/0031_inspection.sql", "supabase/config.toml", "supabase/.gitignore") },
  @{ msg = "feat(backend): add Supabase Edge Functions for sync and payment webhooks"; files = @("supabase/functions/") },
  @{ msg = "test(proofs): add cryptographic verification test suites and trace replay"; files = @("scripts/", ".github/") },
  @{ msg = "docs(readme): polish README documentation and final project structure"; files = @("-A") }
)

$i = 0
foreach ($c in $remaining) {
    $i++
    Write-Host ">>> Committing [$i/$($remaining.Count)]: $($c.msg)" -ForegroundColor Yellow
    foreach ($f in $c.files) {
        if ($f -eq "-A") { git add -A } else { git add -A $f }
    }
    git commit -m $c.msg
    git push origin main
    Write-Host "✓ Pushed [$i/$($remaining.Count)]" -ForegroundColor Green
    Start-Sleep -Seconds 5
}

Write-Host "`nAll commits are now 100% complete!" -ForegroundColor Cyan
