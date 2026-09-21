import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getServiceSupabase } from '@/lib/supabase-service';
import { joinDefaultRooms } from '@/lib/default-rooms';
import { verifyAppleIdToken, parseAudiences, hashNonce, nonceMatches, NONCE_MIN, NONCE_MAX } from '@/lib/apple-id-token';

/**
 * Every signed-in user gets one auto-created private room ("personal room")
 * containing them and all agents they own. Idempotent: safe to call on every
 * auth, so users who registered before this feature get theirs on next
 * sign-in, and newly created agents are pulled in as members over time.
 */
async function ensurePersonalRoom(
    supabase: ReturnType<typeof getServiceSupabase>,
    userId: string,
    handle: string,
    displayName: string,
    currentAgentId: string | null = null,
): Promise<string | null> {
    try {
        // Ownership, not slug, identifies the personal room: a slug lookup
        // would let anyone squat <handle>-home before the user registers and
        // have the user + their agents injected into the attacker's room.
        let { data: room } = await supabase
            .from('rooms')
            .select('id, slug')
            .eq('kind', 'personal')
            .eq('owner_user_id', userId)
            .maybeSingle();

        if (!room) {
            // Preferred slug, then a uid-suffixed fallback if a foreign room
            // (squatted or same email prefix on another domain) holds it.
            const shortUid = userId.replace(/-/g, '').slice(0, 8);
            for (const slug of [`${handle}-home`, `${handle}-home-${shortUid}`]) {
                const { data: created, error: roomError } = await supabase
                    .from('rooms')
                    .insert({
                        name: `${displayName}'s space`,
                        slug,
                        is_public: false,
                        kind: 'personal',
                        owner_user_id: userId,
                        invite_code: crypto.randomBytes(8).toString('hex'),
                        created_by: null,
                    })
                    .select('id, slug')
                    .single();
                if (created) {
                    room = created;
                    break;
                }
                // Two failure modes land here: the slug is taken (try the
                // suffixed one next) or a concurrent first sign-in just
                // created the personal room (unique owner index) — re-select
                // by ownership and adopt it.
                const { data: concurrent } = await supabase
                    .from('rooms')
                    .select('id, slug')
                    .eq('kind', 'personal')
                    .eq('owner_user_id', userId)
                    .maybeSingle();
                if (concurrent) {
                    room = concurrent;
                    break;
                }
                console.warn('Personal room slug unavailable, retrying:', slug, roomError?.message);
            }
            if (!room) {
                console.error('Failed to create personal room for user:', userId);
                return null;
            }
        }

        // Desired members: the user + every agent they own + (defensively) the
        // agent that just authenticated. Including currentAgentId explicitly
        // self-heals accounts whose agent has a stale/missing owner_id, which
        // would otherwise 403 on their own personal room.
        const { data: ownedAgents } = await supabase
            .from('agents')
            .select('id')
            .eq('owner_id', userId);

        const { data: existingMembers } = await supabase
            .from('room_members')
            .select('agent_id, user_id')
            .eq('room_id', room.id);

        const memberAgentIds = new Set((existingMembers || []).map(m => m.agent_id).filter(Boolean));
        const hasUserMember = (existingMembers || []).some(m => m.user_id === userId);

        const wantAgentIds = new Set<string>();
        for (const a of ownedAgents || []) wantAgentIds.add(a.id as string);
        if (currentAgentId) wantAgentIds.add(currentAgentId);

        const inserts: { room_id: string; agent_id?: string; user_id?: string }[] = [];
        if (!hasUserMember) {
            inserts.push({ room_id: room.id, user_id: userId });
        }
        for (const id of wantAgentIds) {
            if (!memberAgentIds.has(id)) {
                inserts.push({ room_id: room.id, agent_id: id });
            }
        }
        // Insert per-row so one duplicate/race never aborts the whole batch —
        // every sign-in then reliably repairs any missing membership.
        for (const row of inserts) {
            const { error: memberError } = await supabase.from('room_members').insert(row);
            if (memberError && !/(duplicate|unique|conflict)/i.test(memberError.message || '')) {
                console.error('Failed to add personal room member:', memberError);
            }
        }

        return room.slug;
    } catch (error) {
        console.error('ensurePersonalRoom failed:', error);
        return null;
    }
}

async function findAuthUserByEmailExact(supabase: ReturnType<typeof getServiceSupabase>, email: string) {
    const target = email.toLowerCase();
    let page = 1;
    const perPage = 200;

    while (page <= 10) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
        if (error) {
            throw error;
        }

        const users = data?.users || [];
        const exact = users.find(user => user.email?.toLowerCase() === target) || null;
        if (exact) {
            return exact;
        }

        if (users.length < perPage) {
            break;
        }
        page += 1;
    }

    return null;
}

// ---- Sign in with Apple state (supabase/migrations/20260903_apple_sign_in.sql) ----
// Atomicity comes from primary keys, never from check-then-write: a
// replayed token collides in apple_sign_in_nonces, concurrent first
// sign-ins collide in apple_identities. Missing tables (migration not yet
// applied) surface as 42P01 and the route fails closed. Service role only.

type Sb = ReturnType<typeof getServiceSupabase>;
const APPLE_UNCONFIGURED = 'Sign in with Apple is not enabled on this server yet (apply supabase/migrations/20260903_apple_sign_in.sql)';

/** INSERT the nonce; the primary key decides. */
async function consumeAppleNonce(supabase: Sb, nonceHash: string, tokenExp: number): Promise<'ok' | 'replay' | 'unconfigured' | 'error'> {
    const { error } = await supabase
        .from('apple_sign_in_nonces')
        .insert({ nonce_hash: nonceHash, expires_at: new Date(tokenExp * 1000).toISOString() });
    if (!error) {
        // Opportunistic prune of dead rows; a replay of an expired token is
        // already refused by the verifier's exp check.
        supabase.from('apple_sign_in_nonces').delete().lt('expires_at', new Date().toISOString())
            .then(() => undefined, () => undefined);
        return 'ok';
    }
    if (error.code === '23505') return 'replay';
    if (error.code === '42P01') return 'unconfigured';
    console.error('apple nonce insert failed:', error);
    return 'error';
}

async function findUserIdByAppleSub(supabase: Sb, sub: string): Promise<{ userId: string | null } | 'error'> {
    const { data, error } = await supabase.from('apple_identities').select('user_id').eq('apple_sub', sub).maybeSingle();
    if (error) {
        console.error('apple identity lookup failed:', error);
        return 'error';
    }
    return { userId: (data?.user_id as string | undefined) ?? null };
}

/** Link sub -> user. On a concurrent link the primary key wins for whoever
 * inserted first; the caller adopts that owner. */
async function linkAppleSub(supabase: Sb, sub: string, userId: string): Promise<{ ownerId: string } | 'error'> {
    const { error } = await supabase.from('apple_identities').insert({ apple_sub: sub, user_id: userId });
    if (!error) return { ownerId: userId };
    if (error.code === '23505') {
        const existing = await findUserIdByAppleSub(supabase, sub);
        if (existing !== 'error' && existing.userId) return { ownerId: existing.userId };
    }
    console.error('apple identity link failed:', error);
    return 'error';
}

async function getAuthUserById(supabase: Sb, userId: string) {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) {
        console.error('linked Apple user missing:', userId, error);
        return null;
    }
    return data.user;
}

/**
 * Mint (or reuse) a PER-DEVICE scoped key for an agent, stored in agent_keys.
 *
 * This is the fix for the multi-device "ping-pong": historically every device
 * (phone, Mac helper, watch) signed in with force_new_key=true and rotated the
 * single shared agents.api_key_hash, which logged every OTHER device out. A
 * per-device key is ADDITIVE - it lives in agent_keys (which getAgentByApiKey
 * checks first) and never touches the shared key, so devices stop knocking each
 * other offline. Scope is ['*'] (full access, same as the legacy shared key).
 *
 * Idempotent per device (keyed by label = codewatch-device:<deviceId>):
 *   - no key yet / expired / forceNew  -> revoke any old one, mint + RETURN raw key
 *   - valid key already exists          -> return null (device uses its stored key)
 * Returns { apiKey } (apiKey may be null) or { error: true } on a DB failure.
 */
async function ensureDeviceKey(
    supabase: ReturnType<typeof getServiceSupabase>,
    agentId: string,
    deviceId: string,
    deviceName: string,
    forceNew: boolean,
): Promise<{ apiKey: string | null; error?: boolean }> {
    const label = `codewatch-device:${deviceId}`.slice(0, 200);
    const { data: rows, error: selErr } = await supabase
        .from('agent_keys')
        .select('id, expires_at, revoked_at')
        .eq('agent_id', agentId)
        .eq('label', label)
        .is('revoked_at', null)
        .order('created_at', { ascending: false })
        .limit(1);
    if (selErr) {
        console.error('device key lookup failed:', selErr);
        return { apiKey: null, error: true };
    }
    const existing = rows?.[0];
    const expired = existing?.expires_at ? new Date(existing.expires_at) < new Date() : false;

    if (existing && !expired && !forceNew) {
        return { apiKey: null }; // device already has a valid key; use the stored one
    }

    if (existing) {
        // (Re)mint: soft-revoke this device's prior key(s). Other devices' keys
        // are untouched.
        await supabase
            .from('agent_keys')
            .update({ revoked_at: new Date().toISOString() })
            .eq('agent_id', agentId)
            .eq('label', label)
            .is('revoked_at', null);
    }

    const rawKey = 'xfb_' + crypto.randomBytes(32).toString('hex');
    const apiKeyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const { error: insErr } = await supabase.from('agent_keys').insert({
        agent_id: agentId,
        api_key_hash: apiKeyHash,
        label,
        scopes: ['*'],
        created_by: deviceName ? `codewatch:${deviceName}` : 'codewatch',
    });
    if (insErr) {
        console.error('device key mint failed:', insErr);
        return { apiKey: null, error: true };
    }
    return { apiKey: rawKey };
}

/**
 * POST /api/v1/relay/auth
 * Exchange a Google ID token, or an Apple identity token (`apple_id_token`,
 * antfarm#125), for a relay session. Returns the user's handle (used as
 * user_id for relay events) and a temporary API key if available. Both
 * providers land in the same provisioning path below; the response shape is
 * identical.
 */
export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => null) as Record<string, unknown> | null;
        // Accept multiple field names for the Google token
        const google_id_token = body?.google_id_token || body?.id_token || body?.token;
        const apple_id_token = typeof body?.apple_id_token === 'string' ? body.apple_id_token : null;
        if (!body || (!google_id_token && !apple_id_token)) {
            return NextResponse.json({ error: 'google_id_token or apple_id_token is required (google also accepts id_token or token)' }, { status: 400 });
        }
        if (google_id_token && apple_id_token) {
            return NextResponse.json({ error: 'Send either google_id_token or apple_id_token, not both' }, { status: 400 });
        }

        const supabase = getServiceSupabase();

        // What the provisioning path needs from either provider.
        let email: string;
        let displayName: string | null = null;
        let providerMeta: Record<string, unknown>;
        // Set when a brand-new user must be linked to this Apple sub right
        // after creation (see the provisioning block).
        let pendingAppleSub: string | null = null;
        let authUser: Awaited<ReturnType<typeof findAuthUserByEmailExact>> = null;

        if (apple_id_token) {
            // Apple: RS256 JWT verified against Apple's JWKS; `sub` is the
            // stable id, `email` only arrives on the first sign-in.
            const verified = await verifyAppleIdToken(apple_id_token, parseAudiences(process.env.APPLE_SIGN_IN_AUDIENCES));
            if (!verified.ok) {
                console.error('Apple token verification failed:', verified.error);
                return NextResponse.json({ error: 'Invalid Apple token', detail: verified.error }, { status: 401 });
            }
            const { sub, email: appleEmail, exp: tokenExp } = verified.identity;

            // Nonce binding (codexmb review of #126): the client generates a
            // random nonce, hands Apple its SHA-256, and sends the raw value
            // here. The token's nonce claim must match, and each nonce is
            // consumed on the account, so a captured token cannot be
            // exchanged a second time. Required: a token without a nonce is
            // refused rather than trusted.
            const rawNonce = typeof body?.apple_nonce === 'string' ? body.apple_nonce.trim() : '';
            if (rawNonce.length < NONCE_MIN || rawNonce.length > NONCE_MAX) {
                return NextResponse.json({ error: 'apple_nonce is required with apple_id_token (the raw nonce whose SHA-256 was passed to Apple)' }, { status: 400 });
            }
            if (!nonceMatches(rawNonce, verified.identity.nonce)) {
                console.error('Apple token nonce mismatch');
                return NextResponse.json({ error: 'Invalid Apple token', detail: 'nonce mismatch' }, { status: 401 });
            }
            const nonceHash = hashNonce(rawNonce);

            // Consume first, atomically: a token is good for exactly one
            // exchange, whatever else happens below.
            const consumed = await consumeAppleNonce(supabase, nonceHash, tokenExp);
            if (consumed === 'unconfigured') {
                return NextResponse.json({ error: APPLE_UNCONFIGURED }, { status: 503 });
            }
            if (consumed === 'replay') {
                console.error('Apple token replay refused');
                return NextResponse.json({ error: 'Invalid Apple token', detail: 'already used' }, { status: 401 });
            }
            if (consumed === 'error') {
                return NextResponse.json({ error: 'Failed to record Apple sign-in' }, { status: 500 });
            }

            const linked = await findUserIdByAppleSub(supabase, sub);
            if (linked === 'error') {
                return NextResponse.json({ error: 'Failed to resolve Apple account' }, { status: 500 });
            }
            if (linked.userId) {
                authUser = await getAuthUserById(supabase, linked.userId);
                if (!authUser) {
                    return NextResponse.json({ error: 'Linked account is missing' }, { status: 500 });
                }
            }
            if (!authUser && appleEmail) {
                // First Apple sign-in for someone who may already exist via
                // Google with the same address: adopt that account and link
                // the sub so later email-less tokens resolve. A concurrent
                // first sign-in that linked first wins; adopt its owner.
                authUser = await findAuthUserByEmailExact(supabase, appleEmail);
                if (authUser) {
                    const link = await linkAppleSub(supabase, sub, authUser.id);
                    if (link === 'error') {
                        return NextResponse.json({ error: 'Failed to link Apple account' }, { status: 500 });
                    }
                    if (link.ownerId !== authUser.id) {
                        authUser = await getAuthUserById(supabase, link.ownerId);
                        if (!authUser) {
                            return NextResponse.json({ error: 'Linked account is missing' }, { status: 500 });
                        }
                    }
                }
            }
            if (!authUser && !appleEmail) {
                // Apple withholds the email after the first authorization;
                // the client must ask the user to revoke and re-authorize
                // (Settings → Apple ID → Sign in with Apple) to get it back.
                return NextResponse.json({ error: 'Apple token has no email and no account is linked to this Apple ID; re-authorize to share the email' }, { status: 401 });
            }
            email = authUser?.email || (appleEmail as string);
            // Apple never puts a name in the token; the client may pass what
            // the user chose at authorization time.
            displayName = typeof body?.display_name === 'string' && body.display_name.trim()
                ? body.display_name.trim().slice(0, 120)
                : null;
            providerMeta = { provider: 'apple', provisioned_by: 'relay-auth' };
            if (!authUser) pendingAppleSub = sub;
        } else {
            // Verify Google ID token
            const googleResp = await fetch(
                `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(String(google_id_token))}`
            );

            if (!googleResp.ok) {
                const errorBody = await googleResp.text().catch(() => 'no body');
                console.error('Google token verification failed:', googleResp.status, errorBody);
                return NextResponse.json({ error: 'Invalid Google token', detail: errorBody }, { status: 401 });
            }

            const tokenInfo = await googleResp.json();
            if (!tokenInfo.email) {
                return NextResponse.json({ error: 'No email in token' }, { status: 401 });
            }
            email = tokenInfo.email;
            displayName = typeof tokenInfo.name === 'string' && tokenInfo.name ? tokenInfo.name : null;
            providerMeta = { provider: 'google', provisioned_by: 'relay-auth' };

            // Supabase admin filter is fuzzy; require an exact email match.
            authUser = await findAuthUserByEmailExact(supabase, email);
        }

        // Auto-provision: create user if not found (first sign-in)
        if (!authUser) {
            console.log('Auto-provisioning relay user for:', email);
            const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
                email,
                email_confirm: true,
                user_metadata: providerMeta,
            });
            if (createError || !newUser?.user) {
                console.error('Failed to provision user:', createError);
                return NextResponse.json({ error: 'Failed to provision user', email }, { status: 500 });
            }
            authUser = newUser.user;
            let freshlyCreated = true;

            if (pendingAppleSub) {
                // Claim the Apple sub for this new user. If a concurrent first
                // sign-in claimed it a moment earlier, that account is the
                // real one: drop the user we just created (seconds old, no
                // profile, no data) and continue as the winner.
                const link = await linkAppleSub(supabase, pendingAppleSub, authUser.id);
                if (link === 'error') {
                    return NextResponse.json({ error: 'Failed to link Apple account' }, { status: 500 });
                }
                if (link.ownerId !== authUser.id) {
                    const loserId = authUser.id;
                    const winner = await getAuthUserById(supabase, link.ownerId);
                    if (!winner) {
                        return NextResponse.json({ error: 'Linked account is missing' }, { status: 500 });
                    }
                    const { error: dropError } = await supabase.auth.admin.deleteUser(loserId);
                    if (dropError) console.error('Failed to drop duplicate Apple user:', loserId, dropError);
                    authUser = winner;
                    freshlyCreated = false;
                }
            }

            if (freshlyCreated) {
                // Create user_profile with handle derived from email (full email prefix is unique)
                const handle = email.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
                const { error: profileError } = await supabase.from('user_profiles').insert({
                    user_id: authUser.id,
                    handle,
                    display_name: displayName || handle,
                });
                if (profileError) {
                    console.error('Failed to create user profile:', profileError);
                    return NextResponse.json({ error: 'Failed to provision profile', email }, { status: 500 });
                }

                // First-ever sign-in for this account: prejoin the default public
                // rooms (idempotent, never blocks auth).
                await joinDefaultRooms(supabase, authUser.id);
            }
        }

        // Get handle from user_profiles
        let { data: profile } = await supabase
            .from('user_profiles')
            .select('handle')
            .eq('user_id', authUser.id)
            .maybeSingle();

        // Self-heal: if the first sign-in created the auth user but the
        // profile insert failed, this account has no profile row and (because
        // the prejoin above only runs in the brand-new-user branch) would
        // never get its default rooms. Lazily repair both on any later
        // sign-in, mirroring the per-request existence gate in
        // /api/v1/messages' resolveUserFromGoogleIdToken.
        if (!profile) {
            const repairHandle = email.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
            const { error: repairError } = await supabase.from('user_profiles').insert({
                user_id: authUser.id,
                handle: repairHandle,
                display_name: displayName || repairHandle,
            });
            if (repairError) {
                // A concurrent request may have just repaired it (unique
                // user_id); anything else is a real failure — log and keep
                // the legacy null-handle behavior.
                if (repairError.code !== '23505') {
                    console.error('Failed to repair user profile:', repairError);
                }
            } else {
                profile = { handle: repairHandle };
                await joinDefaultRooms(supabase, authUser.id);
            }
        }

        const handle = profile?.handle?.replace('@', '') || null;

        // Check if user has an agent record, create one if not.
        // A user can own MULTIPLE agents now (e.g. Mac-helper-registered ones via
        // /agents/me/owned). The old .maybeSingle() ERRORED on >1 row, which made
        // `agent` null -> the code tried to create a duplicate agent -> handle
        // collision -> 500 -> sign-in broke for anyone with >1 owned agent. So
        // select all owned agents and pick the relay/CodeWatch one deterministically:
        // prefer the agent created via relay-auth (the cloud sign-in agent), else
        // the oldest owned agent.
        const { data: ownedForAuth } = await supabase
            .from('agents')
            .select('id, handle, metadata, created_at')
            .eq('owner_id', authUser.id)
            .order('created_at', { ascending: true });
        let agent =
            (ownedForAuth || []).find(
                (a) => (a.metadata as { created_via?: string } | null)?.created_via === 'relay-auth'
            ) ||
            (ownedForAuth || [])[0] ||
            null;

        let apiKey: string | null = null;
        // Track the agent whose key this sign-in uses, so we can guarantee it
        // is a member of the personal room (the room-403 self-heal).
        let currentAgentId: string | null = agent?.id ?? null;

        // Per-device key support: when a client identifies its device, mint an
        // ADDITIVE scoped key (agent_keys) instead of rotating the single shared
        // agents.api_key_hash. Rotating the shared key logs every OTHER device
        // out (phone vs Mac helper vs watch ping-pong). Clients that don't send
        // device_id keep the exact legacy behavior, so this is backward safe.
        const deviceId = typeof body?.device_id === 'string' ? body.device_id.trim() : '';
        const deviceName = typeof body?.device_name === 'string' ? body.device_name.trim() : '';
        const wantsNewKey = Boolean(body?.force_new_key || body?.reset);

        if (!agent) {
            // Auto-create the agent. agents.api_key_hash is NOT NULL, so always
            // generate a legacy key hash. A legacy (no device_id) client gets
            // that key back; a device client gets a scoped key below instead and
            // this legacy hash simply goes unused.
            const legacyKey = 'xfb_' + crypto.randomBytes(32).toString('hex');
            const legacyHash = crypto.createHash('sha256').update(legacyKey).digest('hex');
            const agentHandle = handle || email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
            const { data: createdAgent, error: agentError } = await supabase
                .from('agents')
                .insert({
                    handle: agentHandle,
                    name: displayName || agentHandle,
                    api_key_hash: legacyHash,
                    owner_id: authUser.id,
                    metadata: { provider: 'codewatch', created_via: 'relay-auth' },
                })
                .select('id')
                .single();
            if (agentError) {
                console.error('Failed to create agent:', agentError);
                return NextResponse.json({ error: 'Failed to create relay agent', email }, { status: 500 });
            }
            currentAgentId = createdAgent?.id ?? null;
            if (!deviceId) apiKey = legacyKey;
        }

        if (deviceId && currentAgentId) {
            // Per-device scoped key path (never touches the shared key).
            const res = await ensureDeviceKey(supabase, currentAgentId, deviceId, deviceName, wantsNewKey);
            if (res.error) {
                return NextResponse.json({ error: 'Failed to mint device key', email }, { status: 500 });
            }
            apiKey = res.apiKey;
        } else if (agent && !deviceId && wantsNewKey) {
            // Legacy path (no device_id): rotate the shared key as before.
            apiKey = 'xfb_' + crypto.randomBytes(32).toString('hex');
            const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
            const { error: updateError } = await supabase
                .from('agents')
                .update({ api_key_hash: apiKeyHash })
                .eq('owner_id', authUser.id);
            if (updateError) {
                console.error('Failed to rotate relay API key:', updateError);
                return NextResponse.json({ error: 'Failed to rotate relay API key', email }, { status: 500 });
            }
        }
        // else: existing agent, no device_id, no force -> apiKey null; the client
        // uses its stored key (don't rotate, it breaks CLI + other devices).

        // Ensure the user's auto-created private room exists and contains
        // them + all agents they own (idempotent; never blocks auth).
        const personalRoom = handle
            ? await ensurePersonalRoom(supabase, authUser.id, handle, displayName || handle, currentAgentId)
            : null;

        return NextResponse.json({
            user_id: email,
            display_name: handle || email.split('@')[0],
            api_key: apiKey,
            relay_url: '/api/v1/relay',
            personal_room: personalRoom,
        });
    } catch (error) {
        console.error('Error in POST /api/v1/relay/auth:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
