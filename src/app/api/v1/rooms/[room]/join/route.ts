import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

// Get authenticated user from the Supabase session.
// 1) SSR cookie session (desktop web). 2) Authorization: Bearer <access_token>
// from the client session — some mobile browsers (notably Android Chrome) don't
// reliably round-trip the ~5KB chunked SSR auth cookie to the server, so cookie-only
// auth 401'd and rooms wouldn't open. The bearer token is validated with the service
// client and is cookie-independent. (A Supabase user JWT is not an xfb_ agent key, so
// the agent-key path above simply doesn't match it and we fall through to here.)
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

// POST /api/v1/rooms/{room}/join - Join a room
export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug } = await params;

        // Try API key auth first (for agents)
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;

        if (apiKey) {
            agent = await getAgentByApiKey(apiKey, 'id, handle, name');
        }

        // If no API key or invalid, try session auth (for web UI users)
        if (!agent) {
            sessionUser = await getSessionUser(request);
        }

        // Require at least one auth method
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: apiKey ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
        }

        // Find room by slug first, then by ID
        let room = null;

        // Try by slug first
        const { data: roomBySlug } = await supabase
            .from('rooms')
            .select('id, name, slug, is_public, invite_code')
            .eq('slug', roomSlug)
            .single();

        if (roomBySlug) {
            room = roomBySlug;
        } else {
            // Try by UUID
            const { data: roomById } = await supabase
                .from('rooms')
                .select('id, name, slug, is_public, invite_code')
                .eq('id', roomSlug)
                .single();
            room = roomById;
        }

        if (!room) {
            return NextResponse.json({ error: 'Room not found' }, { status: 404 });
        }

        // Check if already a member
        let existingMembership = null;

        if (agent) {
            const { data: existing } = await supabase
                .from('room_members')
                .select('id')
                .eq('room_id', room.id)
                .eq('agent_id', agent.id)
                .single();
            existingMembership = existing;
        } else if (sessionUser) {
            const { data: existing } = await supabase
                .from('room_members')
                .select('id')
                .eq('room_id', room.id)
                .eq('user_id', sessionUser.id)
                .single();
            existingMembership = existing;
        }

        if (existingMembership) {
            return NextResponse.json({
                message: 'Already a member',
                room_id: room.id,
                slug: room.slug,
            });
        }

        // Private room requires invite code
        if (!room.is_public) {
            const body = await request.json().catch(() => ({}));
            const { invite_code } = body;

            if (!invite_code || invite_code !== room.invite_code) {
                return NextResponse.json({ error: 'Invalid or missing invite code' }, { status: 403 });
            }
        }

        // Add as member (either agent or user)
        const memberData: { room_id: string; agent_id?: string; user_id?: string } = {
            room_id: room.id,
        };

        if (agent) {
            memberData.agent_id = agent.id;
        }
        if (sessionUser) {
            memberData.user_id = sessionUser.id;
        }

        const { error } = await supabase.from('room_members').insert(memberData);

        if (error) {
            console.error('Error joining room:', error);
            return NextResponse.json({ error: 'Failed to join room' }, { status: 500 });
        }

        return NextResponse.json({
            message: 'Joined room',
            room_id: room.id,
            slug: room.slug,
            name: room.name,
        }, { status: 201 });

    } catch (error) {
        console.error('Error in POST /rooms/join:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
