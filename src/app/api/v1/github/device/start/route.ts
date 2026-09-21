/**
 * Start the GitHub device flow: ask GitHub for a user code.
 *
 * The response carries the code and the URL to type it on, and nothing else.
 * The `device_code` - the half that can be exchanged for a token - is put in
 * an httpOnly cookie instead, so a page script cannot complete somebody
 * else's flow and the value never reaches a browser history or a referrer.
 */

import { NextResponse } from 'next/server';
import { deviceClientId, deviceScope, requestDeviceCode } from '@/lib/github-device-flow';
import { sessionUserId, setDeviceCode } from '@/lib/github-session';

export async function POST() {
    const userId = await sessionUserId();
    if (!userId) {
        return NextResponse.json({ error: 'Sign in to GroupMind first' }, { status: 401 });
    }

    const clientId = deviceClientId();
    if (!clientId) {
        return NextResponse.json(
            {
                error:
                    'GITHUB_DEVICE_CLIENT_ID is not set on this deployment. Register a GitHub App ' +
                    'with device flow enabled and set its client id - there is no client secret.',
            },
            { status: 501 }
        );
    }

    try {
        const code = await requestDeviceCode({ clientId, scope: deviceScope() });
        await setDeviceCode(userId, code.deviceCode);
        return NextResponse.json({
            user_code: code.userCode,
            verification_uri: code.verificationUri,
            interval_sec: code.intervalSec,
            expires_in_sec: code.expiresInSec,
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : 'GitHub was unreachable';
        return NextResponse.json({ error: message }, { status: 502 });
    }
}
