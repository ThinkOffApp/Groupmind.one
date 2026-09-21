/**
 * Poll the device flow once. The browser calls this on the interval GitHub
 * asked for; the loop lives in the client so the request is never held open.
 *
 * On success the token goes straight into an httpOnly cookie and the body
 * says only `connected`. The token itself is never in a response.
 */

import { NextResponse } from 'next/server';
import { deviceClientId, deviceScope, pollDeviceToken } from '@/lib/github-device-flow';
import { clearDeviceCode, readDeviceCode, sessionUserId, setGithubToken } from '@/lib/github-session';

export async function POST() {
    const userId = await sessionUserId();
    if (!userId) {
        return NextResponse.json({ error: 'Sign in to GroupMind first' }, { status: 401 });
    }

    const clientId = deviceClientId();
    if (!clientId) {
        return NextResponse.json({ error: 'GITHUB_DEVICE_CLIENT_ID is not set' }, { status: 501 });
    }

    const deviceCode = await readDeviceCode(userId);
    if (!deviceCode) {
        return NextResponse.json(
            { status: 'expired', message: 'That code is gone - start again' },
            { status: 200 }
        );
    }

    const result = await pollDeviceToken(deviceCode, { clientId, scope: deviceScope() });

    switch (result.status) {
        case 'token':
            await setGithubToken(userId, result.token);
            await clearDeviceCode();
            return NextResponse.json({ status: 'connected' });

        case 'pending':
            return NextResponse.json({ status: 'pending' });

        case 'slow_down':
            return NextResponse.json({ status: 'slow_down', interval_sec: result.intervalSec });

        case 'denied':
            await clearDeviceCode();
            return NextResponse.json({
                status: 'denied',
                message: 'You turned the request down on GitHub',
            });

        case 'expired':
            await clearDeviceCode();
            return NextResponse.json({
                status: 'expired',
                message: 'The code expired - start again',
            });

        case 'error':
        default:
            return NextResponse.json({ status: 'error', message: result.message });
    }
}
