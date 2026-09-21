// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fixture API behind the dev-only /dev/fleet page.
 *
 * The real IntentDashboard fetches `${baseUrl}/intent/<id>`,
 * `${baseUrl}/intent/<id>/history` and `${baseUrl}/profile/<id>`. Pointing its
 * `baseUrl` at this handler is what lets the REAL component render against
 * fixtures with no auth and no database - a mock copy of the component would
 * drift from production and be worse than nothing.
 *
 * NOT AVAILABLE IN PRODUCTION. Every method returns 404 there, and the guard is
 * the first statement so no fixture data is assembled on the way to it.
 */
import { NextResponse } from 'next/server';
import { IS_DEV_ONLY_ENABLED } from '@/lib/dev-only';
import { fleetFixtureHistory, fleetFixtureProfile, fleetFixtureState } from '@/lib/fleet-fixtures';

// The scenario arrives as a query param, so this must not be cached as one
// static response for every scenario.
export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ path: string[] }> };

export async function GET(request: Request, { params }: RouteParams) {
    if (!IS_DEV_ONLY_ENABLED) {
        return new NextResponse('Not Found', { status: 404 });
    }

    const { path } = await params;
    const segments = path ?? [];
    // The page passes the scenario as the dashboard's `userId`, which lands in
    // segment 1 of every one of its three requests. `?scenario=` still wins, so
    // this handler can also be curled directly.
    const scenario = new URL(request.url).searchParams.get('scenario') ?? segments[1] ?? undefined;

    // /profile/<id>
    if (segments[0] === 'profile') {
        return NextResponse.json(fleetFixtureProfile(scenario));
    }
    // /intent/<id>/history
    if (segments[0] === 'intent' && segments[2] === 'history') {
        return NextResponse.json(fleetFixtureHistory(scenario));
    }
    // /intent/<id>
    if (segments[0] === 'intent') {
        return NextResponse.json(fleetFixtureState(scenario));
    }

    return new NextResponse('Not Found', { status: 404 });
}
