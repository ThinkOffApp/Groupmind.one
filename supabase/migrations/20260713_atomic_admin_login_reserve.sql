-- SPDX-License-Identifier: AGPL-3.0-only
-- Atomic admission for the /admin login rate limit.
--
-- WHY: the first cut of the limiter (20260713_admin_login_failures.sql +
-- src/lib/admin-rate-limit.ts) SELECT-counted recent failures and only
-- INSERTed a row later, after the password compare. That check-then-insert
-- is a TOCTOU race: a synchronized parallel burst of guesses can all pass
-- the count before any row lands, so 100 simultaneous attempts could all
-- reach password verification (codex, PR #61 re-review). This function
-- makes admission atomic: it INSERTS the attempt row FIRST, then counts the
-- trailing window INCLUDING that row, all under an advisory transaction
-- lock that serializes concurrent callers. With the lock held until commit,
-- every caller sees every prior caller's row, so at most p_max_per_ip
-- attempts per IP (p_max_global overall) are ever admitted per window - no
-- matter how many arrive at once. Admin logins are rare, so fully
-- serializing them costs nothing.
--
-- SEMANTICS: the table now holds ATTEMPTS, not just failures. To keep the
-- thresholds meaning "failures" (so a handful of legitimate successful
-- logins can never lock the admin out), the app DELETEs the returned
-- attempt_id row when the password turns out to be correct
-- (clearAdminLoginAttempt in src/lib/admin-rate-limit.ts). Refused and
-- wrong-password attempts keep their rows: hammering while locked out only
-- extends the lockout, and rows age out of the window on their own.
--
-- The one caller is the admin login server action via the service-role
-- client; nobody else may execute this (see REVOKE/GRANT below).

CREATE OR REPLACE FUNCTION public.admin_reserve_login_attempt(
    p_ip TEXT,
    p_window_ms BIGINT,
    p_max_per_ip INTEGER,
    p_max_global INTEGER
)
RETURNS TABLE (allowed BOOLEAN, attempt_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
    v_since TIMESTAMPTZ := now() - make_interval(secs => p_window_ms / 1000.0);
    v_id UUID;
    v_ip_count BIGINT;
    v_global_count BIGINT;
BEGIN
    -- Serialize all admin login admissions. The lock is released only when
    -- this transaction commits, so a concurrent caller cannot run its
    -- INSERT+COUNT until this row is committed and visible to it.
    PERFORM pg_advisory_xact_lock(hashtext('admin_reserve_login_attempt'));

    INSERT INTO public.admin_login_failures (ip)
    VALUES (p_ip)
    RETURNING id INTO v_id;

    SELECT count(*) INTO v_global_count
    FROM public.admin_login_failures
    WHERE attempted_at >= v_since;

    SELECT count(*) INTO v_ip_count
    FROM public.admin_login_failures
    WHERE attempted_at >= v_since AND ip = p_ip;

    -- Counts INCLUDE the row just inserted, so "<=" preserves the original
    -- thresholds: with p_max_per_ip = 5, admissions 1-5 from an IP proceed
    -- to the password compare and admission 6 is refused.
    RETURN QUERY SELECT
        (v_global_count <= p_max_global AND v_ip_count <= p_max_per_ip),
        v_id;
END;
$$;

-- Service-role only, matching the table's RLS posture (RLS enabled, no
-- policies): anon/authenticated can neither call this nor touch the table.
REVOKE ALL ON FUNCTION public.admin_reserve_login_attempt(TEXT, BIGINT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reserve_login_attempt(TEXT, BIGINT, INTEGER, INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reserve_login_attempt(TEXT, BIGINT, INTEGER, INTEGER) TO service_role;
