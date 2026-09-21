import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getIntentProfile, putIntentProfile, WEB_USER_AGENT_ID } from '@/lib/intent-store';

type RouteParams = { params: Promise<{ userId: string }> };

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

async function authenticate(request: Request) {
    const apiKey = extractApiKey(request);
    let agent = null;
    let sessionUser: any = null;

    if (apiKey) {
        agent = await getAgentByApiKey(apiKey, 'id, handle, name');
    }
    if (!agent) {
        const user = await getSessionUser();
        if (user) {
            // Look up handle for ownership checks
            const serverClient = await createServerClient();
            const { data: profile } = await (serverClient as any)
                .from('user_profiles')
                .select('handle')
                .eq('user_id', user.id)
                .single();
            sessionUser = { ...user, handle: profile?.handle?.replace('@', '') || null };
        }
    }
    return { agent, sessionUser };
}

export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { userId } = await params;
        const { agent, sessionUser } = await authenticate(request);
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: extractApiKey(request) ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
        }

        if (!agent && sessionUser && sessionUser.id !== userId && sessionUser.handle !== userId) {
            return NextResponse.json({ error: 'Forbidden profile read for this user_id' }, { status: 403 });
        }

        const profile = await getIntentProfile(userId);
        return NextResponse.json(profile);
    } catch (error) {
        console.error('Error in GET /api/v1/profile/[userId]:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const { userId } = await params;
        const { agent, sessionUser } = await authenticate(request);
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: extractApiKey(request) ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
        }

        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid profile payload' }, { status: 400 });
        }

        if (!agent && sessionUser && sessionUser.id !== userId && sessionUser.handle !== userId) {
            return NextResponse.json({ error: 'Forbidden profile write for this user_id' }, { status: 403 });
        }

        const saved = await putIntentProfile(userId, body as Record<string, unknown>, agent?.id || WEB_USER_AGENT_ID);
        return NextResponse.json(saved);
    } catch (error) {
        console.error('Error in PUT /api/v1/profile/[userId]:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
