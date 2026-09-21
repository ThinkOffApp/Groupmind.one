import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

// Get authenticated user from the Supabase session.
// 1) SSR cookie session (desktop web). 2) Authorization: Bearer <access_token>
// from the client session — needed because some mobile browsers (e.g. Android
// Chrome) don't have the SSR cookie even when signed in client-side, which left
// the room list empty. The bearer token is validated with the service client.
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
        if (token) {
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (!error && user) return user;
        }
    } catch {
        // ignore
    }
    return null;
}

// Generate invite code
function generateInviteCode(): string {
    return crypto.randomBytes(8).toString('hex');
}

// POST /api/v1/rooms - Create a room
export async function POST(request: Request) {
    try {
        // Try API key auth first (for agents)
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;

        if (apiKey) {
            agent = await getAgentByApiKey(apiKey, 'id, handle, name, owner_id');
        }

        // If no API key or invalid, try session auth (for web UI users)
        if (!agent) {
            sessionUser = await getSessionUser(request);
        }

        // Require at least one auth method
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: apiKey ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
        }

        const body = await request.json();
        const { name, members, is_public } = body;

        if (!name || name.trim() === '') {
            return NextResponse.json({ error: 'Room name required' }, { status: 400 });
        }

        // Private room creation requires premium
        const wantsPrivate = is_public === false;
        if (wantsPrivate) {
            let isPremium = false;

            if (sessionUser) {
                // Check xfb_user_profiles for premium status.
                // NOTE: xfb_user_profiles is keyed on `user_id` (the auth user
                // id), NOT `id`. Querying `.eq('id', ...)` matches no column and
                // returns no row, so isPremium silently stayed false and EVERY
                // session user got a 403 ("Private rooms are a Premium feature")
                // even when actually premium. Use user_id.
                const { data: profile } = await supabase
                    .from('xfb_user_profiles')
                    .select('is_premium')
                    .eq('user_id', sessionUser.id)
                    .single();
                isPremium = profile?.is_premium === true;
            } else if (agent) {
                // Check agents table for premium status
                const { data: agentData } = await supabase
                    .from('agents')
                    .select('is_premium')
                    .eq('id', agent.id)
                    .single();
                isPremium = agentData?.is_premium === true;
            }

            // Private rooms are no longer premium-only: every account gets one.
            // Premium raises the allowance. There is no tier column in the schema
            // (only is_premium), so Family cannot be told apart from Premium here
            // and both get PREMIUM_PRIVATE_ROOMS until a tier field exists.
            const FREE_PRIVATE_ROOMS = 1;
            const PREMIUM_PRIVATE_ROOMS = 5;
            const allowance = isPremium ? PREMIUM_PRIVATE_ROOMS : FREE_PRIVATE_ROOMS;

            // Limit: allowance private rooms per user
            const creatorId = sessionUser?.id || agent?.id;
            const creatorField = sessionUser ? 'user_id' : 'agent_id';

            // Count private rooms this user has created (they are a member of + room is private).
            // Auto-created personal rooms (kind='personal') don't consume the allowance.
            const { data: existingPrivate } = await supabase
                .from('room_members')
                .select('room:rooms!inner(id, is_public, kind)')
                .eq(creatorField, creatorId)
                .eq('rooms.is_public', false)
                .eq('rooms.kind', 'standard');

            const privateCount = (existingPrivate || []).length;
            if (privateCount >= allowance) {
                return NextResponse.json(
                    {
                        error: isPremium
                            ? `Premium includes ${allowance} private rooms. You already have ${privateCount}.`
                            : `Your free plan includes ${allowance} private room. Upgrade for more.`,
                    },
                    { status: 403 }
                );
            }
        }

        // Normalize room name (slug format)
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        // Check if room already exists
        const { data: existing } = await supabase
            .from('rooms')
            .select('id')
            .eq('slug', slug)
            .single();

        if (existing) {
            return NextResponse.json({ error: `Room already exists: ${slug}` }, { status: 409 });
        }

        // Generate invite code for private rooms
        const inviteCode = is_public ? null : generateInviteCode();

        // Create room
        const { data: room, error } = await supabase
            .from('rooms')
            .insert({
                name: name.trim(),
                slug,
                is_public: is_public !== false, // default to public
                invite_code: inviteCode,
                created_by: agent?.id || null,
            })
            .select('id, name, slug, is_public, invite_code')
            .single();

        if (error) {
            console.error('Error creating room:', error);
            console.error('create room failed:', error);
            return NextResponse.json({ error: 'Failed to create room' }, { status: 500 });
        }

        // Add creator as first member (either agent or user)
        const memberData: { room_id: string; agent_id?: string; user_id?: string } = {
            room_id: room.id,
        };

        if (agent) {
            memberData.agent_id = agent.id;
        }
        if (sessionUser) {
            memberData.user_id = sessionUser.id;
        }

        await supabase.from('room_members').insert(memberData);

        // Add initial members if provided (only works for agent handles)
        if (members && Array.isArray(members)) {
            const memberHandles = members.map((m: string) => m.startsWith('@') ? m : `@${m}`);
            const { data: memberAgents } = await supabase
                .from('agents')
                .select('id, handle')
                .in('handle', memberHandles);

            if (memberAgents && memberAgents.length > 0) {
                const memberInserts = memberAgents
                    .filter(m => m.id !== agent?.id) // don't re-add creator
                    .map(m => ({
                        room_id: room.id,
                        agent_id: m.id,
                    }));

                if (memberInserts.length > 0) {
                    await supabase.from('room_members').insert(memberInserts);
                }
            }
        }

        return NextResponse.json({
            room_id: room.id,
            name: room.name,
            slug: room.slug,
            is_public: room.is_public,
            invite_code: room.invite_code, // only returned to creator
            created_by: agent?.handle || sessionUser?.email || 'unknown',
        }, { status: 201 });

    } catch (error) {
        console.error('Error in POST /rooms:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// GET /api/v1/rooms - List rooms the user/agent is a member of
export async function GET(request: Request) {
    try {
        // Try API key auth first (for agents)
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;

        if (apiKey) {
            agent = await getAgentByApiKey(apiKey, 'id, handle, name, owner_id');
        }

        // If no API key or invalid, try session auth (for web UI users)
        if (!agent) {
            sessionUser = await getSessionUser(request);
        }

        // Require at least one auth method
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: apiKey ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
        }

        // Get all rooms the user/agent is a member of
        let rooms: any[] = [];

        if (agent) {
            // Apps authenticate as an AGENT, but a user's own room memberships
            // (e.g. thinkoff-development joined via the web) are recorded against
            // their user_id, not the auto-created relay agent. Return the UNION of
            // the agent's memberships AND the owning user's memberships, so the app
            // shows every room the account actually belongs to. Still scoped to
            // this one account (its agent + its owner), so no cross-account leak.
            const ownerId = (agent as { owner_id?: string | null }).owner_id || null;

            const agentMemberships = await supabase
                .from('room_members')
                .select(`room:rooms(id, name, slug, is_public, created_at)`)
                .eq('agent_id', agent.id);

            const ownerMemberships = ownerId
                ? await supabase
                    .from('room_members')
                    .select(`room:rooms(id, name, slug, is_public, created_at)`)
                    .eq('user_id', ownerId)
                : { data: [] as unknown[] };

            const byId = new Map<string, any>();
            for (const m of [...(agentMemberships.data || []), ...(ownerMemberships.data || [])]) {
                const room = (m as { room?: { id?: string } }).room;
                if (room && room.id) byId.set(room.id, room);
            }
            rooms = Array.from(byId.values());
        } else if (sessionUser) {
            const { data: memberships } = await supabase
                .from('room_members')
                .select(`
                    room:rooms(id, name, slug, is_public, created_at)
                `)
                .eq('user_id', sessionUser.id);

            rooms = (memberships || [])
                .map(m => m.room)
                .filter(Boolean);
        }

        // Private rooms first, then newest created. The web My-Rooms list
        // re-sorts by unread/activity client-side but also pins private first,
        // so this gives a stable private-before-public base ordering.
        rooms.sort((a, b) => {
            const aPriv = a?.is_public === false ? 0 : 1;
            const bPriv = b?.is_public === false ? 0 : 1;
            if (aPriv !== bPriv) return aPriv - bPriv;
            return new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime();
        });

        return NextResponse.json({
            rooms,
            count: rooms.length,
        });

    } catch (error) {
        console.error('Error in GET /rooms:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
