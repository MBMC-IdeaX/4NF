# Runbook

What to do when something is wrong in production. `README.md` §13 has the
normal release; this file is for when a release, a function or the database
is the problem.

Live pieces: Supabase project `kbvswdaznnxladwqijri` (Postgres, Auth, the `sync`
and `payments` Edge Functions) and the Vercel project `bhada`, served at
`bhada-one.vercel.app`. A push to `master` deploys the site.

## First, what is actually broken

1. **Admin console → Errors.** Crashes from phones, door terminals, meters and
   the portals, newest first, with the build they came from
   (`report_client_error()`, migration 0027). A spike on one surface and one
   build is almost always the last deploy.
2. **Supabase dashboard → Edge Functions → sync / payments → Logs.** A `429`
   is the per-address limit in `supabase/functions/_shared/guard.ts`, which is
   per instance and rarely trips (see its header). A body over 1 MB is refused
   unread, but Supabase's gateway reports it to the client as a `503` or a
   timeout rather than the function's `413`. Anything `5xx` is the function or the database.
3. **Is the device on the old build?** The service worker serves the previous
   `index.html` until it updates. Before judging a deploy, unregister it and
   clear site data, or you will be looking at the build you just replaced.

## Nothing that went wrong on a phone loses money

Worth knowing before acting in a hurry. Every device keeps its rides, taps and
receipts in IndexedDB and uploads them until the backend says they settled. A
failed sync, a `429`, a function that is down or an old function that does
not understand a new upload all leave the rows queued on the device. The fix
is to repair the backend; the devices catch up on their own. Do not ask
passengers or crews to reinstall or clear anything — that is the one action
that can lose a signed receipt.

## Roll the site back

A bad site deploy is the cheapest thing to undo:

```bash
vercel ls bhada                 # find the last good deployment
vercel rollback <deployment-url>
```

or Vercel dashboard → Deployments → the last good one → *Promote to
Production*. The Vercel build runs `proof:all` first, so a deploy with a red
proof never replaced the live site in the first place.

## Roll a function back

Functions are deployed from the working tree, so rolling back means deploying
an older commit:

```bash
git checkout <good-commit> -- supabase/functions protocol
npm run sync:protocol
supabase functions deploy sync --no-verify-jwt
supabase functions deploy payments
git checkout master -- supabase/functions protocol
```

The function must never be older than the site's upload format (release order
is database → function → site). If the site is newer, roll the site back first.

## Roll a migration back

There is no down migration. Migrations here add columns, views and functions
and are written to be applied once. A bad one is fixed by a **new** migration
that undoes it, proved with `npm run proof:legs` on PGlite before it touches the
live database. Never edit a migration that has been pushed; `supabase db push`
records it as applied and will not run it again.

Tariffs are never edited either (AGENTS.md): add one, never change one, or old
receipts re-price wrongly.

## Backups

Check what the plan provides in the Supabase dashboard → Database → Backups.
Point-in-time recovery is a paid add-on; without it, the most recent restore
point may be a day old, and every ride settled since would have to be re-synced
from devices (they keep receipts, so it is possible but slow).

Before a risky migration, take your own copy:

```bash
supabase db dump --linked -f backup-schema.sql
supabase db dump --linked --data-only -f backup-data.sql
```

`db dump` runs `pg_dump` in Docker, so Docker must be running. Keep dumps out
of the repository: they hold wallet balances and public keys.

## Money went somewhere it should not

1. Do not correct balances with SQL. Use **Admin → Passengers → Adjust**
   (`admin_adjust_wallet()`), which writes a row with a reason. Every rupee
   stays explainable.
2. To stop a wallet or an operator while investigating: **Admin → Suspend**.
   A suspended passenger cannot top up; their rides still settle, because the
   bus already carried them.
3. `wallet_audit` and `admin_statement()` show every movement on a wallet.

## Keys and secrets

| What | Where | Rotate by |
| --- | --- | --- |
| Service role key | Supabase secrets, used only by functions | Dashboard → API → roll, then redeploy both functions |
| Anon key | Vercel env `VITE_SUPABASE_ANON_KEY`, ships in the site | Roll in Supabase, update Vercel env, redeploy the site |
| eSewa live pair | `ESEWA_PRODUCT_CODE`, `ESEWA_SECRET_KEY` secrets | `supabase secrets set …`, redeploy `payments` |
| Admin logins | `platform_admins` + Supabase Auth | Change the password; remove the row to revoke |

The anon key is public by design. What it can read is held by row-level
security, and `proof:legs` section 23 fails on anything it could read that
skips RLS.

## Before real money

- Unset `SIGNUP_CREDIT_NPR` on the `sync` function
  (`supabase secrets unset SIGNUP_CREDIT_NPR`, then redeploy `sync`). While
  set, every new wallet starts with free money.
- Set `ESEWA_ENV=live` with the live merchant pair.
- Supabase Auth → URL Configuration → Site URL `https://bhada-one.vercel.app`.
