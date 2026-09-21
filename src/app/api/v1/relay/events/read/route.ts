// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';
import { createClient as createServerClient } from '@/lib/supabase-server';

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

/**
 * POST /api/v1/relay/events/read
 * Mark one or more events as read.
 * Body: { event_ids: string[] }
 */
export async function POST(request: Request) {
    try {
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
        if (!body || !Array.isArray((body as Record<string, unknown>).event_ids)) {
            return NextResponse.json({ error: 'event_ids array is required' }, { status: 400 });
        }

        const { event_ids } = body as { event_ids: string[] };
        if (event_ids.length === 0) {
            return NextResponse.json({ updated: 0 });
        }

        const supabase = getServiceSupabase();
        const { data, error } = await supabase
            .from('relay_events')
            .update({ read_at: new Date().toISOString() })
            .in('id', event_ids)
            .is('read_at', null)
            .select('id');

        if (error) {
            console.error('Error marking events as read:', error);
            return NextResponse.json({ error: 'Failed to mark as read' }, { status: 500 });
        }

        return NextResponse.json({ updated: data?.length || 0 });
    } catch (error) {
        console.error('Error in POST /api/v1/relay/events/read:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
