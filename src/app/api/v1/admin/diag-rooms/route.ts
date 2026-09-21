// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';

// TEMPORARY admin diagnostic to verify the rooms-union fix (f07af87) for a
// specific account WITHOUT that user sharing their app key. Returns the union of
// agent + owning-user room memberships for a given email, exactly as
// GET /api/v1/rooms now computes it. Safe to remove once the room-list fix is
// verified.
//
// WHO MAY CALL IT
// The allowlist is configuration, and it is EMPTY BY DEFAULT: with
// ADMIN_AGENT_HANDLES unset this endpoint answers 403 to everybody, including
// the instance operator. That is deliberate. It used to be a hardcoded list of
// this project's own agent handles, which on any other deployment meant the
// first stranger to register one of those handles was handed an endpoint that
// enumerates users by email address. A default that grants nothing cannot be
// inherited by accident.
//
//   ADMIN_AGENT_HANDLES=alice,bob
//
// Comma-separated agent handles, matched case-insensitively. The caller proves
// it holds that agent's API key.
function adminHandles(): Set<string> {
    return new Set(
        (process.env.ADMIN_AGENT_HANDLES || '')
            .split(',')
            .map(h => h.trim().toLowerCase())
            .filter(Boolean)
    );
}

const supabase = getServiceSupabase();

async function findAuthUserIdByEmail(email: string): Promise<string | null> {
    const target = email.toLowerCase();
    let page = 1;
    while (page <= 10) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw error;
        const users = data?.users || [];
        const hit = users.find(u => u.email?.toLowerCase() === target);
        if (hit) return hit.id;
        if (users.length < 200) break;
        page += 1;
    }
    return null;
}

// GET /api/v1/admin/diag-rooms?email=<email>
export async function GET(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        if (!apiKey) return NextResponse.json({ error: 'Missing Authorization' }, { status: 401 });
        const allowed = adminHandles();
        if (allowed.size === 0) {
            // Say which knob turns it on. A bare 403 here sent operators
            // hunting through the source for a list that is no longer there.
            return NextResponse.json({
                error: 'Admin diagnostics are disabled',
                detail: 'Set ADMIN_AGENT_HANDLES to a comma-separated list of agent handles to enable this endpoint.',
            }, { status: 403 });
        }

        const caller = await getAgentByApiKey(apiKey, 'id, handle');
        if (!caller || !allowed.has((caller.handle || '').toLowerCase())) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const email = new URL(request.url).searchParams.get('email');
        if (!email) return NextResponse.json({ error: 'email query param required' }, { status: 400 });

        const userId = await findAuthUserIdByEmail(email);
        if (!userId) return NextResponse.json({ email, found: false, reason: 'no_auth_user' });

        const { data: agent } = await supabase
            .from('agents')
            .select('id, handle')
            .eq('owner_id', userId)
            .maybeSingle();

        // Same union the rooms fix uses: agent memberships + owning-user memberships.
        const agentRooms = agent
            ? await supabase.from('room_members')
                .select('room:rooms(slug)').eq('agent_id', agent.id)
            : { data: [] as unknown[] };
        const userRooms = await supabase.from('room_members')
            .select('room:rooms(slug)').eq('user_id', userId);

        const slugs = new Set<string>();
        for (const m of [...(agentRooms.data || []), ...(userRooms.data || [])]) {
            const slug = (m as { room?: { slug?: string } }).room?.slug;
            if (slug) slugs.add(slug);
        }
        const list = Array.from(slugs);
        return NextResponse.json({
            email,
            found: true,
            user_id: userId,
            agent_id: agent?.id ?? null,
            agent_handle: agent?.handle ?? null,
            rooms: list,
            includes_thinkoff_development: list.includes('thinkoff-development'),
        });
    } catch (error) {
        console.error('diag-rooms error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
