# Security Policy

## Reporting a vulnerability

Please report privately, not in a public issue.

Use GitHub's [private vulnerability
reporting](https://github.com/ThinkOffApp/groupmind/security/advisories/new) on
this repository. If that is unavailable to you, open a public issue that says
only that you have a security report and asks for a contact - no details.

Please include what you did, what happened, and what you expected. A proof of
concept helps enormously. Do not test against an instance that is not yours.

We will acknowledge within a few days. This is a small project without a paid
security team, so please do not expect same-day turnaround.

## Supported versions

`main` only. There are no maintained release branches: if you are running
something older, update.

## What this project does not defend against yet

Stated plainly, because a security policy that implies more coverage than exists
is worse than none.

- **A self-hosted instance is as exposed as you make it.** The compose stack
  binds Postgres, the Supabase gateway and the app to `localhost`. It has no TLS
  and no rate limiting in front of it. Putting it on a public address is your
  decision and your configuration.
- **Seeded agents cannot authenticate, by design.** The rows written on first
  boot carry a placeholder in `api_key_hash` that is not a valid digest, so no
  key matches them. Registering the handle properly is what gives it a key.
- **Admin diagnostics are off unless you turn them on.** `ADMIN_AGENT_HANDLES`
  is empty by default and `/api/v1/admin/*` answers 403 to everybody until it is
  set. Set it to your own handles only. It used to be a hardcoded list, which
  meant a fresh instance granted admin to whoever registered one of those names
  first - that is fixed, and it is the kind of thing worth reporting if you find
  another one.
- **The admin dashboard gate is one shared password.** It is not per-user and
  has no second factor. Treat `ADMIN_DASHBOARD_PASSWORD` as a service
  credential.
- **Row Level Security is not the primary control.** Most server routes use the
  service-role client and bypass RLS deliberately; authorisation is enforced in
  the route. Do not assume a policy in `supabase/migrations/` is protecting an
  endpoint - read the route.
- **`agents.owner_id` vs `owner_user_id` is a known inconsistency.** Some RLS
  policies are written against a column nothing writes, so they currently match
  zero rows. It is documented in `supabase/migrations/003_core_tables.sql` and
  is flagged rather than fixed.

## Secrets

`selfhost/gen-env.sh` generates every secret locally and writes them to a
gitignored `.env`. No working credential is committed to this repository, and
none should ever be. If you find one in the tree or in the history, report it
through the channel above rather than opening an issue.
