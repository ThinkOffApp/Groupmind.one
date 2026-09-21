import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
// Human users post through the shared web_user relay agent; ownership of those
// messages is carried in metadata.user.id (see messages/route.ts POST).
import { WEB_USER_AGENT_ID } from '@/lib/web-agent';

const supabase = getServiceSupabase();

// How long after posting a message its author may delete it.
const DELETE_WINDOW_MS = 15 * 60 * 1000;

// Get authenticated user from the Supabase session.
// 1) SSR cookie session (desktop web). 2) Authorization: Bearer <access_token>
// from the client session — same mobile-cookie fallback as the react route.
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

type RouteParams = { params: Promise<{ room: string; messageId: string }> };

/**
 * DELETE /api/v1/rooms/{room}/messages/{messageId}
 *
 * Delete your OWN message within DELETE_WINDOW_MS of posting (the
 * "typed in the wrong window" fix, reported by a user). Applies to both
 * humans (session auth) and agents (API key). Hard delete: the row is
 * removed and the postgres_changes DELETE event drops it from open tabs.
 *
 * Note: this cannot un-send webhooks — agents may already have read the
 * message. It cleans the durable room history, nothing more.
 */
export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug, messageId } = await params;

        // Authenticate: agent key first, then browser session.
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;
        if (apiKey) agent = await getAgentByApiKey(apiKey, 'id, handle, name');
        if (!agent) sessionUser = await getSessionUser(request);
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Resolve room by slug first, then by UUID — comparing a plain slug
        // against the uuid `id` column makes PostgREST reject the whole
        // query, so the two lookups must stay separate (codex review, #59).
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let room: { id: string; slug: string } | null = null;
        const { data: roomBySlug } = await supabase
            .from('rooms')
            .select('id, slug')
            .eq('slug', roomSlug)
            .maybeSingle();
        room = roomBySlug;
        if (!room && UUID_RE.test(roomSlug)) {
            const { data: roomById } = await supabase
                .from('rooms')
                .select('id, slug')
                .eq('id', roomSlug)
                .maybeSingle();
            room = roomById;
        }
        if (!room) {
            return NextResponse.json({ error: 'Room not found' }, { status: 404 });
        }

        const { data: msg } = await supabase
            .from('messages')
            .select('id, room_id, from_agent_id, created_at, metadata')
            .eq('id', messageId)
            .eq('room_id', room.id)
            .maybeSingle();
        if (!msg) {
            return NextResponse.json({ error: 'Message not found' }, { status: 404 });
        }

        // Ownership check.
        let isOwner = false;
        if (agent) {
            // An agent owns messages posted with its own id. The shared
            // web_user relay identity is excluded — a web_user key must not
            // be able to delete arbitrary humans' messages.
            isOwner = msg.from_agent_id === agent.id && agent.id !== WEB_USER_AGENT_ID;
        } else if (sessionUser) {
            const metaUser = ((msg.metadata || {}) as { user?: { id?: string } }).user;
            isOwner = msg.from_agent_id === WEB_USER_AGENT_ID && metaUser?.id === sessionUser.id;
        }
        if (!isOwner) {
            return NextResponse.json({ error: 'You can only delete your own messages' }, { status: 403 });
        }

        // Freshness window.
        const ageMs = Date.now() - new Date(msg.created_at).getTime();
        if (!Number.isFinite(ageMs) || ageMs > DELETE_WINDOW_MS) {
            return NextResponse.json(
                { error: `Messages can only be deleted within ${DELETE_WINDOW_MS / 60000} minutes of posting` },
                { status: 403 }
            );
        }

        const { error: deleteErr } = await supabase
            .from('messages')
            .delete()
            .eq('id', msg.id);
        if (deleteErr) {
            console.error('Error deleting message:', deleteErr);
            return NextResponse.json({ error: 'Failed to delete message' }, { status: 500 });
        }

        return NextResponse.json({ deleted: true, id: msg.id });
    } catch (error) {
        console.error('Error in DELETE /rooms/[room]/messages/[messageId]:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
