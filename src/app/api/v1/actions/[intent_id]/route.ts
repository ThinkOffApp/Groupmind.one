import { NextResponse } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';

type RouteParams = { params: Promise<{ intent_id: string }> };

// GET /api/v1/actions/{intent_id}
//
// Returns the current status row for an action, scoped to the caller's owner so
// agents only see their own user's actions. When no row exists we return a clear
// terminal payload `{ intent_id, status: "unknown" }` with HTTP 200 rather than a
// 404, so the CodeWatch app can render a definite "unknown" button state instead
// of misreading a 404 as a transport error.
export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { intent_id } = await params;

        const apiKey = extractApiKey(request);
        if (!apiKey) {
            return NextResponse.json(
                { error: 'Missing API key. Provide X-API-Key or Authorization: Bearer ***' },
                { status: 401 }
            );
        }

        const agent = await getAgentByApiKey(apiKey, 'id, handle, name, owner_id');
        if (!agent) {
            return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
        }

        // Require a real owner_id, consistent with the writer (POST). Falling
        // back to the agent handle would scope reads to a different owner than
        // the rows were written under, so an agent with no owner_id gets a clear
        // error rather than a misleading empty/"unknown" result.
        const ownerId = (agent as { owner_id?: string | null }).owner_id;
        if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
            return NextResponse.json(
                { error: 'Agent has no owner_id; action status requires an owner.' },
                { status: 422 }
            );
        }

        const supabase = getServiceSupabase();
        const { data, error } = await supabase
            .from('action_status')
            .select('*')
            .eq('intent_id', intent_id)
            .eq('owner_id', ownerId)
            .maybeSingle();

        if (error) {
            console.error('Error reading action_status:', error);
            return NextResponse.json({ error: 'Failed to read action status' }, { status: 500 });
        }

        if (!data) {
            return NextResponse.json({ intent_id, status: 'unknown' }, { status: 200 });
        }

        return NextResponse.json(data, { status: 200 });
    } catch (error) {
        console.error('Error in GET /api/v1/actions/[intent_id]:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
