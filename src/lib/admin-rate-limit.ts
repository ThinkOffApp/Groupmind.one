// DB-backed, ATOMIC rate limiting for the /admin login action.
//
// WHY THE DATABASE: this app runs on serverless instances, so per-instance
// in-memory counters cannot stop parallel or fanned-out brute-force attempts
// (each instance would count from zero). The database is the shared state
// across every instance, so the attempt log lives in the
// admin_login_failures table (see
// supabase/migrations/20260713_admin_login_failures.sql).
//
// WHY ONE RPC INSTEAD OF SELECT-THEN-INSERT: counting recent failures and
// inserting the new row later is a TOCTOU race - a synchronized parallel
// burst of guesses can all pass the count before any row is inserted,
// bypassing the thresholds entirely (codex, PR #61 re-review). Admission is
// therefore a single atomic Postgres function,
// admin_reserve_login_attempt (see
// supabase/migrations/20260713_atomic_admin_login_reserve.sql): under an
// advisory transaction lock it INSERTS the attempt row FIRST, then counts
// the trailing WINDOW_MS INCLUDING that row. Concurrent callers serialize
// on the lock, so at most MAX_FAILURES_PER_IP guesses per IP (and
// MAX_FAILURES_GLOBAL overall - the global cap blunts distributed attacks
// that rotate IPs) ever reach the password compare in any window.
//
// NO SELF-LOCKOUT: the reservation records ATTEMPTS, so a successful login
// deletes its own provisional row (clearAdminLoginAttempt) - legitimate
// logins never accumulate toward the failure thresholds. Refused and
// wrong-password attempts keep their rows: hammering while locked out only
// extends the lockout, a success cannot be used to reset the counter
// mid-attack, and every lockout ends by itself as rows age out of the
// 10-minute window.

import 'server-only';
import { getServiceSupabase } from './supabase-service';

// Tunable so an operator locked out of their own dashboard can recover without
// a code change. Shrinking the WINDOW is the safe lever: old failure rows fall
// outside it immediately, which resets a lockout WITHOUT raising how many
// guesses an attacker gets. Raising the caps is the unsafe lever; it is
// clamped below.
//
// Every value is validated: a missing, malformed, zero or negative env var
// falls back to the default, and the caps are clamped so a typo cannot disable
// the limiter. A rate limiter that silently turns itself off is worse than one
// that is occasionally inconvenient.
function envInt(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
        console.error(
            `[Admin] ${name}=${JSON.stringify(raw)} is not an integer in [${min}, ${max}]; using ${fallback}.`
        );
        return fallback;
    }
    return n;
}

const WINDOW_MS = envInt('ADMIN_RATE_WINDOW_MS', 10 * 60 * 1000, 1_000, 60 * 60 * 1000);
const MAX_FAILURES_PER_IP = envInt('ADMIN_RATE_MAX_PER_IP', 5, 1, 50);
const MAX_FAILURES_GLOBAL = envInt('ADMIN_RATE_MAX_GLOBAL', 20, 1, 500);

export interface AdminLoginReservation {
    /** False = refuse this attempt WITHOUT even checking the password. */
    allowed: boolean;
    /**
     * Row id of the recorded attempt, to delete via clearAdminLoginAttempt
     * if the login succeeds. Null when refused or when the reservation
     * itself failed (nothing to clear).
     */
    attemptId: string | null;
}

/**
 * Atomically record this login attempt and decide whether it may proceed to
 * the password compare. Fails CLOSED: if the shared state is unreachable
 * (e.g. the migrations have not been applied), logins are refused rather
 * than silently dropping brute-force protection.
 */
export async function reserveAdminLoginAttempt(ip: string): Promise<AdminLoginReservation> {
    try {
        const { data, error } = await getServiceSupabase().rpc('admin_reserve_login_attempt', {
            p_ip: ip,
            p_window_ms: WINDOW_MS,
            p_max_per_ip: MAX_FAILURES_PER_IP,
            p_max_global: MAX_FAILURES_GLOBAL,
        });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        if (!row || typeof row.allowed !== 'boolean') {
            throw new Error(
                `Unexpected admin_reserve_login_attempt result: ${JSON.stringify(data)}`
            );
        }
        return { allowed: row.allowed, attemptId: row.attempt_id ?? null };
    } catch (err) {
        console.error(
            '[Admin] Rate-limit reservation failed; refusing login (failing closed). ' +
                'Are supabase/migrations/20260713_admin_login_failures.sql and ' +
                '20260713_atomic_admin_login_reserve.sql applied?',
            err
        );
        return { allowed: false, attemptId: null };
    }
}

/**
 * Delete the provisional attempt row after a SUCCESSFUL login so legitimate
 * logins never count toward the failure thresholds.
 */
export async function clearAdminLoginAttempt(attemptId: string): Promise<void> {
    try {
        const { error } = await getServiceSupabase()
            .from('admin_login_failures')
            .delete()
            .eq('id', attemptId);
        if (error) throw error;
    } catch (err) {
        // Log-only: the login already succeeded; a stray provisional row
        // simply ages out of the 10-minute window.
        console.error('[Admin] Could not clear provisional login-attempt row:', err);
    }
}
