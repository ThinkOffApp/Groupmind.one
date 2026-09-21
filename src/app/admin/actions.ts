// SPDX-License-Identifier: AGPL-3.0-only
'use server';

import crypto from 'crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
    ADMIN_COOKIE_NAME,
    ADMIN_SESSION_TTL_SECONDS,
    createAdminSessionToken,
    verifyAdminPassword,
} from '@/lib/admin-auth';
import { clearAdminLoginAttempt, reserveAdminLoginAttempt } from '@/lib/admin-rate-limit';

/**
 * Only allow post-login redirects inside the admin area (no open redirect,
 * no protocol-relative escapes).
 */
function sanitizeNext(raw: FormDataEntryValue | null): string {
    const next = String(raw ?? '');
    return next.startsWith('/admin') && !next.startsWith('//') ? next : '/admin';
}

export async function adminLogin(formData: FormData): Promise<void> {
    // Trimmed to match admin-auth.ts, which does `process.env.ADMIN_DASHBOARD_PASSWORD?.trim()`.
    // Without this the two sides disagree: a value pasted from a phone or a chat
    // client carries a trailing space or newline, the stored side has it stripped,
    // and the compare fails with the generic "invalid password" — indistinguishable
    // from actually getting it wrong. Trailing whitespace can never be significant
    // here precisely because the stored side already discards it.
    const password = String(formData.get('password') ?? '').trim();
    const next = sanitizeNext(formData.get('next'));

    const hdrs = await headers();
    const ip =
        hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        hdrs.get('x-real-ip') ||
        'unknown';

    // ATOMICALLY reserve this attempt in the shared DB state BEFORE touching
    // the password: one Postgres RPC inserts the attempt row and counts the
    // trailing 10-minute window including it, under an advisory lock, so a
    // synchronized parallel burst cannot slip past the thresholds (>5 recent
    // failures from this IP or >20 overall = refuse; see admin-rate-limit.ts
    // and codex's PR #61 re-review). A refused caller sees the exact same
    // generic error whether or not the guess was correct — the limiter never
    // becomes a password oracle — and the refused attempt's row stays
    // recorded, so hammering while locked out only extends the lockout.
    const { allowed, attemptId } = await reserveAdminLoginAttempt(ip);
    if (!allowed) {
        console.error(`[Admin] Rate-limited login attempt rejected (ip=${ip})`);
        redirect(`${next}?error=1`);
    }

    // createAdminSessionToken() is null when the gate is disabled (env unset
    // or too short); that case fails identically to a wrong password so
    // unauthenticated visitors cannot probe whether the gate is configured.
    const token = verifyAdminPassword(password) ? createAdminSessionToken() : null;

    if (!token) {
        // The reservation above already recorded this attempt in the shared
        // DB state; on top of that, log it (with client IP when the platform
        // provides it) and apply a randomized 500-1500ms delay to slow
        // serial guessing between limiter thresholds.
        console.error(`[Admin] Failed login attempt (ip=${ip})`);
        await new Promise(resolve => setTimeout(resolve, 500 + crypto.randomInt(1001)));
        redirect(`${next}?error=1`);
    }

    // Success: delete the provisional attempt row so legitimate logins never
    // accumulate toward the failure thresholds (no admin self-lockout).
    if (attemptId) await clearAdminLoginAttempt(attemptId);

    const cookieStore = await cookies();
    cookieStore.set(ADMIN_COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        // Path '/' rather than '/admin'. The narrower path is the only place a
        // correct login can still look like a failure: any request that lands
        // outside /admin (a redirect through the apex, a service worker, an
        // in-app webview normalising the URL) does not carry the cookie and the
        // user is bounced back to the login form having actually authenticated.
        // Scoping to the host costs nothing here - the cookie is httpOnly,
        // Secure and sameSite=lax, and the site has no other consumer of it.
        path: '/',
        maxAge: ADMIN_SESSION_TTL_SECONDS,
    });
    redirect(next);
}

export async function adminLogout(): Promise<void> {
    const cookieStore = await cookies();
    cookieStore.set(ADMIN_COOKIE_NAME, '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',   // must match the path the session was set with, or logout cannot clear it
        maxAge: 0,
    });
    redirect('/admin');
}
