// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getIntentState, mergeIntentStates } from '@/lib/intent-store';
import { resolveIntentAlias, supabaseAliasLookup } from '@/lib/intent-alias';

type RouteParams = { params: Promise<{ userId: string }> };

async function getSessionUserWithHandle() {
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (error || !user) return null;

        // Also look up handle for ownership check
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

export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { userId } = await params;
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

        // Enforce ownership: agents can read any state, session users can only read their own (by UUID or handle)
        if (sessionUser && !agent && sessionUser.id !== userId && sessionUser.handle !== userId) {
            return NextResponse.json({ error: 'Forbidden: Cannot read other users intent state' }, { status: 403 });
        }

        // The signed-in web UI asks for the session UUID, but the fleet
        // publishes under the user's handle, so the UUID document looked empty
        // and every agent rendered as "never". Ownership is already proven
        // above — the two ids are the same person — so read both documents and
        // merge them. Publishers were working around this by writing every
        // heartbeat twice; merging here means a new publisher does not have to
        // know the trick, and nothing published under either id is hidden.
        let state = await getIntentState(userId);
        // API-key readers (CodeWatch on a phone, publishers) had no session
        // to learn the other id from, so a phone configured with the UUID saw
        // only its own heartbeat while the fleet published under the handle
        // (a user asked, "Where are all devices?"). Resolve the alias
        // from user_profiles for them; sessions keep the cheaper path.
        const alsoKnownAs = sessionUser && !agent
            ? [sessionUser.handle, sessionUser.id].find((id) => id && id !== userId) ?? null
            : await resolveIntentAlias(userId, supabaseAliasLookup);
        if (alsoKnownAs) {
            state = mergeIntentStates(state, await getIntentState(alsoKnownAs));
        }
        return NextResponse.json(state);
    } catch (error) {
        console.error('Error in GET /api/v1/intent/[userId]:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
