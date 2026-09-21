import { NextResponse } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';
import { createClient as createServerClient } from '@/lib/supabase-server';

type RouteParams = { params: Promise<{ eventId: string }> };

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

export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { eventId } = await params;
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

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object' || !(body as Record<string, unknown>).reply_text) {
            return NextResponse.json({ error: 'reply_text is required' }, { status: 400 });
        }

        const supabase = getServiceSupabase();

        // Fetch the event first to verify ownership
        const { data: event, error: fetchError } = await supabase
            .from('relay_events')
            .select('user_id')
            .eq('id', eventId)
            .single();

        if (fetchError || !event) {
            return NextResponse.json({ error: 'Event not found' }, { status: 404 });
        }

        // Only the target user can reply to their own events
        if (sessionUser && !agent) {
            if (sessionUser.id !== event.user_id && sessionUser.handle !== event.user_id) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
        }

        const { data, error } = await supabase
            .from('relay_events')
            .update({
                reply_text: (body as Record<string, unknown>).reply_text,
                replied_at: new Date().toISOString(),
            })
            .eq('id', eventId)
            .select()
            .single();

        if (error) {
            console.error('Error replying to event:', error);
            return NextResponse.json({ error: 'Failed to reply' }, { status: 500 });
        }

        return NextResponse.json(data);
    } catch (error) {
        console.error('Error in POST /api/v1/relay/replies/[eventId]:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
