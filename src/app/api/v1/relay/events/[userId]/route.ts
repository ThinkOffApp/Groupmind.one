import { NextResponse } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { deriveRelayChannel, expandRelayUserIds } from '@/lib/relay-identifiers';

type RouteParams = { params: Promise<{ userId: string }> };

async function getSessionUserWithHandle() {
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (error || !user) return null;
        const { data: profile } = await serverClient
            .from('user_profiles')
            .select('handle')
            .eq('user_id', user.id)
            .single();
        const handle = profile?.handle?.replace('@', '') || null;
        return { ...user, handle };
    } catch {
        return null;
    }
}

export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { userId } = await params;
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;

        if (apiKey) {
            agent = await getAgentByApiKey(apiKey, 'id, handle, name');
        }
        if (!agent) {
            sessionUser = await getSessionUserWithHandle();
        }
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: apiKey ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
        }

        const supabase = getServiceSupabase();
        const resolvedUserIds = await expandRelayUserIds(supabase, userId);
        const targetUserIds = resolvedUserIds.length > 0 ? resolvedUserIds : [userId];

        // Session users can only read their own events (id/handle/email aliases allowed)
        if (sessionUser && !agent) {
            const requested = new Set(targetUserIds.map(id => id.toLowerCase()));
            const sessionId = sessionUser.id?.toLowerCase();
            const sessionHandle = sessionUser.handle?.toLowerCase();
            const sessionEmail = sessionUser.email?.toLowerCase();
            const canRead =
                (!!sessionId && requested.has(sessionId)) ||
                (!!sessionHandle && (requested.has(sessionHandle) || requested.has(`@${sessionHandle}`))) ||
                (!!sessionEmail && requested.has(sessionEmail));

            if (!canRead) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
        }

        const url = new URL(request.url);
        const since = url.searchParams.get('since');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
        const unread = url.searchParams.get('unread') === 'true';
        const channel = url.searchParams.get('channel');

        let query = supabase
            .from('relay_events')
            .select('*')
            .in('user_id', targetUserIds)
            .gt('expires_at', new Date().toISOString())
            .order('created_at', { ascending: false })
            .limit(limit);

        if (since) {
            query = query.gt('created_at', since);
        }
        if (unread) {
            query = query.is('read_at', null);
        }

        const { data, error } = await query;

        if (error) {
            console.error('Error fetching relay events:', error);
            return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
        }

        const events = (data || []).map(event => ({
            ...event,
            channel: deriveRelayChannel(event.source, event.reply_target),
        }));

        const filteredEvents = channel
            ? events.filter(event => event.channel === channel)
            : events;

        return NextResponse.json({ events: filteredEvents, count: filteredEvents.length });
    } catch (error) {
        console.error('Error in GET /api/v1/relay/events/[userId]:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
