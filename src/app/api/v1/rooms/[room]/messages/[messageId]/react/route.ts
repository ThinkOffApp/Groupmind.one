import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

// Get authenticated user from the Supabase session.
// 1) SSR cookie session (desktop web). 2) Authorization: Bearer <access_token>
// from the client session — some mobile browsers (notably Android Chrome) don't
// reliably round-trip the ~5KB chunked SSR auth cookie to the server, so cookie-only
// auth 401'd. The bearer token is validated with the service client and is
// cookie-independent. (A Supabase user JWT is not an xfb_ agent key, so the
// agent-key path doesn't match it and we fall through to here.)
async function getSessionUser(request?: Request) {
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (!error && user) return user;
    } catch {
        // fall through to bearer-token auth
    }
    try {
        const authz = request?.headers.get('authorization') || '';
        const token = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, '').trim() : '';
        if (token && !token.startsWith('xfb_')) {
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (!error && user) return user;
        }
    } catch {
        // ignore
    }
    return null;
}

type RouteParams = { params: Promise<{ room: string; messageId: string }> };

// POST /api/v1/rooms/{room}/messages/{messageId}/react
// Body: { emoji: "👍" } to add, { emoji: "👍", remove: true } to remove
export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug, messageId } = await params;

        // Authenticate
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;
        if (apiKey) agent = await getAgentByApiKey(apiKey, 'id, handle, name');
        if (!agent) sessionUser = await getSessionUser(request);
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { emoji, remove } = body;

        if (!emoji || typeof emoji !== 'string') {
            return NextResponse.json({ error: 'Missing emoji field' }, { status: 400 });
        }

        // Get sender handle
        let senderHandle = agent?.handle || 'unknown';
        if (sessionUser) {
            const { data: xfbProfile } = await supabase
                .from('xfb_user_profiles')
                .select('handle, display_name')
                .eq('user_id', sessionUser.id)
                .single();
            senderHandle = xfbProfile?.handle || xfbProfile?.display_name || sessionUser.email?.split('@')[0] || 'Human';
        }

        // Fetch current message metadata
        const { data: msg, error: fetchErr } = await supabase
            .from('messages')
            .select('metadata')
            .eq('id', messageId)
            .single();

        if (fetchErr || !msg) {
            return NextResponse.json({ error: 'Message not found' }, { status: 404 });
        }

        const metadata = (msg.metadata || {}) as Record<string, unknown>;
        const reactions = (metadata.reactions || {}) as Record<string, string[]>;

        if (remove) {
            // Remove reaction
            if (reactions[emoji]) {
                reactions[emoji] = reactions[emoji].filter(h => h !== senderHandle);
                if (reactions[emoji].length === 0) delete reactions[emoji];
            }
        } else {
            // Add reaction (prevent duplicates)
            if (!reactions[emoji]) reactions[emoji] = [];
            if (!reactions[emoji].includes(senderHandle)) {
                reactions[emoji].push(senderHandle);
            }
        }

        metadata.reactions = reactions;

        const { error: updateErr } = await supabase
            .from('messages')
            .update({ metadata })
            .eq('id', messageId);

        if (updateErr) {
            console.error('Error updating reactions:', updateErr);
            return NextResponse.json({ error: 'Failed to update reactions' }, { status: 500 });
        }

        return NextResponse.json({ reactions });
    } catch (error) {
        console.error('Error in POST /react:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
