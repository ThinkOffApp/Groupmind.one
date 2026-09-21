// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse, after } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { agentHasScope, extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { sendRoomWebhook, sendDMWebhook, extractMentions, type RoomMessageWebhookPayload, type DMMessageWebhookPayload } from '@/lib/webhook';
import { upsertIntentSlot } from '@/lib/intent-store';
import { encryptMessage, decryptMessage } from '@/lib/crypto';
import { tokenize, hashTokens, isIndexEnabled } from '@/lib/search-index';
import { filterMessageContent } from '@/lib/message-filters';
import { resolveOpenaiProxyAgent } from '@/lib/proxy-identity';
import { joinDefaultRooms } from '@/lib/default-rooms';
import { resolveRecipient } from '@/lib/resolve-recipient';
import { parseClientMessageId, clientMessageMetadata, findMessageByClientKey, isUniqueViolation, stripReservedClientFields } from '@/lib/message-idempotency';
import { messageBodyTooLong } from '@/lib/message-limits';
import { identityMetaIsTrusted, dmParticipantIds } from '@/lib/sender-identity';
import { WEB_USER_AGENT_ID } from '@/lib/web-agent';

const supabase = getServiceSupabase();

async function findAuthUserByEmailExact(email: string) {
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

async function resolveUserFromGoogleIdToken(googleIdToken: string | null) {
    if (!googleIdToken) {
        return null;
    }

    const googleResp = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(googleIdToken)}`
    );

    if (!googleResp.ok) {
        const errorBody = await googleResp.text().catch(() => 'no body');
        console.error('Google token verification failed:', googleResp.status, errorBody);
        return null;
    }

    const tokenInfo = await googleResp.json();
    const email = tokenInfo.email as string | undefined;
    if (!email) {
        return null;
    }

    let authUser = await findAuthUserByEmailExact(email);
    if (!authUser) {
        const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
            email,
            email_confirm: true,
            user_metadata: { provider: 'google', provisioned_by: 'mobile-messages' },
        });
        if (createError || !newUser?.user) {
            throw createError || new Error('Failed to provision user');
        }
        authUser = newUser.user;
    }

    const { data: existingProfile } = await supabase
        .from('user_profiles')
        .select('user_id')
        .eq('user_id', authUser.id)
        .maybeSingle();

    if (!existingProfile) {
        const handle = email.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
        const { error: profileError } = await supabase.from('user_profiles').insert({
            user_id: authUser.id,
            handle,
            display_name: tokenInfo.name || handle,
        });
        if (profileError) {
            throw profileError;
        }

        // First provisioning for this account: prejoin the default public
        // rooms (idempotent, never blocks the request).
        await joinDefaultRooms(supabase, authUser.id);
    }

    return {
        id: authUser.id,
        email,
    };
}

// Get authenticated user from the Supabase session.
// 1) SSR cookie session (desktop web). 2) Authorization: Bearer <access_token>
// from the client session — some mobile browsers (notably Android Chrome) don't
// reliably round-trip the ~5KB chunked SSR auth cookie to the server, so cookie-only
// auth 401'd. The bearer token is validated with the service client and is
// cookie-independent. (A Supabase user JWT is not an xfb_ agent key, so the
// agent-key path simply doesn't match it and we fall through to here.)
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

async function resolveSessionSenderProfile(sessionUser: { id: string; email?: string | null }) {
    const fallbackHandle = sessionUser.email?.split('@')[0] || 'unknown';

    const { data: xfbProfile } = await supabase
        .from('xfb_user_profiles')
        .select('handle, display_name')
        .eq('user_id', sessionUser.id)
        .maybeSingle();

    if (xfbProfile?.handle || xfbProfile?.display_name) {
        return {
            handle: xfbProfile.handle || xfbProfile.display_name || fallbackHandle,
            name: xfbProfile.display_name || xfbProfile.handle || 'Human User',
        };
    }

    const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('handle, display_name')
        .eq('user_id', sessionUser.id)
        .maybeSingle();

    return {
        handle: userProfile?.handle || userProfile?.display_name || fallbackHandle,
        name: userProfile?.display_name || userProfile?.handle || 'Human User',
    };
}

export async function POST(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;
        const body = await request.json();
        const googleIdTokenHeader = request.headers.get('x-google-id-token');

        if (apiKey) {
            agent = await getAgentByApiKey(apiKey, 'id, handle, name, owner_id');
        }

        if (!agent) {
            sessionUser = await resolveUserFromGoogleIdToken(googleIdTokenHeader || body?.google_id_token || null);
        }

        if (!agent && !sessionUser) {
            sessionUser = await getSessionUser(request);
        }

        if (!agent && !sessionUser) {
            // Distinguish a bad credential from an absent one — returning
            // "Missing Authorization" for an invalid key sends callers
            // debugging the wrong problem (they check headers, not the key).
            return NextResponse.json(
                { error: apiKey ? 'Invalid API key' : 'Missing Authorization' },
                { status: 401 }
            );
        }

        const { to, room, body: messageBody, metadata, audio_url, image_url, file_url, file_name, file_size, reply_to, client_message_id } = body;
        const textBody = typeof messageBody === 'string' ? messageBody : '';
        const trimmedBody = textBody.trim();
        const tooLong = messageBodyTooLong(trimmedBody);
        if (tooLong) {
            return NextResponse.json({ error: tooLong }, { status: 400 });
        }
        const safeBody = trimmedBody
            || (image_url ? '🖼️ Image attachment'
                : (audio_url ? '🎧 Audio attachment'
                    : (file_url ? `📎 ${typeof file_name === 'string' && file_name ? file_name : 'File attachment'}` : '')));

        if (!safeBody && !audio_url && !image_url && !file_url) {
            return NextResponse.json({ error: 'Message body or audio_url/image_url/file_url required' }, { status: 400 });
        }

        const clientMessage = parseClientMessageId(client_message_id);
        if (clientMessage.error) {
            return NextResponse.json({ error: clientMessage.error }, { status: 400 });
        }

        if (to && room) {
            return NextResponse.json({ error: 'Cannot specify both "to" and "room"' }, { status: 400 });
        }

        // Scoped key enforcement: if the caller authenticated with a scoped
        // agent key (agent.scopes !== undefined), check it permits this write.
        // Legacy keys (no scopes array) keep full access for backwards compat.
        if (agent && agent.scopes !== undefined) {
            const target = room
                ? `messages:write:${room}`
                : to
                    ? `messages:write:dm:${typeof to === 'string' ? to.replace(/^@/, '') : to}`
                    : 'messages:write';
            if (!agentHasScope(agent, target)) {
                return NextResponse.json(
                    {
                        error: 'Forbidden by key scope',
                        required: target,
                        granted: agent.scopes,
                    },
                    { status: 403 }
                );
            }
        }

        // Per-user identity proxy for OpenAI Custom GPT Actions. When the key
        // carries `proxy:openai` scope and the request includes the OpenAI
        // ephemeral user id header, resolve (or auto-provision) a derived
        // per-user agent and use it as the speaking identity. The parent
        // agent stays in `agent` for scope/auth purposes; `speakingAgent`
        // is what gets written as `from_agent_id` and shown to consumers.
        let speakingAgent = agent;
        if (agent) {
            const proxied = await resolveOpenaiProxyAgent(request, agent, body);
            if (proxied) {
                speakingAgent = proxied;
            }
        }

        let toAgentId: string | null = null;
        let toUserId: string | null = null;
        let roomId: string | null = null;
        let roomObj: { id: string; slug: string; name: string } | null = null;
        let isPrivateRoom = false;

        if (to) {
            // Case-insensitive: handles are identifiers, and humans type
            // them lowercase. The old .eq('handle', ...) lookups meant a DM
            // to "@claudemb" 404'd while "@claudeMB" delivered — every human
            // DM to a mixed-case agent handle silently bounced since April
            // (reported by a user). See resolveRecipient for matching rules.
            const resolved = await resolveRecipient(supabase, to);
            toAgentId = resolved.agentId;
            toUserId = resolved.userId;

            if (!toAgentId && !toUserId) {
                return NextResponse.json({ error: `Recipient not found: ${to}` }, { status: 404 });
            }
        }

        if (room) {
            let roomData = null;

            const { data: roomBySlug } = await supabase
                .from('rooms')
                .select('id, slug, is_public')
                .eq('slug', room)
                .single();

            if (roomBySlug) {
                roomData = roomBySlug;
            } else {
                const { data: roomById } = await supabase
                    .from('rooms')
                    .select('id, slug, is_public')
                    .eq('id', room)
                    .single();
                roomData = roomById;
            }

            if (!roomData) {
                return NextResponse.json({ error: `Room not found: ${room}` }, { status: 404 });
            }

            let membership = null;
            if (agent) {
                const { data } = await supabase
                    .from('room_members')
                    .select('id')
                    .eq('room_id', roomData.id)
                    .eq('agent_id', agent.id)
                    .single();
                membership = data;

                // Fallback: if the agent is not a member itself, check whether
                // its OWNER user is (mirrors GET /rooms/{room}/messages). The
                // prejoined default rooms and CodeWatch auto-agent rooms hold
                // {room_id, user_id} rows only, so without this an agent key
                // could read those rooms but got 403 on posting to them.
                if (!membership && agent.owner_id) {
                    const { data: ownerData } = await supabase
                        .from('room_members')
                        .select('id')
                        .eq('room_id', roomData.id)
                        .eq('user_id', agent.owner_id)
                        .single();
                    membership = ownerData;
                }
            } else if (sessionUser) {
                const { data } = await supabase
                    .from('room_members')
                    .select('id')
                    .eq('room_id', roomData.id)
                    .eq('user_id', sessionUser.id)
                    .single();
                membership = data;
            }

            if (!membership) {
                return NextResponse.json({ error: 'Not a member of this room' }, { status: 403 });
            }

            roomId = roomData.id;
            // Pass the resolved room OBJECT to the dispatcher. Previously the
            // request's `room` SLUG STRING was forwarded, so the room_message
            // webhook serialized room.{id,slug,name} as {} — the empty room made
            // the family bridge default EVERY message to thinkoff-development,
            // mis-routing all other rooms (e.g. clarity-dev). slug doubles as name.
            roomObj = { id: roomData.id, slug: roomData.slug, name: roomData.slug };
            isPrivateRoom = roomData.is_public === false;
        }

        // Reserved idempotency fields are set by the server only (see
        // stripReservedClientFields); everything else the caller sent stays.
        let msgMetadata: Record<string, unknown> = stripReservedClientFields(metadata);
        if (audio_url) {
            msgMetadata = { ...msgMetadata, audio_url };
        }
        if (image_url) {
            msgMetadata = { ...msgMetadata, image_url };
        }
        if (file_url) {
            msgMetadata = {
                ...msgMetadata,
                file_url,
                ...(typeof file_name === 'string' && file_name ? { file_name } : {}),
                ...(typeof file_size === 'number' ? { file_size } : {}),
            };
        }
        if (reply_to) {
            msgMetadata = { ...msgMetadata, reply_to };
        }
        if (sessionUser) {
            msgMetadata = {
                ...msgMetadata,
                user: {
                    id: sessionUser.id,
                    email: sessionUser.email
                }
            };
        }

        if (toUserId) {
            msgMetadata = {
                ...msgMetadata,
                dm: {
                    ...(msgMetadata?.dm || {}),
                    to_user_id: toUserId,
                }
            };
        }

        // Filter agent messages for error spam and secret leaks
        if (agent) {
            const filterResult = filterMessageContent(safeBody);
            if (!filterResult.allowed) {
                console.log(`[MessageFilter] Blocked ${agent.handle}: ${filterResult.code} — ${filterResult.reason}`);
                return NextResponse.json({
                    filtered: true,
                    code: filterResult.code,
                    reason: filterResult.reason,
                }, { status: 200 });
            }
        }

        // Idempotent resend (CodeWatch #157): the same sender repeating the
        // same client_message_id gets the message already stored, not a
        // second row. The lookup catches retries; once the unique index from
        // 20260903_client_message_key.sql is applied, a concurrent duplicate
        // fails the insert with 23505 and is answered the same way.
        // The stored row is the truth: a retry whose text changed is still
        // the same message, and the caller gets what was actually kept.
        type StoredMessage = {
            id: string; created_at: string; body: string;
            room_id: string | null; to_agent_id: string | null; metadata: Record<string, unknown> | null;
        };
        const STORED_COLUMNS = 'id, created_at, body, room_id, to_agent_id, metadata';
        const fromAgentId = speakingAgent?.id || WEB_USER_AGENT_ID;
        // Same shape as the 201 below, but every field comes from the stored
        // row: a retry that changed text, target or attachments still gets
        // the message that was actually kept.
        const duplicateResponse = (existing: StoredMessage) => {
            let storedText = existing.body;
            if (isPrivateRoom) {
                try { storedText = decryptMessage(existing.body); } catch { /* keep stored form */ }
            }
            const meta = existing.metadata || {};
            const sameRoom = !!roomId && existing.room_id === roomId;
            const sameRecipient = !!toAgentId && existing.to_agent_id === toAgentId;
            return NextResponse.json({
                id: existing.id,
                duplicate: true,
                from: speakingAgent?.handle || null,
                to: sameRecipient ? (to || null) : null,
                room: sameRoom ? roomObj : (existing.room_id ? { id: existing.room_id } : null),
                body: storedText,
                audio_url: (meta.audio_url as string | undefined) || null,
                image_url: (meta.image_url as string | undefined) || null,
                file_url: (meta.file_url as string | undefined) || null,
                file_name: (meta.file_name as string | undefined) || null,
                file_size: typeof meta.file_size === 'number' ? meta.file_size : null,
                created_at: existing.created_at,
                type: existing.room_id ? 'room' : 'dm',
            }, { status: 200 });
        };
        let clientKey: string | null = null;
        if (clientMessage.id) {
            const senderId = speakingAgent?.id || sessionUser?.id || WEB_USER_AGENT_ID;
            const cm = clientMessageMetadata(senderId, clientMessage.id);
            clientKey = cm.client_message_key;
            msgMetadata = { ...msgMetadata, ...cm };
            const existing = await findMessageByClientKey<StoredMessage>(supabase, clientKey, fromAgentId, STORED_COLUMNS);
            if (existing) return duplicateResponse(existing);
        }

        // Encrypt body for private rooms
        const storedBody = isPrivateRoom ? encryptMessage(safeBody) : safeBody;

        const { data: message, error } = await supabase
            .from('messages')
            .insert({
                from_agent_id: speakingAgent?.id || WEB_USER_AGENT_ID,
                to_agent_id: toAgentId,
                room_id: roomId,
                body: storedBody,
                metadata: Object.keys(msgMetadata).length > 0 ? msgMetadata : null,
            })
            .select(`id, body, created_at, from_agent_id, to_agent_id, room_id`)
            .single();

        if (error) {
            if (clientKey && isUniqueViolation(error)) {
                const existing = await findMessageByClientKey<StoredMessage>(supabase, clientKey, fromAgentId, STORED_COLUMNS);
                if (existing) return duplicateResponse(existing);
            }
            console.error('Error inserting message:', error);
            console.error('send message failed:', error);
            return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
        }

        // Blind-index the words of this message so search does not have to
        // decrypt-and-scan history. Deliberately best-effort: a message that
        // sent must not fail because its index rows did not, so this is caught
        // and logged rather than surfaced. A missed row costs one un-indexed
        // message, and the search route still falls back to scanning.
        if (message && roomId && isIndexEnabled()) {
            try {
                const hashes = hashTokens(tokenize(safeBody));
                if (hashes.length) {
                    await supabase.from('message_search_tokens').insert(
                        hashes.map(h => ({
                            message_id: message.id,
                            room_id: roomId,
                            token_hash: h,
                            created_at: message.created_at,
                        }))
                    );
                }
            } catch (e) {
                console.error('[SearchIndex] indexing failed for message', message.id, e);
            }
        }

        // Auto-refresh the agent's intent slot on every successful post so
        // the LED on groupmind.one stays green without a separate heartbeat
        // call. Fire-and-forget after response is sent.
        if (agent?.handle) {
            const agentHandle = agent.handle.replace(/^@/, '');
            const targetUserId = (agent as { owner_id?: string }).owner_id || agentHandle;
            after(async () => {
                try {
                    await upsertIntentSlot({
                        userId: targetUserId,
                        slotType: 'agent',
                        slotId: agentHandle,
                        payload: {
                            name: agent.name,
                            handle: agent.handle,
                            status: 'active',
                            source: 'auto-from-message',
                            ttl_sec: 600,
                        },
                        replace: false,
                        actorAgentId: agent.id,
                    });
                } catch (e) {
                    console.warn('auto intent upsert failed:', e instanceof Error ? e.message : e);
                }
            });
        }

        const isDirectMessage = !!toAgentId || !!toUserId;
        const messageType = roomId ? 'room' : (isDirectMessage ? 'dm' : 'broadcast');
        const sessionSender = !agent && sessionUser
            ? await resolveSessionSenderProfile({ id: sessionUser.id, email: sessionUser.email })
            : null;
        const senderHandle = speakingAgent?.handle || sessionSender?.handle || 'unknown';
        const senderName = speakingAgent?.name || sessionSender?.name || 'Human User';
        const isHuman = !agent && !!sessionUser;

        if (toUserId) {
            try {
                const bodyPreview = safeBody.length > 100 ? safeBody.slice(0, 100) + '...' : safeBody;
                await supabase.from('xfb_notifications').insert({
                    user_id: toUserId,
                    actor_id: agent?.id || sessionUser?.id,
                    type: 'mention',
                    content: `DM from ${senderHandle}: ${bodyPreview}`,
                    reference_id: message.id,
                });
            } catch (notificationError) {
                console.error('Failed to create human DM notification:', notificationError);
            }
        }

        const requestUrl = new URL(request.url);
        const dispatchUrl = `${requestUrl.origin}/api/v1/internal/dispatch`;

        after(async () => {
            try {
                // Forward the heavy webhook and notification work to the Edge runtime
                // so the Node HTTP proxy can release the front-end connection immediately.
                await fetch(dispatchUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()}`
                    },
                    body: JSON.stringify({
                        type: roomId ? 'room_message' : (toAgentId ? 'dm_message' : 'broadcast'),
                        roomId: roomId || null,
                        room: roomObj,
                        toAgentId: toAgentId || null,
                        safeBody: safeBody,
                        originService: 'antfarm',
                        message: {
                            id: message.id,
                            created_at: message.created_at,
                            reply_to: reply_to || null,
                            metadata: msgMetadata,
                        },
                        sender: {
                            id: speakingAgent?.id || WEB_USER_AGENT_ID,
                            handle: senderHandle,
                            name: senderName,
                            isHuman: isHuman,
                        }
                    })
                });
            } catch (err) {
                console.error('Failed to trigger internal edge dispatcher:', err);
                try {
                    await supabase.from('webhook_queue').insert({
                        url: dispatchUrl,
                        payload: {
                            type: roomId ? 'room_message' : (toAgentId ? 'dm_message' : 'broadcast'),
                            roomId: roomId || null,
                            room: roomObj,
                            toAgentId: toAgentId || null,
                            safeBody: safeBody,
                            originService: 'antfarm',
                            message: {
                                id: message.id,
                                created_at: message.created_at,
                                reply_to: reply_to || null,
                            },
                            sender: {
                                id: agent?.id || WEB_USER_AGENT_ID,
                                handle: senderHandle,
                                name: senderName,
                                isHuman: isHuman,
                            }
                        },
                        attempts: 0,
                        status: 'pending',
                        last_attempt_at: new Date().toISOString()
                    });
                    console.log('[Edge Dispatcher Fallback] Queued internal dispatch for retry via webhook_queue');
                } catch (qErr) {
                    console.error('[Edge Dispatcher Fallback] Failed to enqueue:', qErr);
                }
            }
        });


        return NextResponse.json({
            id: message.id,
            from: senderHandle,
            to: to || null,
            room: roomObj,
            body: safeBody, // Return plaintext, not the encrypted stored body
            audio_url: audio_url || null,
            image_url: image_url || null,
            file_url: file_url || null,
            file_name: (typeof file_name === 'string' && file_name) ? file_name : null,
            file_size: (typeof file_size === 'number') ? file_size : null,
            created_at: message.created_at,
            type: messageType,
        }, { status: 201 });

    } catch (error) {
        console.error('Error in POST /messages:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function GET(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;
        const googleIdTokenHeader = request.headers.get('x-google-id-token');

        if (apiKey) {
            agent = await getAgentByApiKey(apiKey, 'id, handle, name, owner_id');
        }

        if (!agent) {
            sessionUser = await resolveUserFromGoogleIdToken(googleIdTokenHeader);
        }

        if (!agent && !sessionUser) {
            sessionUser = await getSessionUser(request);
        }

        if (!agent && !sessionUser) {
            // Same invalid-vs-missing split as POST: a provided-but-bad key
            // must not report itself as an absent header.
            return NextResponse.json(
                { error: apiKey ? 'Invalid API key' : 'Missing Authorization' },
                { status: 401 }
            );
        }

        const agentId = agent?.id || WEB_USER_AGENT_ID;
        const sessionSender = !agent && sessionUser
            ? await resolveSessionSenderProfile({ id: sessionUser.id, email: sessionUser.email })
            : null;
        const agentHandle = agent?.handle || sessionSender?.handle || 'web-user';

        const { searchParams } = new URL(request.url);
        const since = searchParams.get('since');
        const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);

        // DM inbox query. We want messages where the current identity is
        // either sender or recipient, scoped to non-room messages.
        //
        // We DELIBERATELY DO NOT include `to_agent_id IS NULL` here. That
        // clause was originally meant to capture "broadcast to everyone"
        // messages, but in practice human-to-human DMs land with
        // to_agent_id = WEB_USER_AGENT_ID (the shared sentinel for web
        // users), not null. The old `is.null` clause therefore leaked
        // every human's DMs into every authenticated agent's inbox.
        //
        // Web-user-to-web-user DMs are still kept out of agent inboxes by
        // this tighter filter and additionally narrowed by the
        // `metadata.dm.to_user_id` visibility filter further below.
        //
        // Agent-to-USER DMs are stored with to_agent_id = null and the
        // recipient only in metadata.dm.to_user_id, so the agent-id clauses
        // alone can never return them. An agent reading on behalf of its
        // owner (e.g. the CodeWatch relay agent) must also see DMs addressed
        // to that owner — matched strictly by owner_id, never by the shared
        // WEB_USER_AGENT_ID sentinel, so other humans' DMs stay invisible.
        const ownerId = (agent as { owner_id?: string } | null)?.owner_id || null;
        const dmClauses = [
            `to_agent_id.eq.${agentId}`,
            `from_agent_id.eq.${agentId}`,
            ...(ownerId ? [`metadata->dm->>to_user_id.eq.${ownerId}`] : []),
        ];
        let query = supabase
            .from('messages')
            .select(`
                id,
                body,
                created_at,
                metadata,
                from_agent_id,
                from_agent:agents!messages_from_agent_id_fkey(handle, name),
                to_agent:agents!messages_to_agent_id_fkey(handle, name)
            `)
            .is('room_id', null)
            .or(dmClauses.join(','))
            .order('created_at', { ascending: false })
            .limit(limit);

        if (since) {
            query = query.gt('created_at', since);
        }

        const { data: messages, error } = await query;

        if (error) {
            console.error('Error fetching messages:', error);
            return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
        }

        const rawMessages = (messages || []) as any[];
        const visibleMessages = rawMessages.filter((m) => {
            if (agent) return true;
            const meta = m.metadata || {};
            // SENDER identity and RESOLVED RECIPIENT are different claims and
            // get different rules (codexmb's blocking review of d424999).
            //
            // `user` asserts WHO SENT this. It used to be believed on any row,
            // so an agent key could store it and be read back as that human.
            // Gated to rows the web user agent actually wrote.
            //
            // `dm.to_user_id` asserts WHO IT WAS ADDRESSED TO, and the server
            // derives it from resolveRecipient for EVERY sender -- an
            // agent->human DM legitimately carries it with from_agent_id set
            // to the real agent and to_agent_id null. Gating it on the sender
            // discarded the recipient, skipped the profile lookup and returned
            // to:null / a broadcast-looking row to agent and owner-relay
            // callers, and could drop the row from the human's own view.
            // Caller-supplied `dm` is stripped on write, so new rows carry only
            // the server's value; legacy rows are the residual, and a forged
            // one there can misroute a DM's visibility but cannot claim a
            // sender. That is the smaller risk and it is not fixed by
            // pretending the recipient is unknown.
            const { senderUserId, recipientUserId: toUserId } =
                dmParticipantIds(m, WEB_USER_AGENT_ID);
            const involvesCurrentUser = senderUserId === sessionUser?.id || toUserId === sessionUser?.id;
            const isHumanMessage = senderUserId || toUserId;
            if (isHumanMessage) return involvesCurrentUser;
            return !!m.to_agent;
        });

        const participantUserIds = Array.from(new Set(
            visibleMessages.flatMap((m) => {
                // Sender id only when the row may claim one; recipient id
                // always, because it is server-resolved for every sender and
                // its profile is needed to render `to`.
                const { senderUserId, recipientUserId } = dmParticipantIds(m, WEB_USER_AGENT_ID);
                return [senderUserId, recipientUserId].filter(Boolean);
            })
        )) as string[];

        const userProfiles = new Map<string, { handle: string | null; name: string | null }>();
        if (participantUserIds.length > 0) {
            const { data: xfbProfiles } = await supabase
                .from('xfb_user_profiles')
                .select('user_id, handle, display_name')
                .in('user_id', participantUserIds);

            for (const profile of (xfbProfiles || []) as any[]) {
                userProfiles.set(profile.user_id, {
                    handle: profile.handle || null,
                    name: profile.display_name || null,
                });
            }

            const missingIds = participantUserIds.filter(id => !userProfiles.has(id));
            if (missingIds.length > 0) {
                const { data: fallbackProfiles } = await supabase
                    .from('user_profiles')
                    .select('user_id, handle, display_name')
                    .in('user_id', missingIds);

                for (const profile of (fallbackProfiles || []) as any[]) {
                    userProfiles.set(profile.user_id, {
                        handle: profile.handle || null,
                        name: profile.display_name || null,
                    });
                }
            }
        }

        const formatted = visibleMessages.map(m => {
            const meta = m.metadata || {};
            const fromAgent = m.from_agent as unknown as { handle: string; name: string } | null;
            const toAgent = m.to_agent as unknown as { handle: string; name: string } | null;
            // Sender gated, recipient not -- see the visibility filter above.
            const { senderUserId, recipientUserId } = dmParticipantIds(m, WEB_USER_AGENT_ID);
            const senderProfile = senderUserId ? userProfiles.get(senderUserId) : null;
            const recipientProfile = recipientUserId ? userProfiles.get(recipientUserId) : null;

            const fromHandle = senderProfile?.handle
                ? `@${senderProfile.handle}`
                : (fromAgent?.handle || 'unknown');
            const fromName = senderProfile?.name
                || fromAgent?.name
                || 'Unknown';

            const toHandle = recipientProfile?.handle
                ? `@${recipientProfile.handle}`
                : (toAgent?.handle || null);

            return {
                id: m.id,
                from: fromHandle,
                from_name: fromName,
                to: toHandle,
                body: m.body,
                created_at: m.created_at,
                type: (toAgent || recipientUserId) ? 'dm' : 'broadcast',
                // Flatten attachments out of metadata so clients (e.g. the DM
                // view) can read them without knowing the storage layout.
                audio_url: meta?.audio_url || null,
                image_url: meta?.image_url || null,
                file_url: meta?.file_url || null,
                file_name: meta?.file_name || null,
                file_size: typeof meta?.file_size === 'number' ? meta.file_size : null,
                // Echo of the sender's client_message_id (antfarm#123), flat
                // like the room GET so DM clients match their optimistic copy
                // the same way (CodeWatch#169 review).
                client_message_id: meta?.client_message_id || null,
                metadata: m.metadata,
            };
        });

        return NextResponse.json({
            messages: formatted,
            count: formatted.length,
            your_handle: agentHandle,
            since: since || null,
        });

    } catch (error) {
        console.error('Error in GET /messages:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
