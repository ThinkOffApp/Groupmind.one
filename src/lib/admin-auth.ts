// Admin dashboard auth — single shared password from ADMIN_DASHBOARD_PASSWORD.
//
// SECURITY TRADEOFF (accepted, documented): this is ONE shared password with
// no per-admin identity and no audit trail. Proportional mitigations applied:
// the password must be long and random (length >= 32 enforced — the gate
// refuses to enable below that), failed logins are rate limited via shared
// DB state (admin-rate-limit.ts), delayed and logged, sessions are signed
// AND expire server-side, and admin views only ever see masked emails.
// Revisit with real per-admin accounts if more than a couple of people need
// access.
//
// Server-side only. No password (or derivative that reveals it) is ever
// rendered to the client; the session cookie carries a signed payload
// (expiry + per-session nonce, HMAC keyed by the password) that is useless
// without the env var and auto-invalidates when the password rotates.

import 'server-only';
import crypto from 'crypto';

export const ADMIN_COOKIE_NAME = 'gm_admin';
/** Server-enforced session lifetime (also used as the cookie max-age). */
export const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const TOKEN_CONTEXT = 'groupmind-admin-dashboard-v2';
// Refuse to enable the gate below this. 32 random characters is the floor,
// not a suggestion: generate with `openssl rand -base64 32` (see README).
const MIN_PASSWORD_LENGTH = 32;

let warnedWeakPassword = false;

function getAdminPassword(): string | null {
    const pw = process.env.ADMIN_DASHBOARD_PASSWORD?.trim();
    if (!pw) return null;
    if (pw.length < MIN_PASSWORD_LENGTH) {
        if (!warnedWeakPassword) {
            warnedWeakPassword = true;
            // NOTE: one template literal on purpose — Turbopack's production
            // constant folding has been observed dropping segments when
            // interpolated template literals are `+`-concatenated here.
            console.error(
                `[Admin] ADMIN_DASHBOARD_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters; the admin gate is DISABLED. Set a value of at least ${MIN_PASSWORD_LENGTH} random characters (e.g. \`openssl rand -base64 32\`) and redeploy.`
            );
        }
        return null; // weak password = gate disabled, never authenticates
    }
    return pw;
}

/**
 * Constant-time string comparison. Hashing both sides first normalizes
 * length so timingSafeEqual can be used on arbitrary inputs.
 */
function safeEqual(a: string, b: string): boolean {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** Check a submitted password against ADMIN_DASHBOARD_PASSWORD. */
export function verifyAdminPassword(input: string): boolean {
    const pw = getAdminPassword();
    if (!pw) return false; // unset/weak env var = dashboard disabled
    return safeEqual(input, pw);
}

function signSession(pw: string, expiresAtMs: number, nonce: string): string {
    return crypto
        .createHmac('sha256', pw)
        .update(`${TOKEN_CONTEXT}.${expiresAtMs}.${nonce}`)
        .digest('hex');
}

/**
 * Mint the value stored in the httpOnly session cookie:
 * `<expiresAtMs>.<nonce>.<hmac>` — an HMAC-SHA256 (keyed by the admin
 * password) over the expiry timestamp and a random per-session nonce.
 * One-way (does not expose the password), unique per login, expires
 * server-side, and rotates automatically when the password changes.
 */
export function createAdminSessionToken(): string | null {
    const pw = getAdminPassword();
    if (!pw) return null;
    const expiresAtMs = Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000;
    const nonce = crypto.randomBytes(16).toString('hex');
    return `${expiresAtMs}.${nonce}.${signSession(pw, expiresAtMs, nonce)}`;
}

/**
 * Validate a session cookie: HMAC signature (constant time) AND server-side
 * expiry check on every request. Expired or tampered tokens are rejected
 * regardless of what the client claims via cookie max-age.
 */
export function verifyAdminCookie(value: string | undefined | null): boolean {
    if (!value) return false;
    const pw = getAdminPassword();
    if (!pw) return false;

    const parts = value.split('.');
    if (parts.length !== 3) return false;
    const [expStr, nonce, sig] = parts;
    const expiresAtMs = Number(expStr);
    if (!Number.isFinite(expiresAtMs)) return false;

    if (!safeEqual(sig, signSession(pw, expiresAtMs, nonce))) return false;
    return Date.now() < expiresAtMs;
}
