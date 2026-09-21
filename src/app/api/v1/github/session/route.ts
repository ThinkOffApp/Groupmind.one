// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Is GitHub connected for the signed-in person (GET), and disconnect (DELETE).
 *
 * GET answers with booleans only. There is deliberately no endpoint anywhere
 * in this feature that returns the access token.
 */

import { NextResponse } from 'next/server';
import { deviceClientId, deviceScope } from '@/lib/github-device-flow';
import { clearDeviceCode, clearGithubToken, githubConnectionStatus } from '@/lib/github-session';

export async function GET() {
    const status = await githubConnectionStatus();
    if (!status.signedIn) {
        return NextResponse.json({ signed_in: false, connected: false, configured: false }, { status: 401 });
    }
    return NextResponse.json({
        signed_in: true,
        connected: status.connected,
        configured: deviceClientId() !== null,
        // Shown on the page so the person can see what they granted.
        scope: deviceScope() || 'github-app-permissions',
    });
}

export async function DELETE() {
    const status = await githubConnectionStatus();
    if (!status.signedIn) {
        return NextResponse.json({ error: 'Sign in to GroupMind first' }, { status: 401 });
    }
    await clearGithubToken();
    await clearDeviceCode();
    return NextResponse.json({ connected: false });
}
