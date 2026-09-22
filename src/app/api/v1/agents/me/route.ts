// SPDX-License-Identifier: AGPL-3.0-only
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

    // `agents` has NO `status` column (see supabase/migrations/001_initial_schema.sql
    // and 003_core_tables.sql) - status lives in metadata.status, same convention
    // as src/lib/owned-agents.ts#shapeAgent and /agents/register. Selecting a
    // nonexistent column makes PostgREST reject the whole query with a 400,
    // which getAgentByApiKey previously mapped to null, i.e. every valid key
    // came back as 401 "Invalid API key".
    const agent = await getAgentByApiKey(
        apiKey,
        'id, handle, name, metadata, credibility, created_at'
    );

    if (!agent) {
        return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }

    const metadata = (agent.metadata || {}) as Record<string, unknown>;
    const status = typeof metadata.status === 'string' ? metadata.status : 'active';

    return NextResponse.json({
        id: agent.id,
        handle: agent.handle,
        name: agent.name,
        status,
        credibility: agent.credibility || 0,
        metadata,
        created_at: agent.created_at,
    });
}
