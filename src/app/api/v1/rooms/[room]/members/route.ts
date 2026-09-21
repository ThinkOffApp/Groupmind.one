// SPDX-License-Identifier: AGPL-3.0-only
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

type RoomRow = {
    id: string;
    name: string;
    slug: string;
    is_public: boolean;
    created_by: string | null;
    owner_user_id: string | null;
};

// Resolve room by slug, then by id. Returns null if not found.
async function resolveRoom(roomSlugOrId: string): Promise<RoomRow | null> {
    const cols = 'id, name, slug, is_public, created_by, owner_user_id';
    const bySlug = await supabase.from('rooms').select(cols).eq('slug', roomSlugOrId).maybeSingle();
    if (bySlug.data) return bySlug.data as RoomRow;
    const byId = await supabase.from('rooms').select(cols).eq('id', roomSlugOrId).maybeSingle();
    return (byId.data as RoomRow) ?? null;
}

// Authenticate the caller as either an agent (API key) or a web user (session),
// and require that the caller is already a member of the room.
async function callerIsMember(roomId: string, request: Request): Promise<boolean> {
    const apiKey = extractApiKey(request);
    if (apiKey) {
        const agent = await getAgentByApiKey(apiKey, 'id');
        if (agent) {
            const { data } = await supabase
                .from('room_members')
                .select('id')
                .eq('room_id', roomId)
                .eq('agent_id', agent.id)
                .maybeSingle();
            if (data) return true;
        }
    }
    const user = await getSessionUser();
    if (user) {
        const { data } = await supabase
            .from('room_members')
            .select('id')
            .eq('room_id', roomId)
            .eq('user_id', user.id)
            .maybeSingle();
        if (data) return true;
    }
    return false;
}

// Can the caller ADMINISTER the room (add/remove agents)? Conservative:
// if the room has a recorded owner, only that owner (agent created_by OR
// user owner_user_id) qualifies; for legacy ownerless rooms, fall back to
// any member so they remain manageable. Avoids letting a normal member of a
// private room add arbitrary agents.
async function callerCanAdmin(room: RoomRow, request: Request): Promise<boolean> {
    const hasOwner = !!(room.created_by || room.owner_user_id);

    const apiKey = extractApiKey(request);
    if (apiKey) {
        const agent = await getAgentByApiKey(apiKey, 'id, owner_id');
        if (agent) {
            if (room.created_by && room.created_by === agent.id) return true;
            // The CodeWatch app authenticates as the user's AGENT (api key), but
            // a personal room (e.g. alice-home) is owned via owner_user_id (the
            // USER), not created_by (the agent). Treat the agent as owner when it
            // belongs to the room's owning user, so the owner can manage members
            // from the app. (agents.owner_id is the user uuid as text.)
            const agentOwner = (agent as { owner_id?: string | null }).owner_id;
            if (room.owner_user_id && agentOwner && String(agentOwner) === String(room.owner_user_id)) return true;
            if (!hasOwner) {
                const { data } = await supabase
                    .from('room_members').select('id')
                    .eq('room_id', room.id).eq('agent_id', agent.id).maybeSingle();
                if (data) return true;
            }
        }
    }
    const user = await getSessionUser();
    if (user) {
        if (room.owner_user_id && room.owner_user_id === user.id) return true;
        if (!hasOwner) {
            const { data } = await supabase
                .from('room_members').select('id')
                .eq('room_id', room.id).eq('user_id', user.id).maybeSingle();
            if (data) return true;
        }
    }
    return false;
}

// GET /api/v1/rooms/{room}/members - list the room's agent + user members.
export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { room: slugOrId } = await params;
        const room = await resolveRoom(slugOrId);
        if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
        if (!(await callerIsMember(room.id, request))) {
            return NextResponse.json({ error: 'Not a room member' }, { status: 403 });
        }

        // Two-step (no PostgREST embed): fetch membership rows, then resolve
        // agent handles/names separately. The agent:agents() embed is not a
        // reliably-detected FK here and was silently returning an empty set.
        const { data: rows } = await supabase
            .from('room_members')
            .select('agent_id, user_id')
            .eq('room_id', room.id);

        const agentIds = Array.from(
            new Set((rows ?? []).map((r) => (r as { agent_id?: string }).agent_id).filter(Boolean) as string[])
        );
        const agentMap = new Map<string, { handle: string | null; name: string | null }>();
        if (agentIds.length) {
            const { data: agentRows } = await supabase
                .from('agents')
                .select('id, handle, name')
                .in('id', agentIds);
            for (const a of agentRows ?? []) {
                agentMap.set(a.id as string, { handle: (a.handle as string) ?? null, name: (a.name as string) ?? null });
            }
        }

        const members = (rows ?? []).map((m) => {
            const agentId = (m as { agent_id?: string }).agent_id ?? null;
            const agent = agentId ? agentMap.get(agentId) : null;
            return {
                agent_id: agentId,
                user_id: (m as { user_id?: string }).user_id ?? null,
                handle: agent?.handle ?? null,
                name: agent?.name ?? null,
                is_agent: !!agentId,
            };
        });

        return NextResponse.json({ room: { id: room.id, slug: room.slug, name: room.name }, members });
    } catch (error) {
        console.error('GET members error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST /api/v1/rooms/{room}/members  body: { handle }  - add an agent to the room.
export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { room: slugOrId } = await params;
        const room = await resolveRoom(slugOrId);
        if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
        if (!(await callerCanAdmin(room, request))) {
            return NextResponse.json({ error: 'Only the room owner can add agents' }, { status: 403 });
        }

        const body = (await request.json().catch(() => null)) as { handle?: string } | null;
        const handleRaw = body?.handle?.trim();
        if (!handleRaw) return NextResponse.json({ error: 'handle required' }, { status: 400 });
        const handle = handleRaw.replace(/^@/, '');

        const { data: agent } = await supabase
            .from('agents')
            .select('id, handle, name')
            .ilike('handle', handle)
            .maybeSingle();
        if (!agent) {
            return NextResponse.json({ error: `No agent found with handle "${handle}"` }, { status: 404 });
        }

        const { data: existing } = await supabase
            .from('room_members')
            .select('id')
            .eq('room_id', room.id)
            .eq('agent_id', agent.id)
            .maybeSingle();
        if (existing) {
            return NextResponse.json({ message: 'Already a member', handle: agent.handle });
        }

        const { error } = await supabase
            .from('room_members')
            .insert({ room_id: room.id, agent_id: agent.id });
        if (error) {
            console.error('add member error:', error);
            return NextResponse.json({ error: 'Failed to add agent' }, { status: 500 });
        }

        return NextResponse.json(
            { message: 'Added', agent_id: agent.id, handle: agent.handle, name: agent.name },
            { status: 201 }
        );
    } catch (error) {
        console.error('POST members error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// DELETE /api/v1/rooms/{room}/members?agent_id=...  - remove an agent from the room.
export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const { room: slugOrId } = await params;
        const room = await resolveRoom(slugOrId);
        if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
        if (!(await callerCanAdmin(room, request))) {
            return NextResponse.json({ error: 'Only the room owner can remove agents' }, { status: 403 });
        }

        // Accept the member's agent UUID (agent_id) OR its @handle — the app
        // was sending the handle, which never matched agent_id and made the
        // delete a silent no-op that still reported success ("removed yuba,
        // nothing happened"). Resolve a handle to its id first.
        const url = new URL(request.url);
        let agentId = url.searchParams.get('agent_id');
        const handle = url.searchParams.get('handle');
        if (!agentId && handle) {
            const normalized = handle.startsWith('@') ? handle : `@${handle}`;
            const { data: agent } = await supabase
                .from('agents')
                .select('id')
                .eq('handle', normalized)
                .maybeSingle();
            agentId = (agent as { id?: string } | null)?.id ?? null;
        }
        if (!agentId) return NextResponse.json({ error: 'agent_id or handle required' }, { status: 400 });

        // .select() returns the rows actually deleted, so a no-op (member not
        // in the room / wrong id) is reported truthfully instead of a false
        // "Removed".
        const { data: removed, error } = await supabase
            .from('room_members')
            .delete()
            .eq('room_id', room.id)
            .eq('agent_id', agentId)
            .select('agent_id');
        if (error) {
            console.error('remove member error:', error);
            return NextResponse.json({ error: 'Failed to remove agent' }, { status: 500 });
        }
        if (!removed || removed.length === 0) {
            return NextResponse.json(
                { error: 'That agent is not a member of this room (nothing removed)', agent_id: agentId },
                { status: 404 }
            );
        }

        return NextResponse.json({ message: 'Removed', agent_id: agentId, removed: removed.length });
    } catch (error) {
        console.error('DELETE members error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
