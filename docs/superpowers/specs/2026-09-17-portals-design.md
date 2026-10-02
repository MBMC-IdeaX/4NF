# Portals: super admin, passenger accounts, top-up requests

Approved 17 Sep 2026.

## Goal

Give Bhada the three office surfaces a real fare system has: an owner
dashboard (exists), a super admin console that controls users and loads
money, and a passenger account with a banking-style statement and top-up
requests. The bus stays scan-or-tap only.

## Structure

One app, role-based portals, each lazy-loaded so the offline bus screens
never download them.

```
src/portals/
  shared/     auth hooks, page shell, Stat, tables, Plate, passkey lock, portal.css
  operator/   the existing owner dashboard (moved from src/dashboard)
  admin/      /admin
  account/    /app/account (passenger)
```

`protocol/`, the bus screens and the proofs keep their places.

## Authority

- `platform_admins(user_id)` names super admins. `is_platform_admin()` is
  security definer. Every admin operation is a security-definer function that
  checks it first; the browser never holds the service key.
- The first admin is `alokbhandari100@gmail.com`, inserted once as data, not
  in a migration.
- `operators.suspended_at`: `current_operator_id()` and `my_operator()` treat
  a suspended operator as having no dashboard access.
- `passenger_accounts.suspended_at`: a suspended passenger cannot read the
  portal or request top-ups. Settlement is unaffected — rides already taken
  still settle, because refusing them would strand the fare, not the person.

## Passenger accounts

- Sign-in: email + password (Supabase). Phone + SMS code is wired in the UI and
  reports that SMS is not configured until a provider is set in Supabase.
- `passenger_accounts(user_id, wallet_public_key unique, linked_at,
  suspended_at)`.
- Linking: the phone signs `AL1|user id|wallet key|unix s|sig` with the wallet
  (root) key (`protocol/account.mjs`). The phone sends it in a sync batch as
  `accountLink`, with the user's access token. `settleBatch()` verifies the
  signature, freshness (300 s) and that the token's user is the one named; the
  ledger method `linkAccount` resolves the token and writes the row. A wallet
  links to one account and an account to one wallet; relinking the same pair
  is a no-op.

## Statement

`my_statement()` (security definer, caller's linked wallet) returns balance,
overdraft, and entries newest first, each with date, kind, description,
signed amount and running balance:

- credits: `wallet_topups` (demo, cash, esewa, khalti, fonepay, imepay,
  refund) and positive `wallet_adjustments`
- debits: `legs` billed to the wallet or any of its day-keys, `transactions`
  from the wallet or its day-keys, negative `wallet_adjustments`

The proof checks that the entries sum to the stored balance.

While online and linked, the phone replaces its local balance with the server
balance less its own unsettled stage fares. Offline limits are unchanged.

## Top-up requests

- `topup_requests(id, user_id, wallet_public_key, method, amount, reference,
  status pending|loaded|rejected, note, created_at, decided_at, decided_by)`,
  unique `(method, reference)`, amount 10–10000.
- `request_topup(method, amount, reference)`: linked, not suspended, at most
  five pending at once.
- `admin_load_topup(id)`: credits through `credit_wallet(wallet, amount,
  method, 'request:' || id)` and marks it loaded in one transaction; a second
  call is refused.
- `admin_reject_topup(id, reason)`: reason required.
- `platform_settings` holds the merchant IDs and QR image URLs shown to the
  passenger; the admin edits them. Unset values say so.

## Admin console

Overview (loaded, fares settled, overdraft float, pending requests, buses
reporting), top-up queue, passengers (search, statement, suspend, load cash,
correction), operators (search, buses, suspend), settings.

Corrections: `wallet_adjustments(id, wallet, amount ≠ 0, reason required,
created_by, created_at)` through `admin_adjust_wallet()`; the balance floor
still applies. Nothing is edited in place.

## Face ID

A passkey (WebAuthn, platform authenticator, user verification required)
locks the account portal on open and confirms a top-up request. Local check
only, like a banking app's biometric unlock; no biometric data leaves the
phone. Devices without one skip the lock.

## Testing

`proof:legs` sections: account link (forged, wrong user, stale, second
wallet, relink), statement sums to balance across day-keys, top-up lifecycle
(duplicate reference, load twice, reject, suspended), admin authority
(non-admin refused on every admin function), operator suspension,
corrections. Then UI check with mock data at desktop and phone width, then a
live walk-through.

## Needs from the owner

eSewa / Khalti / Fonepay merchant IDs and QR images; an SMS provider for
phone login.
