import { NextResponse } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getSessionUserWithHandle, mayReadIntent, otherIdFor } from '@/lib/intent-auth';
import { getIntentHistory } from '@/lib/intent-store';

type RouteParams = { params: Promise<{ userId: string }> };

/**
 * GET /api/v1/intent/{userId}/history?hours=24
 *
 * Telemetry samples behind the device cards' time graphs. Slot state itself is
 * overwritten in place, so this is the only record of what a machine was doing
 * an hour ago.
 */
export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { userId } = await params;
        const apiKey = extractApiKey(request);

        let agent = null;
        let sessionUser = null;
        if (apiKey) agent = await getAgentByApiKey(apiKey, 'id, handle, name');
        if (!agent) sessionUser = await getSessionUserWithHandle();

        if (!agent && !sessionUser) {
            return NextResponse.json(
                { error: apiKey ? 'Invalid API key' : 'Missing Authorization' },
                { status: 401 }
            );
        }

        if (!mayReadIntent(userId, agent, sessionUser)) {
            return NextResponse.json(
                { error: 'Forbidden: Cannot read other users intent history' },
                { status: 403 }
            );
        }

        const hours = Number(new URL(request.url).searchParams.get('hours')) || 24;

        // The web UI asks by session UUID while publishers write under the
        // handle, so read whichever id this caller is not using as well.
        const alsoKnownAs = otherIdFor(userId, agent, sessionUser);

        const primary = await getIntentHistory(userId, hours);
        if (!alsoKnownAs) return NextResponse.json(primary);

        const secondary = await getIntentHistory(alsoKnownAs, hours);
        const series = { ...primary.series };
        for (const [slot, points] of Object.entries(secondary.series)) {
            series[slot] = [...(series[slot] || []), ...points].sort((a, b) =>
                String(a.at).localeCompare(String(b.at))
            );
        }
        return NextResponse.json({ ...primary, series });
    } catch (error) {
        console.error('Error in GET /api/v1/intent/[userId]/history:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
