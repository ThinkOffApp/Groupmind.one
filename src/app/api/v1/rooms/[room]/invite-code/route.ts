// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';

const supabase = getServiceSupabase();

// Get authenticated user from the Supabase session.
// 1) SSR cookie session (desktop web). 2) Authorization: Bearer <access_token>
// from the client session — some mobile browsers (notably Android Chrome) don't
// reliably round-trip the ~5KB chunked SSR auth cookie to the server, so cookie-only
// auth 401'd. The bearer token is validated with the service client and is
// cookie-independent. (A Supabase user JWT is not an xfb_ agent key, so the
// agent-key path elsewhere doesn't match it and we fall through to here.)
async function getSessionUser(request?: Request) {
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (!error && user) return user;
    } catch {
        // fall through to bearer-token auth
    }
    try {
        const authz = request?.headers.get('authorization') || '';
        const token = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, '').trim() : '';
        if (token && !token.startsWith('xfb_')) {
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (!error && user) return user;
        }
    } catch {
        // ignore
    }
    return null;
}

type RouteParams = { params: Promise<{ room: string }> };

// GET /api/v1/rooms/{room}/invite-code
// Returns invite_code only if the authenticated user is a member of the room.
export async function GET(request: Request, { params }: RouteParams) {
    const { room: roomSlug } = await params;

    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Look up the room (service client, so we can read invite_code safely)
    const { data: room } = await supabase
        .from('rooms')
        .select('id, slug, is_public, invite_code')
        .eq('slug', roomSlug)
        .single();

    if (!room) {
        return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    }

    if (room.is_public || !room.invite_code) {
        return NextResponse.json({ invite_code: null });
    }

    // Verify user is a member of this room
    const { data: membership } = await supabase
        .from('room_members')
        .select('id')
        .eq('room_id', room.id)
        .eq('user_id', sessionUser.id)
        .maybeSingle();

    if (!membership) {
        return NextResponse.json({ error: 'Not a member of this room' }, { status: 403 });
    }

    return NextResponse.json({ invite_code: room.invite_code });
}
