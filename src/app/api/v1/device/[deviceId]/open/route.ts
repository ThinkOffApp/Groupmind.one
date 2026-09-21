import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getIntentState, mergeIntentStates } from '@/lib/intent-store';

type RouteParams = { params: Promise<{ deviceId: string }> };

/**
 * GET /api/v1/device/{deviceId}/open
 *
 * Redirects to a device's CURRENT reach_url.
 *
 * The car Pi publishes a Cloudflare quick tunnel whose hostname changes on
 * every single boot, and the Pi power-cycles on every trip - four times in one
 * day on 2026-08-19. A user was reduced to asking an agent for the address each
 * time, and a stale bookmark fails SILENTLY (it resolves to nothing, or worse
 * to somebody else's tunnel). The device registry always knows the live value,
 * so this route turns "which URL is it today" into one permanent bookmark.
 *
 * Only ever redirects to a device belonging to the signed-in user, and only to
 * http(s), so it cannot be used as an open redirect.
 */
export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { deviceId } = await params;

        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (error || !user) {
            return NextResponse.json({ error: 'Sign in to open a device' }, { status: 401 });
        }

        const profileRes = await serverClient
            .from('user_profiles')
            .select('handle')
            .eq('user_id', user.id)
            .single();
        // Cast rather than rely on generated row types: the same lookup in the
        // intent route trips TS2339 ("handle does not exist on type never")
        // because user_profiles is not in the generated schema. Copying that
        // pattern would have added another error to the baseline.
        const profile = profileRes.data as { handle?: string | null } | null;
        const handle = profile?.handle?.replace('@', '') || null;

        // The fleet publishes under the handle while the web session knows the
        // UUID; the same merge the intent route does, for the same reason.
        let state = await getIntentState(user.id);
        if (handle && handle !== user.id) {
            state = mergeIntentStates(state, await getIntentState(handle));
        }

        const devices = (state?.devices || {}) as Record<string, Record<string, unknown>>;
        const device = devices[deviceId];
        if (!device) {
            const known = Object.keys(devices).sort().join(', ') || 'none are publishing right now';
            return NextResponse.json(
                { error: `No device "${deviceId}" is publishing`, known_devices: known },
                { status: 404 },
            );
        }

        const reachUrl = String(device.reach_url || '').trim();
        if (!reachUrl) {
            return NextResponse.json(
                { error: `"${deviceId}" is publishing but has no reach_url - it is up without a tunnel` },
                { status: 409 },
            );
        }

        // Never redirect anywhere but a real web address.
        let parsed: URL;
        try {
            parsed = new URL(reachUrl);
        } catch {
            return NextResponse.json({ error: 'Device published a malformed reach_url' }, { status: 502 });
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return NextResponse.json({ error: 'Device reach_url is not http(s)' }, { status: 502 });
        }

        // Say how old the value is rather than hiding it: a device that died
        // five minutes ago still has a reach_url, and following it silently is
        // exactly the failure this route exists to remove.
        const res = NextResponse.redirect(parsed.toString(), 302);
        if (device.updated_at) res.headers.set('X-Device-Updated-At', String(device.updated_at));
        res.headers.set('Cache-Control', 'no-store');
        return res;
    } catch (err) {
        console.error('Error in GET /api/v1/device/[deviceId]/open:', err);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
