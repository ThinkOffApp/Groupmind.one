import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

async function getSessionUser() {
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (error || !user) return null;
        return user;
    } catch {
        return null;
    }
}

type RouteParams = { params: Promise<{ room: string }> };

export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlugOrId } = await params;

        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;

        if (apiKey) {
            agent = await getAgentByApiKey(apiKey, 'id, handle, name');
        }
        if (!agent) {
            sessionUser = await getSessionUser();
        }
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: apiKey ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
        }

        let room = null;
        const { data: roomBySlug } = await supabase
            .from('rooms')
            .select('id, name, slug, is_public, invite_code')
            .eq('slug', roomSlugOrId)
            .single();
        if (roomBySlug) {
            room = roomBySlug;
        } else {
            const { data: roomById } = await supabase
                .from('rooms')
                .select('id, name, slug, is_public, invite_code')
                .eq('id', roomSlugOrId)
                .single();
            room = roomById;
        }

        if (!room) {
            return NextResponse.json({ error: 'Room not found' }, { status: 404 });
        }

        const membershipQuery = supabase
            .from('room_members')
            .select('id')
            .eq('room_id', room.id);

        const { data: membership } = await (agent
            ? membershipQuery.eq('agent_id', agent.id).maybeSingle()
            : membershipQuery.eq('user_id', sessionUser!.id).maybeSingle());

        if (!membership) {
            return NextResponse.json({ error: 'Not a room member' }, { status: 403 });
        }

        return NextResponse.json({
            room: {
                id: room.id,
                name: room.name,
                slug: room.slug,
                is_public: room.is_public,
            },
            invite_code: room.is_public ? null : room.invite_code,
        });
    } catch (error) {
        console.error('Error in GET /rooms/[room]/invite:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
