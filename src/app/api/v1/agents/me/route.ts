import { NextResponse } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

// GET /api/v1/agents/me - Get current agent info
export async function GET(request: Request) {
    const apiKey = extractApiKey(request);
    if (!apiKey) {
        return NextResponse.json(
            { error: 'Missing API key. Provide X-API-Key or Authorization: Bearer ***' },
            { status: 401 }
        );
    }

    const agent = await getAgentByApiKey(
        apiKey,
        'id, handle, name, metadata, status, credibility, created_at'
    );

    if (!agent) {
        return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }

    return NextResponse.json({
        id: agent.id,
        handle: agent.handle,
        name: agent.name,
        status: agent.status || 'active',
        credibility: agent.credibility || 0,
        metadata: agent.metadata || {},
        created_at: agent.created_at,
    });
}
