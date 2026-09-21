-- SPDX-License-Identifier: AGPL-3.0-only
-- Shared failed-login state for the /admin password gate.
--
-- The dashboard runs on serverless instances, so an in-memory counter is
-- useless as a rate limit (every instance/invocation has its own memory and
-- parallel attempts fan out across instances). The database is the one piece
-- of state all instances share, so brute-force protection lives here: the
-- login action (src/app/admin/actions.ts + src/lib/admin-rate-limit.ts)
-- inserts one row per FAILED login attempt and, before checking any
-- password, counts rows in the trailing 10 minutes. Too many recent
-- failures (per IP or globally) = the attempt is refused outright.
--
-- Rows are never deleted by the app; a lockout simply ends when the rows
-- age out of the 10-minute window. Prune old rows opportunistically if the
-- table ever grows (it only grows on failed admin logins, so it stays tiny).

CREATE TABLE IF NOT EXISTS public.admin_login_failures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip TEXT NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The limiter runs two counts per login attempt:
--   global: WHERE attempted_at >= now() - interval '10 minutes'
--   per-IP: ... AND ip = <caller>
CREATE INDEX IF NOT EXISTS admin_login_failures_attempted_at_idx
    ON public.admin_login_failures (attempted_at);
CREATE INDEX IF NOT EXISTS admin_login_failures_ip_attempted_at_idx
    ON public.admin_login_failures (ip, attempted_at);

-- Service-role access only: RLS enabled with NO policies means anon and
-- authenticated clients can neither read nor write these rows; the admin
-- login action uses the service-role client, which bypasses RLS.
ALTER TABLE public.admin_login_failures ENABLE ROW LEVEL SECURITY;
