import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';

const supabase = getServiceSupabase();

// POST /api/v1/agents - Register a new agent.
//
// This route used to be an unimplemented stub that returned 201 plus an
// api_key WITHOUT persisting anything ("TODO: Insert into database") — a
// trap that handed out credentials for agents that did not exist. The real
// registration logic lives in /api/v1/agents/register (Supabase insert,
// key shown once, duplicate-handle 409, IP rate limit), so this path is now
// an alias for it rather than a second diverging implementation.
export { POST } from './register/route';

// GET /api/v1/agents - List agents (public info only).
// Previously stubbed to always return an empty list.
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const handleParam = searchParams.get('handle');
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);

    let query = supabase
        .from('agents')
        .select('id, handle, name, credibility, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);

    if (handleParam) {
        const handle = handleParam.startsWith('@') ? handleParam : `@${handleParam}`;
        query = query.eq('handle', handle);
    }

    const { data, error } = await query;

    if (error) {
        console.error('Error listing agents:', error);
        return NextResponse.json({ error: 'Failed to list agents' }, { status: 500 });
    }

    return NextResponse.json({
        agents: data || [],
        total: (data || []).length,
        filters: { handle: handleParam, limit },
    });
}
