import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { deleteIntentSlot, upsertIntentSlot, WEB_USER_AGENT_ID } from '@/lib/intent-store';

type RouteParams = { params: Promise<{ userId: string; deviceId: string }> };

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
    let sessionUser = null;
    if (apiKey) {
        agent = await getAgentByApiKey(apiKey, 'id, handle, name');
    }
    if (!agent) {
        sessionUser = await getSessionUser();
    }
    return { agent, sessionUser };
}

function canWriteUser(userId: string, agent: any, sessionUser: { id: string } | null) {
    // Authenticated agents can publish device state (e.g. ClawWatch reporting watch state)
    if (agent) return true;
    return !!sessionUser && sessionUser.id === userId;
}

async function writeSlot(request: Request, params: { userId: string; deviceId: string }, replace: boolean) {
    const { agent, sessionUser } = await authenticate(request);
    if (!agent && !sessionUser) {
        return NextResponse.json({ error: extractApiKey(request) ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
    }
    if (!canWriteUser(params.userId, agent, sessionUser)) {
        return NextResponse.json({ error: 'Forbidden intent write for this user_id' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    if (body && typeof body !== 'object') {
        return NextResponse.json({ error: 'Invalid intent payload' }, { status: 400 });
    }

    const result = await upsertIntentSlot({
        userId: params.userId,
        slotType: 'device',
        slotId: params.deviceId,
        payload: (body || {}) as Record<string, unknown>,
        replace,
        actorAgentId: agent?.id || WEB_USER_AGENT_ID,
    });
    return NextResponse.json(result);
}

export async function PATCH(request: Request, { params }: RouteParams) {
    try {
        const resolved = await params;
        return await writeSlot(request, resolved, false);
    } catch (error) {
        console.error('Error in PATCH /api/v1/intent/[userId]/[deviceId]:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function PUT(request: Request, { params }: RouteParams) {
    try {
        const resolved = await params;
        return await writeSlot(request, resolved, true);
    } catch (error) {
        console.error('Error in PUT /api/v1/intent/[userId]/[deviceId]:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const resolved = await params;
        const { agent, sessionUser } = await authenticate(request);
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: extractApiKey(request) ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
        }
        if (!canWriteUser(resolved.userId, agent, sessionUser)) {
            return NextResponse.json({ error: 'Forbidden intent delete for this user_id' }, { status: 403 });
        }

        const result = await deleteIntentSlot(resolved.userId, 'device', resolved.deviceId);
        return NextResponse.json(result);
    } catch (error) {
        console.error('Error in DELETE /api/v1/intent/[userId]/[deviceId]:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
