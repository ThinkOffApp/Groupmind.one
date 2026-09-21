// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GitHub device flow, ported from CodeWatch's `GithubDeviceFlow.kt`.
 *
 * Why device flow and not a redirect OAuth app: this repo is self-hosted.
 * A redirect-based app needs a callback URL registered per deployment, and
 * every self-hoster gets that wrong once (wrong scheme, wrong port, trailing
 * slash) before it works. Device flow needs no callback URL at all: the
 * browser asks GitHub for a short user code, the person types that code on
 * github.com/login/device on any device they are already signed in on, and
 * this server polls until GitHub hands over a token. The client id is a
 * public identifier - device flow is designed for public clients and there
 * is no client secret to leak.
 *
 * These calls run SERVER-side, which is not an implementation detail: the
 * github.com device endpoints send no CORS headers, so a browser fetch would
 * fail; and routing them through the server is what lets the access token
 * land in an httpOnly cookie without ever passing through page JavaScript.
 *
 * Nothing in this module logs. The token is a credential and the one place
 * it is allowed to appear is an outgoing Authorization header.
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Fallback if GitHub stops returning `verification_uri`. */
export const VERIFICATION_URL = 'https://github.com/login/device';

export type FetchImpl = typeof fetch;

export interface DeviceFlowOptions {
    clientId: string;
    /**
     * OAuth scope string, or '' for a GitHub App.
     *
     * A GitHub App sends no scope: its permissions live on the App itself,
     * which is the least-privilege option and the one CodeWatch uses. An
     * OAuth App has no permissions of its own, so a self-hoster registering
     * one must name a scope (`public_repo`, or `repo` for private repos).
     */
    scope?: string;
    fetchImpl?: FetchImpl;
}

export interface DeviceCode {
    userCode: string;
    deviceCode: string;
    verificationUri: string;
    intervalSec: number;
    expiresInSec: number;
}

export type PollResult =
    | { status: 'token'; token: string }
    | { status: 'pending' }
    | { status: 'slow_down'; intervalSec: number }
    | { status: 'denied' }
    | { status: 'expired' }
    | { status: 'error'; message: string };

/** Device-flow client id for this deployment, or null when unconfigured. */
export function deviceClientId(env: NodeJS.ProcessEnv = process.env): string | null {
    const id = (env.GITHUB_DEVICE_CLIENT_ID || '').trim();
    return id.length > 0 ? id : null;
}

/** Scope to request; empty for a GitHub App (see [DeviceFlowOptions.scope]). */
export function deviceScope(env: NodeJS.ProcessEnv = process.env): string {
    return (env.GITHUB_DEVICE_SCOPE || '').trim();
}

async function postForm(
    url: string,
    fields: Record<string, string>,
    fetchImpl: FetchImpl
): Promise<Record<string, unknown>> {
    const body = new URLSearchParams(fields).toString();
    const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'groupmind-web',
        },
        body,
    });
    const text = await res.text();
    if (!res.ok) {
        // Deliberately status-only. The body is never echoed, because the
        // token endpoint's 200 body carries an access token and one shared
        // error path is how that ends up in a log.
        throw new Error(`GitHub answered HTTP ${res.status}`);
    }
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new Error('GitHub answered with a body that was not JSON');
    }
}

const str = (o: Record<string, unknown>, k: string): string =>
    typeof o[k] === 'string' ? (o[k] as string) : '';
const num = (o: Record<string, unknown>, k: string, fallback: number): number =>
    typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : fallback;

/**
 * Ask GitHub for a fresh user code. Throws on network failure - the caller
 * shows the error and the person just presses Connect again.
 */
export async function requestDeviceCode(opts: DeviceFlowOptions): Promise<DeviceCode> {
    const fields: Record<string, string> = { client_id: opts.clientId };
    if (opts.scope) fields.scope = opts.scope;
    const json = await postForm(DEVICE_CODE_URL, fields, opts.fetchImpl ?? fetch);
    const userCode = str(json, 'user_code');
    const deviceCode = str(json, 'device_code');
    if (!userCode || !deviceCode) throw new Error('GitHub did not return a device code');
    return {
        userCode,
        deviceCode,
        verificationUri: str(json, 'verification_uri') || VERIFICATION_URL,
        intervalSec: num(json, 'interval', 5),
        expiresInSec: num(json, 'expires_in', 900),
    };
}

/**
 * One poll of the token endpoint. The caller owns the loop and the interval
 * (plus 5s on slow_down, per GitHub's contract).
 *
 * All four documented waiting/failure states are distinguished, because they
 * mean four different things to the person staring at the code:
 * authorization_pending (keep waiting), slow_down (keep waiting, slower),
 * expired_token (start over), access_denied (they pressed Cancel).
 */
export async function pollDeviceToken(
    deviceCode: string,
    opts: DeviceFlowOptions
): Promise<PollResult> {
    let json: Record<string, unknown>;
    try {
        json = await postForm(
            TOKEN_URL,
            {
                client_id: opts.clientId,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            },
            opts.fetchImpl ?? fetch
        );
    } catch {
        // A network blip mid-poll is routine - the person is walking to
        // another device to type the code. Treat it as pending, not fatal.
        return { status: 'pending' };
    }

    const token = str(json, 'access_token');
    if (token) return { status: 'token', token };

    switch (str(json, 'error')) {
        case 'authorization_pending':
            return { status: 'pending' };
        case 'slow_down':
            return { status: 'slow_down', intervalSec: num(json, 'interval', 10) };
        case 'access_denied':
            return { status: 'denied' };
        case 'expired_token':
            return { status: 'expired' };
        default: {
            const desc = str(json, 'error_description');
            return { status: 'error', message: desc || 'GitHub answered with an unknown error' };
        }
    }
}
