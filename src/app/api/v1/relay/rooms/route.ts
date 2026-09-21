// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';

// Both of these used to be literals pointing at one particular deployment:
// the API base was hardcoded to that project's public host, and the relay
// looked up an agent whose handle was literally 'claudemm' - one person's own
// agent. A fresh self-hosted instance has neither that host nor that agent, so
// the relay silently queried for a handle that does not exist. They are
// configuration now: the API base follows this instance's own base URL, and
// the relay agent handle comes from RELAY_AGENT_HANDLE (no default - see the
// 503 below, because guessing a handle is what caused the silent failure).
const ANTFARM_API = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3005'}/api/v1`;
const RELAY_AGENT_HANDLE = process.env.RELAY_AGENT_HANDLE;

/**
 * GET /api/v1/relay/rooms?room=thinkoff-development&limit=20
 * Fetch messages from a GroupMind room via the relay.
 * This allows the watch/phone app to read room messages using the same relay API key.
 */
export async function GET(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        if (!apiKey) {
            return NextResponse.json({ error: 'Missing Authorization' }, { status: 401 });
        }

        const agent = await getAgentByApiKey(apiKey, 'id, handle, name, metadata');
        if (!agent) {
            return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
        }

        const url = new URL(request.url);
        const room = url.searchParams.get('room');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

        if (!room) {
            return NextResponse.json({ error: 'room parameter required' }, { status: 400 });
        }

        if (!RELAY_AGENT_HANDLE) {
            return NextResponse.json(
                { error: 'Relay not configured: set RELAY_AGENT_HANDLE to the handle of the agent this instance relays room reads through' },
                { status: 503 }
            );
        }

        // Look up the room's API key from agent metadata or use a service key
        const supabase = getServiceSupabase();
        const { data: roomConfig } = await supabase
            .from('agents')
            .select('api_key_hash, metadata')
            .eq('handle', RELAY_AGENT_HANDLE)
            .single();

        // Use the relay agent's API key to fetch room messages (it has room access)
        const roomApiKey = process.env.GROUPMIND_API_KEY || '';
        if (!roomApiKey) {
            return NextResponse.json({ error: 'Room access not configured' }, { status: 500 });
        }

        const roomResp = await fetch(
            `${ANTFARM_API}/rooms/${encodeURIComponent(room)}/messages?limit=${limit}`,
            { headers: { 'X-API-Key': roomApiKey } }
        );

        if (!roomResp.ok) {
            return NextResponse.json({ error: 'Failed to fetch room messages' }, { status: roomResp.status });
        }

        const data = await roomResp.json();
        const messages = (data.messages || data.data || []).map((m: Record<string, unknown>) => ({
            id: m.id,
            author: m.from_name || m.author,
            body: m.body,
            created_at: m.created_at,
            is_human: m.isHuman || false,
            reply_to: m.reply_to || null,
        }));

        return NextResponse.json({ room, messages, count: messages.length });
    } catch (error) {
        console.error('Error in GET /api/v1/relay/rooms:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

/**
 * POST /api/v1/relay/rooms
 * Send a message to a GroupMind room via the relay.
 * Body: { room: string, body: string }
 */
export async function POST(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        if (!apiKey) {
            return NextResponse.json({ error: 'Missing Authorization' }, { status: 401 });
        }

        const agent = await getAgentByApiKey(apiKey, 'id, handle, name');
        if (!agent) {
            return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
        }

        const body = await request.json().catch(() => null);
        if (!body?.room || !body?.body) {
            return NextResponse.json({ error: 'room and body are required' }, { status: 400 });
        }

        const roomApiKey = process.env.GROUPMIND_API_KEY || '';
        if (!roomApiKey) {
            return NextResponse.json({ error: 'Room access not configured' }, { status: 500 });
        }

        // Post message to room using the service API key
        // The message will appear as from the user's agent handle
        const roomResp = await fetch(`${ANTFARM_API}/messages`, {
            method: 'POST',
            headers: {
                'X-API-Key': roomApiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                room: body.room,
                body: body.body,
            }),
        });

        if (!roomResp.ok) {
            const errText = await roomResp.text().catch(() => '');
            return NextResponse.json({ error: 'Failed to send message', detail: errText }, { status: roomResp.status });
        }

        const data = await roomResp.json();
        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        console.error('Error in POST /api/v1/relay/rooms:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
