import { NextResponse, after } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { sendRoomWebhook, extractMentions, type RoomMessageWebhookPayload } from '@/lib/webhook';
import { encryptMessage, decryptMessage } from '@/lib/crypto';
import { filterMessageContent } from '@/lib/message-filters';
import { parseClientMessageId, clientMessageMetadata, findMessageByClientKey, isUniqueViolation } from '@/lib/message-idempotency';
import { messageBodyTooLong } from '@/lib/message-limits';
import { trustedUserMeta, projectRoomSender } from '@/lib/sender-identity';
import { WEB_USER_AGENT_ID } from '@/lib/web-agent';

const supabase = getServiceSupabase();

// Get authenticated user from the Supabase session.
// 1) SSR cookie session (desktop web). 2) Authorization: Bearer <access_token>
// from the client session — some mobile browsers (notably Android Chrome) don't
// reliably round-trip the ~5KB chunked SSR auth cookie to the server, so cookie-only
// auth 401'd and rooms wouldn't open. The bearer token is validated with the service
// client and is cookie-independent. (A Supabase user JWT is not an xfb_ agent key, so
// the agent-key path above simply doesn't match it and we fall through to here.)
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

type RouteParams = { params: Promise<{ room: string }> };

// GET /api/v1/rooms/{room}/messages - Read room messages
export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug } = await params;

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

        // Require at least one auth method. Distinguish a bad credential
        // from an absent one — "Missing Authorization" for an invalid key
        // sends callers debugging headers instead of the key (same fix as
        // the /messages route; it cost a real half-hour on 2026-08-28).
        if (!agent && !sessionUser) {
            return NextResponse.json(
                { error: apiKey ? 'Invalid API key' : 'Missing Authorization' },
                { status: 401 }
            );
        }

        // Find room by slug first, then by ID
        let room = null;

        const { data: roomBySlug } = await supabase
            .from('rooms')
            .select('id, name, slug, is_public')
            .eq('slug', roomSlug)
            .single();

        if (roomBySlug) {
            room = roomBySlug;
        } else {
            const { data: roomById } = await supabase
                .from('rooms')
                .select('id, name, slug, is_public')
                .eq('id', roomSlug)
                .single();
            room = roomById;
        }

        if (!room) {
            return NextResponse.json({ error: 'Room not found' }, { status: 404 });
        }

        // Check membership (for agent or session user)
        let membership = null;
        if (agent) {
            const { data } = await supabase
                .from('room_members')
                .select('*')
                .eq('room_id', room.id)
                .eq('agent_id', agent.id)
                .single();
            membership = data;

            // Fallback: if agent is not a member, check if its owner is a member (e.g. CodeWatch auto-agents)
            if (!membership && agent.owner_id) {
                const { data: ownerData } = await supabase
                    .from('room_members')
                    .select('*')
                    .eq('room_id', room.id)
                    .eq('user_id', agent.owner_id)
                    .single();
                membership = ownerData;
            }
        } else if (sessionUser) {
            const { data } = await supabase
                .from('room_members')
                .select('*')
                .eq('room_id', room.id)
                .eq('user_id', sessionUser.id)
                .single();
            membership = data;
        }

        if (!membership) {
            return NextResponse.json({ error: 'Not a member of this room' }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const since = searchParams.get('since');
        // History pagination: return messages strictly OLDER than this
        // created_at cursor (ISO timestamp). Client passes the oldest loaded
        // message's created_at to page backwards through the full archive.
        const before = searchParams.get('before');
        const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
        let unreadSince = searchParams.get('unread_since');

        // If user has never opened the room (no local storage seenAt), count from when they joined
        const timestamp = membership?.created_at || membership?.joined_at;
        if (!unreadSince && timestamp) {
            unreadSince = timestamp;
        }

        // Fetch messages
        let query = supabase
            .from('messages')
            .select(`
                id,
                body,
                created_at,
                metadata,
                from_agent_id,
                from_agent:agents!messages_from_agent_id_fkey(handle, name, metadata)
            `)
            .eq('room_id', room.id)
            .or('metadata->is_document_state.is.null,metadata->is_document_state.eq.false')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (since) {
            query = query.gt('created_at', since);
        }
        if (before) {
            query = query.lt('created_at', before);
        }

        const { data: messages, error } = await query;

        if (error) {
            console.error('Error fetching room messages:', error);
            return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 });
        }

        let unreadCount = 0;
        if (unreadSince) {
            try {
                const { count, error: countError } = await supabase
                    .from('messages')
                    .select('*', { count: 'exact', head: true })
                    .eq('room_id', room.id)
                    .gt('created_at', unreadSince);

                if (!countError && count !== null) {
                    unreadCount = count;
                }
            } catch (e) {
                console.error('Error fetching unread count:', e);
            }
        }

        // Fetch user profiles for messages sent by the Web User Agent (human users)
        // `metadata.user` is only believed on rows actually written by the web
        // user agent. Historically this filter tested `metadata.user?.id` alone
        // while WEB_USER_AGENT_ID sat unused two lines above, so any agent key
        // could store a `user` blob and be read back as that human — handle and
        // isHuman both. Writes can no longer carry `user`, but rows stored
        // before that are still in the table, so the reader has to check too.
        const webUserMessages = (messages || []).filter((m: any) =>
            trustedUserMeta(m, WEB_USER_AGENT_ID) !== null
        );

        // Via the helper too: the last raw metadata.user read in this reader,
        // so there is no path left that looks at it without the gate.
        const userIds = [...new Set(
            webUserMessages.map((m: any) => trustedUserMeta(m, WEB_USER_AGENT_ID)!.id)
        )];
        let userProfiles: Map<string, { name: string; avatar_url: string | null; handle: string | null }> = new Map();

        if (userIds.length > 0) {
            // Try xfb_user_profiles first (has avatar_url and handle)
            const { data: xfbProfiles } = await supabase
                .from('xfb_user_profiles')
                .select('user_id, display_name, avatar_url, handle')
                .in('user_id', userIds);

            if (xfbProfiles) {
                for (const p of xfbProfiles) {
                    userProfiles.set(p.user_id, {
                        name: p.display_name || 'Human',
                        avatar_url: p.avatar_url || null,
                        handle: p.handle || null,
                    });
                }
            }

            // Fallback to user_profiles for any not found
            const missingIds = userIds.filter(id => !userProfiles.has(id));
            if (missingIds.length > 0) {
                const { data: profiles } = await supabase
                    .from('user_profiles')
                    .select('user_id, display_name')
                    .in('user_id', missingIds);

                if (profiles) {
                    for (const p of profiles) {
                        if (p.display_name) {
                            userProfiles.set(p.user_id, { name: p.display_name, avatar_url: null, handle: null });
                        }
                    }
                }
            }
        }

        const formatted = (messages || []).map((m: any) => {
            // Sender projection lives in @/lib/sender-identity so it can be
            // driven with real stored rows in tests, and so nothing about
            // whose identity a row may claim is decided inline here.
            const { senderHandle, senderName, avatarUrl, isHuman } =
                projectRoomSender(m, userProfiles, WEB_USER_AGENT_ID);

            // Decrypt message body for private rooms
            let body = m.body;
            if (room!.is_public === false) {
                try {
                    body = decryptMessage(body);
                } catch (e) {
                    // Message was likely stored before encryption was enabled — keep original
                    body = m.body;
                }
            }

            return {
                id: m.id,
                from: senderHandle,
                from_name: senderName,
                body,
                audio_url: m.metadata?.audio_url || null,
                image_url: m.metadata?.image_url || null,
                file_url: m.metadata?.file_url || null,
                file_name: m.metadata?.file_name || null,
                file_size: typeof m.metadata?.file_size === 'number' ? m.metadata.file_size : null,
                created_at: m.created_at,
                avatar_url: avatarUrl,
                isHuman,
                reactions: m.metadata?.reactions || {},
                reply_to: m.metadata?.reply_to || null,
                client_message_id: m.metadata?.client_message_id || null,
                // Inline action buttons (e.g. Approve/Deny on confirmation
                // requests). When present, the chat UI renders interactive
                // buttons that POST a `/action <intent_id>` reply when tapped.
                actions: Array.isArray(m.metadata?.actions) ? m.metadata.actions : null,
                intent_id: typeof m.metadata?.intent_id === 'string' ? m.metadata.intent_id : null,
            };
        });

        return NextResponse.json({
            room: room.slug,
            room_name: room.name,
            messages: formatted,
            count: formatted.length,
            since: since || null,
            unread_count: unreadCount,
        });

    } catch (error) {
        console.error('Error in GET /rooms/messages:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST /api/v1/rooms/{room}/messages - Send a message to a room
export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug } = await params;

        // Authenticate
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;

        if (apiKey) {
            agent = await getAgentByApiKey(apiKey, 'id, handle, name, owner_id');
        }

        if (!agent) {
            sessionUser = await getSessionUser(request);
        }

        if (!agent && !sessionUser) {
            return NextResponse.json(
                { error: apiKey ? 'Invalid API key' : 'Missing Authorization' },
                { status: 401 }
            );
        }

        // Find room
        let room = null;
        const { data: roomBySlug } = await supabase
            .from('rooms')
            .select('id, name, slug, is_public')
            .eq('slug', roomSlug)
            .single();

        if (roomBySlug) {
            room = roomBySlug;
        } else {
            const { data: roomById } = await supabase
                .from('rooms')
                .select('id, name, slug, is_public')
                .eq('id', roomSlug)
                .single();
            room = roomById;
        }

        if (!room) {
            return NextResponse.json({ error: 'Room not found' }, { status: 404 });
        }

        // Check membership
        let membership = null;
        if (agent) {
            const { data } = await supabase
                .from('room_members')
                .select('id')
                .eq('room_id', room.id)
                .eq('agent_id', agent.id)
                .single();
            membership = data;

            // Fallback: if agent is not a member, check if its owner is a member
            if (!membership && agent.owner_id) {
                const { data: ownerData } = await supabase
                    .from('room_members')
                    .select('id')
                    .eq('room_id', room.id)
                    .eq('user_id', agent.owner_id)
                    .single();
                membership = ownerData;
            }
        } else if (sessionUser) {
            const { data } = await supabase
                .from('room_members')
                .select('id')
                .eq('room_id', room.id)
                .eq('user_id', sessionUser.id)
                .single();
            membership = data;
        }

        if (!membership) {
            return NextResponse.json({ error: 'Not a member of this room' }, { status: 403 });
        }

        // Parse body
        const body = await request.json().catch(() => null);
        const audioUrl = body?.audio_url || null;
        const imageUrl = body?.image_url || null;
        const fileUrl = body?.file_url || null;
        const fileName = typeof body?.file_name === 'string' && body.file_name ? body.file_name : null;
        const fileSize = typeof body?.file_size === 'number' ? body.file_size : null;
        const replyTo = body?.reply_to || null; // { id, from, body } for reply-to
        // Approval/confirmation buttons: an agent can attach action buttons +
        // an intent id so this message renders as Approve/Deny in CodeWatch.
        // Tapping a button posts a `/action <intent_id>` reply that the
        // requesting agent (or the IAK daemon) polls for and acts on.
        const actions = Array.isArray(body?.actions) ? body.actions.slice(0, 6) : null;
        const intentId = typeof body?.intent_id === 'string' && body.intent_id.length <= 128
            ? body.intent_id
            : null;
        // Optional stable id from the client's outbox (CodeWatch #157): a
        // resend with the same id returns the stored message, see below.
        const clientMessage = parseClientMessageId(body?.client_message_id);
        if (clientMessage.error) {
            return NextResponse.json({ error: clientMessage.error }, { status: 400 });
        }
        if (!body || ((!body.body || typeof body.body !== 'string') && !audioUrl && !imageUrl && !fileUrl)) {
            return NextResponse.json({ error: 'Missing or invalid "body" field (or provide audio_url/image_url/file_url)' }, { status: 400 });
        }

        const messageBody = (typeof body.body === 'string' ? body.body : '').trim();
        if (messageBody.length === 0 && !audioUrl && !imageUrl && !fileUrl) {
            return NextResponse.json({ error: 'Message body cannot be empty (or provide audio_url/image_url/file_url)' }, { status: 400 });
        }
        const tooLong = messageBodyTooLong(messageBody);
        if (tooLong) {
            return NextResponse.json({ error: tooLong }, { status: 400 });
        }
        const safeMessageBody = messageBody
            || (imageUrl ? '🖼️ Image attachment'
                : (audioUrl ? '🎧 Audio attachment'
                    : `📎 ${fileName || 'File attachment'}`));

        // Filter agent messages for error spam and secret leaks
        if (agent) {
            const filterResult = filterMessageContent(safeMessageBody);
            if (!filterResult.allowed) {
                console.log(`[MessageFilter] Blocked ${agent.handle} in room ${roomSlug}: ${filterResult.code}`);
                return NextResponse.json({
                    filtered: true,
                    code: filterResult.code,
                    reason: filterResult.reason,
                }, { status: 200 });
            }
        }

        // Build message record

        // Encrypt body for private rooms
        const storedBody = room.is_public === false ? encryptMessage(safeMessageBody) : safeMessageBody;

        const messageData: Record<string, unknown> = {
            room_id: room.id,
            body: storedBody,
        };

        if (agent) {
            messageData.from_agent_id = agent.id;
            const agentMeta: Record<string, unknown> = {};
            if (audioUrl) agentMeta.audio_url = audioUrl;
            if (imageUrl) agentMeta.image_url = imageUrl;
            if (fileUrl) {
                agentMeta.file_url = fileUrl;
                if (fileName) agentMeta.file_name = fileName;
                if (fileSize !== null) agentMeta.file_size = fileSize;
            }
            if (replyTo) agentMeta.reply_to = replyTo;
            if (actions) agentMeta.actions = actions;
            if (intentId) agentMeta.intent_id = intentId;
            if (Object.keys(agentMeta).length > 0) messageData.metadata = agentMeta;
        } else if (sessionUser) {
            // Human users post through the web_user agent with metadata
            messageData.from_agent_id = WEB_USER_AGENT_ID;
            messageData.metadata = {
                ...(audioUrl ? { audio_url: audioUrl } : {}),
                ...(imageUrl ? { image_url: imageUrl } : {}),
                ...(fileUrl ? { file_url: fileUrl, ...(fileName ? { file_name: fileName } : {}), ...(fileSize !== null ? { file_size: fileSize } : {}) } : {}),
                ...(replyTo ? { reply_to: replyTo } : {}),
                ...(actions ? { actions } : {}),
                ...(intentId ? { intent_id: intentId } : {}),
                user: {
                    id: sessionUser.id,
                    email: sessionUser.email,
                },
            };
        }

        // Idempotent resend (CodeWatch #157): the same sender repeating the
        // same client_message_id gets the message already stored, not a
        // second row. The lookup catches retries; once the unique index from
        // 20260903_client_message_key.sql is applied, a concurrent duplicate
        // fails the insert with 23505 and is answered the same way.
        // The stored row is the truth: a retry whose text changed is still
        // the same message, and the caller gets what was actually kept.
        type StoredMessage = { id: string; created_at: string; body: string; metadata: Record<string, unknown> | null };
        const STORED_COLUMNS = 'id, created_at, body, metadata';
        const fromAgentId = (messageData.from_agent_id as string) || WEB_USER_AGENT_ID;
        const duplicateResponse = (existing: StoredMessage) => {
            let storedText = existing.body;
            if (room.is_public === false) {
                try { storedText = decryptMessage(existing.body); } catch { /* keep stored form */ }
            }
            const meta = existing.metadata || {};
            return NextResponse.json({
                message: 'Message already sent',
                duplicate: true,
                data: {
                    id: existing.id,
                    body: storedText,
                    audio_url: (meta.audio_url as string | undefined) || null,
                    image_url: (meta.image_url as string | undefined) || null,
                    room: room.slug,
                    from: agent?.handle || null,
                    created_at: existing.created_at,
                },
            }, { status: 200 });
        };
        let clientKey: string | null = null;
        if (clientMessage.id) {
            const senderId = agent?.id || sessionUser?.id || WEB_USER_AGENT_ID;
            const cm = clientMessageMetadata(senderId, clientMessage.id);
            clientKey = cm.client_message_key;
            messageData.metadata = { ...((messageData.metadata as Record<string, unknown>) || {}), ...cm };
            const existing = await findMessageByClientKey<StoredMessage>(supabase, clientKey, fromAgentId, STORED_COLUMNS);
            if (existing) return duplicateResponse(existing);
        }

        const { data: message, error } = await supabase
            .from('messages')
            .insert(messageData)
            .select('id, body, created_at')
            .single();

        if (error) {
            if (clientKey && isUniqueViolation(error)) {
                const existing = await findMessageByClientKey<StoredMessage>(supabase, clientKey, fromAgentId, STORED_COLUMNS);
                if (existing) return duplicateResponse(existing);
            }
            console.error('Error sending message:', error);
            return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
        }

        // Fire webhooks to room members (don't block response)
        const sessionSender = !agent && sessionUser
            ? await resolveSessionSenderProfile({ id: sessionUser.id, email: sessionUser.email })
            : null;
        const senderHandle = agent?.handle || sessionSender?.handle || 'unknown';
        const senderName = agent?.name || sessionSender?.name || 'Human User';
        const isHuman = !agent && !!sessionUser;

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
                        type: 'room_message',
                        roomId: room.id,
                        room: room,
                        toAgentId: null,
                        safeBody: safeMessageBody,
                        message: {
                            id: message.id,
                            created_at: message.created_at,
                            reply_to: replyTo,
                        },
                        sender: {
                            id: agent?.id || WEB_USER_AGENT_ID,
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
                            type: 'room_message',
                            roomId: room.id,
                            room: room,
                            toAgentId: null,
                            safeBody: safeMessageBody,
                            message: {
                                id: message.id,
                                created_at: message.created_at,
                                reply_to: replyTo,
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
            message: 'Message sent',
            data: {
                id: message.id,
                body: safeMessageBody,
                audio_url: audioUrl,
                image_url: imageUrl,
                room: room.slug,
                from: senderHandle,
                created_at: message.created_at,
            },
        }, { status: 201 });

    } catch (error) {
        console.error('Error in POST /rooms/messages:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
