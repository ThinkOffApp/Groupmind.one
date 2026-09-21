/**
 * Where the GitHub access token lives.
 *
 * THE DECISION: the token is held in an httpOnly, Secure, SameSite=Lax
 * cookie, scoped to the signed-in GroupMind user, and is never sent to the
 * browser's JavaScript, never put in a URL, and never written to a log.
 *
 * Why not localStorage, which would have been less code: localStorage is
 * readable by any script that ends up on the page, so one XSS - or one
 * badly-behaved third-party script on a self-hosted deployment - is a stolen
 * token that can merge code. httpOnly takes page JavaScript out of the
 * picture entirely. The page never holds the token; it asks this server to
 * act, and this server attaches the credential.
 *
 * Why the cookie also carries the user id: browsers are shared. Without it,
 * person A connects GitHub, signs out, person B signs in on the same browser
 * and inherits A's ability to merge A's repositories. Every read checks the
 * id against the current session and drops the cookie on a mismatch.
 *
 * The cookie value is an encoding, not encryption - it is httpOnly, which is
 * the control that matters here, and a self-hoster who can read the browser
 * profile can read any session cookie the app sets.
 */

import { cookies } from 'next/headers';
import { getSessionUserWithHandle } from './intent-auth';

export const GITHUB_TOKEN_COOKIE = 'gm_gh_token';
export const GITHUB_DEVICE_COOKIE = 'gm_gh_device';

/** GitHub user-to-server tokens do not expire; a year is a sane cookie life. */
const TOKEN_MAX_AGE_SEC = 60 * 60 * 24 * 365;
/** Device codes expire in ~15 minutes; the cookie should not outlive that. */
const DEVICE_MAX_AGE_SEC = 60 * 20;

export interface TokenCookie {
    token: string;
    userId: string;
}

export interface DeviceCookie {
    deviceCode: string;
    userId: string;
}

function encode(value: unknown): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode<T>(raw: string | undefined): T | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        return parsed && typeof parsed === 'object' ? (parsed as T) : null;
    } catch {
        return null;
    }
}

export function encodeTokenCookie(value: TokenCookie): string {
    return encode({ t: value.token, u: value.userId });
}

export function decodeTokenCookie(raw: string | undefined): TokenCookie | null {
    const v = decode<{ t?: unknown; u?: unknown }>(raw);
    if (!v || typeof v.t !== 'string' || typeof v.u !== 'string' || !v.t || !v.u) return null;
    return { token: v.t, userId: v.u };
}

export function encodeDeviceCookie(value: DeviceCookie): string {
    return encode({ d: value.deviceCode, u: value.userId });
}

export function decodeDeviceCookie(raw: string | undefined): DeviceCookie | null {
    const v = decode<{ d?: unknown; u?: unknown }>(raw);
    if (!v || typeof v.d !== 'string' || typeof v.u !== 'string' || !v.d || !v.u) return null;
    return { deviceCode: v.d, userId: v.u };
}

/**
 * `Secure` is dropped outside production so `next dev` over plain http can
 * still set the cookie; every deployment that matters is https.
 */
export function cookieOptions(maxAgeSec: number) {
    return {
        httpOnly: true as const,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        path: '/',
        maxAge: maxAgeSec,
    };
}

export type GithubSessionResult =
    | { ok: true; userId: string; token: string }
    | { ok: false; reason: 'no-session' | 'not-connected' };

/**
 * The signed-in person plus their GitHub token, or why there isn't one.
 *
 * Layered on the repo's existing session check (`getSessionUserWithHandle`)
 * rather than beside it: these routes need a signed-in GroupMind user first,
 * and the GitHub token second.
 */
export async function getGithubSession(): Promise<GithubSessionResult> {
    const user = await getSessionUserWithHandle();
    if (!user) return { ok: false, reason: 'no-session' };

    const store = await cookies();
    const cookie = decodeTokenCookie(store.get(GITHUB_TOKEN_COOKIE)?.value);
    if (!cookie || cookie.userId !== user.id) return { ok: false, reason: 'not-connected' };

    return { ok: true, userId: user.id, token: cookie.token };
}

export async function setGithubToken(userId: string, token: string): Promise<void> {
    const store = await cookies();
    store.set(GITHUB_TOKEN_COOKIE, encodeTokenCookie({ token, userId }), cookieOptions(TOKEN_MAX_AGE_SEC));
}

export async function clearGithubToken(): Promise<void> {
    const store = await cookies();
    store.set(GITHUB_TOKEN_COOKIE, '', { ...cookieOptions(0), maxAge: 0 });
}

export async function setDeviceCode(userId: string, deviceCode: string): Promise<void> {
    const store = await cookies();
    store.set(
        GITHUB_DEVICE_COOKIE,
        encodeDeviceCookie({ deviceCode, userId }),
        cookieOptions(DEVICE_MAX_AGE_SEC)
    );
}

export async function readDeviceCode(userId: string): Promise<string | null> {
    const store = await cookies();
    const cookie = decodeDeviceCookie(store.get(GITHUB_DEVICE_COOKIE)?.value);
    if (!cookie || cookie.userId !== userId) return null;
    return cookie.deviceCode;
}

export async function clearDeviceCode(): Promise<void> {
    const store = await cookies();
    store.set(GITHUB_DEVICE_COOKIE, '', { ...cookieOptions(0), maxAge: 0 });
}

/** Is a GitHub connection present for the signed-in person? Never the token. */
export async function githubConnectionStatus(): Promise<
    { signedIn: false } | { signedIn: true; connected: boolean }
> {
    const user = await getSessionUserWithHandle();
    if (!user) return { signedIn: false };
    const store = await cookies();
    const cookie = decodeTokenCookie(store.get(GITHUB_TOKEN_COOKIE)?.value);
    return { signedIn: true, connected: !!cookie && cookie.userId === user.id };
}

/** The signed-in person's id, or null. Used by the device-flow routes. */
export async function sessionUserId(): Promise<string | null> {
    const user = await getSessionUserWithHandle();
    return user ? user.id : null;
}
