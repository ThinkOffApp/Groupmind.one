import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

// GET /api/v1/messages/projections?service=xfor&unread=true
// Returns message projections for the authenticated agent, filtered by service
export async function GET(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        if (!apiKey) {
            return NextResponse.json({ error: 'Missing Authorization' }, { status: 401 });
        }

        const agent = await getAgentByApiKey(apiKey, 'id, handle, name');
        if (!agent) {
            return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const service = searchParams.get('service');
        const unreadOnly = searchParams.get('unread') === 'true';
        const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);

        let query = supabase
            .from('message_projections')
            .select(`
                id,
                canonical_message_id,
                service,
                delivery_state,
                read_state,
                delivered_at,
                read_at,
                created_at,
                message:messages!message_projections_canonical_message_id_fkey(
                    id, body, created_at, origin_service,
                    from_agent:agents!messages_from_agent_id_fkey(handle, name),
                    to_agent:agents!messages_to_agent_id_fkey(handle, name)
                )
            `)
            .eq('recipient_id', agent.id)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (service) {
            query = query.eq('service', service);
        }

        if (unreadOnly) {
            query = query.eq('read_state', false);
        }

        const { data: projections, error } = await query;

        if (error) {
            console.error('Error fetching projections:', error);
            return NextResponse.json({ error: 'Failed to fetch projections' }, { status: 500 });
        }

        return NextResponse.json({
            projections: projections || [],
            count: projections?.length || 0,
            agent: agent.handle,
        });

    } catch (error) {
        console.error('Error in GET /messages/projections:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// PATCH /api/v1/messages/projections
// Mark projections as read: { projection_ids: ["uuid1", "uuid2"] }
export async function PATCH(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        if (!apiKey) {
            return NextResponse.json({ error: 'Missing Authorization' }, { status: 401 });
        }

        const agent = await getAgentByApiKey(apiKey, 'id, handle');
        if (!agent) {
            return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
        }

        const body = await request.json();
        const { projection_ids } = body;

        if (!Array.isArray(projection_ids) || projection_ids.length === 0) {
            return NextResponse.json({ error: 'projection_ids array required' }, { status: 400 });
        }

        const { error } = await supabase
            .from('message_projections')
            .update({ read_state: true, read_at: new Date().toISOString() })
            .in('id', projection_ids)
            .eq('recipient_id', agent.id);

        if (error) {
            return NextResponse.json({ error: 'Failed to update projections' }, { status: 500 });
        }

        return NextResponse.json({ updated: projection_ids.length });

    } catch (error) {
        console.error('Error in PATCH /messages/projections:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
