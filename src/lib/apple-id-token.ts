// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sign in with Apple: verify an Apple identity token (antfarm#125, server
 * half of CodeWatchiOS#13).
 *
 * The token is an RS256 JWT signed by Apple. Verification here is done with
 * Node's crypto against Apple's published JWKS (https://appleid.apple.com/auth/keys)
 * so no new dependency is needed. Checks, in order: header alg + kid, key
 * lookup (refetching the JWKS once on an unknown kid, since Apple rotates),
 * signature, issuer, audience (the iOS bundle id), expiry.
 *
 * Apple only sends `email` on the FIRST sign-in for an account (and it may be
 * a private relay address); `sub` is the stable identifier. The route stores
 * `sub` on the auth user so later tokens without email still resolve.
 *
 * `fetchKeys` is injectable so tests can sign with their own key pair.
 */
import crypto from 'crypto';

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
export const DEFAULT_APPLE_AUDIENCES = ['com.thinkoff.codewatch.ios'];

export interface AppleJwk { kty: string; kid: string; use?: string; alg?: string; n: string; e: string }
export type KeyFetcher = () => Promise<AppleJwk[]>;

export interface AppleIdentity {
    sub: string;
    email: string | null;
    emailVerified: boolean;
    isPrivateEmail: boolean;
    /** The `nonce` claim: Apple echoes whatever the client put in the
     * authorization request (by convention the SHA-256 hex of a random
     * string). null when the client sent none. */
    nonce: string | null;
    /** Token expiry (epoch seconds); bounds how long a consumed-nonce record
     * needs to be kept. */
    exp: number;
}

export const NONCE_MIN = 8;
export const NONCE_MAX = 256;

export function hashNonce(rawNonce: string): string {
    return crypto.createHash('sha256').update(rawNonce, 'utf8').digest('hex');
}

/** The token's nonce claim must be the SHA-256 hex of the raw nonce the
 * client sends alongside (Apple's documented pattern); a client that passed
 * the raw value unhashed to Apple is accepted too. Constant-time compare. */
export function nonceMatches(rawNonce: string, claimNonce: string | null): boolean {
    if (!claimNonce || !rawNonce) return false;
    const eq = (a: string, b: string) => {
        const ab = Buffer.from(a, 'utf8');
        const bb = Buffer.from(b, 'utf8');
        return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
    };
    return eq(claimNonce, hashNonce(rawNonce)) || eq(claimNonce, rawNonce);
}

// Consumption of a nonce (one exchange per token) and the sub -> user link
// are enforced by primary keys in supabase/migrations/20260903_apple_sign_in.sql;
// see the relay auth route. Nothing in memory or metadata can be atomic.

export type AppleVerifyResult =
    | { ok: true; identity: AppleIdentity }
    | { ok: false; error: string };

function b64urlDecode(s: string): Buffer {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function parseJson(buf: Buffer): Record<string, unknown> | null {
    try {
        const v = JSON.parse(buf.toString('utf8'));
        return v && typeof v === 'object' ? v as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/** Parse the audience env value: comma-separated bundle ids. */
export function parseAudiences(raw: string | undefined, defaults = DEFAULT_APPLE_AUDIENCES): string[] {
    const extra = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return [...new Set([...defaults, ...extra])];
}

// Module-level JWKS cache: Apple's keys change rarely; an unknown kid forces
// one refetch so a rotation never needs a deploy.
let cachedKeys: { keys: AppleJwk[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export async function fetchAppleKeys(): Promise<AppleJwk[]> {
    const now = Date.now();
    if (cachedKeys && now - cachedKeys.fetchedAt < CACHE_TTL_MS) return cachedKeys.keys;
    const resp = await fetch(APPLE_JWKS_URL);
    if (!resp.ok) throw new Error(`Apple JWKS fetch failed: ${resp.status}`);
    const body = await resp.json() as { keys?: AppleJwk[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    cachedKeys = { keys, fetchedAt: now };
    return keys;
}

/** Drop the cache so the next verify refetches (used after an unknown kid). */
export function resetAppleKeyCache(): void {
    cachedKeys = null;
}

// An unknown kid triggers at most one refetch per cooldown window. This
// route is unauthenticated, so without the gate a stream of tokens with
// made-up kids would turn every request into a fetch of Apple's JWKS
// (codexmb review of #126). Apple rotates keys rarely; one refetch a minute
// still picks a rotation up within a minute.
export const UNKNOWN_KID_REFETCH_COOLDOWN_MS = 60_000;
let lastUnknownKidRefetchAt = 0;

/** True (and arms the cooldown) when an unknown-kid refetch may run now. */
export function unknownKidRefetchAllowed(now = Date.now()): boolean {
    if (now - lastUnknownKidRefetchAt < UNKNOWN_KID_REFETCH_COOLDOWN_MS) return false;
    lastUnknownKidRefetchAt = now;
    return true;
}

/** Test hook: forget the last refetch time. */
export function resetUnknownKidRefetchGate(): void {
    lastUnknownKidRefetchAt = 0;
}

export async function verifyAppleIdToken(
    token: string,
    audiences: string[],
    fetchKeys: KeyFetcher = fetchAppleKeys,
    now: number = Math.floor(Date.now() / 1000),
): Promise<AppleVerifyResult> {
    if (typeof token !== 'string' || token.length > 8192) return { ok: false, error: 'malformed token' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, error: 'malformed token' };
    const [h, p, sig] = parts;

    const header = parseJson(b64urlDecode(h));
    if (!header) return { ok: false, error: 'malformed header' };
    if (header.alg !== 'RS256') return { ok: false, error: `unsupported alg ${String(header.alg)}` };
    const kid = typeof header.kid === 'string' ? header.kid : '';
    if (!kid) return { ok: false, error: 'missing kid' };

    let keys = await fetchKeys();
    let jwk = keys.find(k => k.kid === kid);
    if (!jwk && fetchKeys === fetchAppleKeys && unknownKidRefetchAllowed()) {
        resetAppleKeyCache();
        keys = await fetchKeys();
        jwk = keys.find(k => k.kid === kid);
    }
    if (!jwk) return { ok: false, error: 'unknown kid' };
    if (jwk.kty !== 'RSA') return { ok: false, error: 'unexpected key type' };

    let publicKey: crypto.KeyObject;
    try {
        publicKey = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    } catch {
        return { ok: false, error: 'bad key' };
    }
    const signed = Buffer.from(`${h}.${p}`, 'utf8');
    let valid = false;
    try {
        valid = crypto.verify('sha256', signed, { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, b64urlDecode(sig));
    } catch {
        valid = false;
    }
    if (!valid) return { ok: false, error: 'bad signature' };

    const claims = parseJson(b64urlDecode(p));
    if (!claims) return { ok: false, error: 'malformed claims' };
    if (claims.iss !== APPLE_ISSUER) return { ok: false, error: 'wrong issuer' };
    const aud = claims.aud;
    const audList = Array.isArray(aud) ? aud : [aud];
    if (!audList.some(a => typeof a === 'string' && audiences.includes(a))) return { ok: false, error: 'wrong audience' };
    if (typeof claims.exp !== 'number' || claims.exp <= now) return { ok: false, error: 'expired' };
    if (typeof claims.iat === 'number' && claims.iat > now + 300) return { ok: false, error: 'issued in the future' };
    const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
    if (!sub) return { ok: false, error: 'missing sub' };

    const email = typeof claims.email === 'string' && claims.email.includes('@') ? claims.email.trim().toLowerCase() : null;
    const truthy = (v: unknown) => v === true || v === 'true';
    const nonce = typeof claims.nonce === 'string' && claims.nonce.trim() ? claims.nonce.trim() : null;
    return {
        ok: true,
        identity: {
            sub,
            email,
            emailVerified: truthy(claims.email_verified),
            isPrivateEmail: truthy(claims.is_private_email),
            nonce,
            exp: claims.exp,
        },
    };
}
