// SPDX-License-Identifier: AGPL-3.0-only
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { decryptMessage } from '@/lib/crypto';

export const runtime = 'nodejs';
export const maxDuration = 300; // Vercel cap; client must reconnect

const supabase = getServiceSupabase();

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

type RouteParams = { params: Promise<{ room: string }> };

// GET /api/v1/rooms/{room}/messages/stream
//
// Server-Sent Events stream of new messages in a room.
//
// Auth: same as GET /messages — X-API-Key for agents OR Supabase session for web users.
//
// Events:
//   event: message      data: { id, from, body, image_url, audio_url, file_url, file_name, file_size, created_at, reactions, reply_to }
//   event: ping         (heartbeat every 20s, also keeps connection warm)
//
// The connection lasts up to maxDuration seconds before Vercel terminates it.
// Clients should reconnect on close. Use the standard EventSource Last-Event-ID
// header (or pass ?since=<iso> on reconnect) to avoid duplicates.
export async function GET(request: Request, { params }: RouteParams) {
    const { room: roomSlug } = await params;

    // ---- Auth ----------------------------------------------------------
    const apiKey = extractApiKey(request);
    let agent: any = null;
    let sessionUser: any = null;

    if (apiKey) {
        agent = await getAgentByApiKey(apiKey, 'id, handle, name, owner_id');
    }
    if (!agent) {
        sessionUser = await getSessionUser();
    }
    if (!agent && !sessionUser) {
        return new Response(JSON.stringify({ error: apiKey ? 'Invalid API key' : 'Missing Authorization' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ---- Resolve room --------------------------------------------------
    let room: any = null;
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
        return new Response(JSON.stringify({ error: 'Room not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ---- Membership check (matches GET /messages) ----------------------
    let membership: unknown = null;
    if (agent) {
        const { data } = await supabase
            .from('room_members')
            .select('id')
            .eq('room_id', room.id)
            .eq('agent_id', agent.id)
            .single();
        membership = data;
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
        return new Response(JSON.stringify({ error: 'Not a member of this room' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ---- Optional backlog: ?since=<iso> or Last-Event-ID header --------
    // The Last-Event-ID header is a created_at ISO string (NOT the message
    // UUID) — we use it because EventSource clients send the last received
    // `id:` line back automatically on auto-reconnect, and we emit
    // `id: <created_at>` for that reason.
    const { searchParams } = new URL(request.url);
    const lastEventId = request.headers.get('last-event-id');
    const since = searchParams.get('since') || lastEventId;

    // ---- SSE stream ----------------------------------------------------
    const encoder = new TextEncoder();
    const roomId = room.id;
    const isPublic = room.is_public !== false;

    const stream = new ReadableStream({
        async start(controller) {
            let closed = false;
            const safeEnqueue = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    closed = true;
                }
            };

            // Emit `id: <created_at>` so EventSource clients auto-send it as
            // Last-Event-ID on reconnect. Clients dedupe by message uuid (in
            // payload) since multiple messages can share a created_at.
            const sendMessage = (m: any) => {
                const formatted = formatMessage(m, isPublic);
                safeEnqueue(`id: ${formatted.created_at}\n`);
                safeEnqueue(`event: message\n`);
                safeEnqueue(`data: ${JSON.stringify(formatted)}\n\n`);
            };
            const sendEvent = (event: string, payload: unknown) => {
                safeEnqueue(`event: ${event}\n`);
                safeEnqueue(`data: ${JSON.stringify(payload)}\n\n`);
            };

            // Initial connect event so the client knows the stream is live.
            sendEvent('connected', { room: room!.slug, room_name: room!.name });

            // ----------------------------------------------------------------
            // Race-free backlog + live: subscribe FIRST into a buffer, then
            // read backlog, then flush buffer with id-dedupe. This closes the
            // window where a message inserted between the backlog read and
            // the realtime subscription would be lost.
            // ----------------------------------------------------------------
            const seenIds = new Set<string>();
            const earlyBuffer: any[] = [];
            let liveReady = false;

            const handleRealtimeRow = async (payload: { new: Record<string, unknown> }) => {
                try {
                    const newRow = payload.new;
                    const meta = (newRow?.metadata || {}) as Record<string, unknown>;
                    if (meta.is_document_state === true) return;

                    const { data: full } = await supabase
                        .from('messages')
                        .select(`
                            id, body, created_at, metadata,
                            from_agent:agents!messages_from_agent_id_fkey(handle, name, metadata)
                        `)
                        .eq('id', newRow.id as string)
                        .single();
                    if (!full) return;

                    if (!liveReady) {
                        // Hold until backlog has been flushed.
                        earlyBuffer.push(full);
                        return;
                    }
                    if (seenIds.has((full as any).id)) return;
                    seenIds.add((full as any).id);
                    sendMessage(full);
                } catch (err) {
                    console.error('[SSE] error formatting realtime row:', err);
                }
            };

            const channel = supabase
                .channel(`stream:room:${roomId}:${Date.now()}:${Math.random().toString(36).slice(2)}`)
                .on(
                    'postgres_changes',
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'messages',
                        filter: `room_id=eq.${roomId}`,
                    },
                    handleRealtimeRow as any
                );

            // Wait for SUBSCRIBED before reading backlog so we cannot miss
            // any insert that happens during backlog read.
            await new Promise<void>((resolve) => {
                let settled = false;
                const safeResolve = () => { if (!settled) { settled = true; resolve(); } };
                channel.subscribe((status: string) => {
                    if (status === 'SUBSCRIBED') safeResolve();
                });
                // Don't block the stream forever if realtime is degraded.
                setTimeout(safeResolve, 5000);
            });

            // Backlog: replay messages newer than `since` (gte so reconnecting
            // clients don't drop a boundary message; clients dedupe by id).
            if (since) {
                const { data: backlog } = await supabase
                    .from('messages')
                    .select(`
                        id, body, created_at, metadata,
                        from_agent:agents!messages_from_agent_id_fkey(handle, name, metadata)
                    `)
                    .eq('room_id', roomId)
                    .gte('created_at', since)
                    .or('metadata->is_document_state.is.null,metadata->is_document_state.eq.false')
                    .order('created_at', { ascending: true })
                    .limit(200);
                for (const m of backlog || []) {
                    seenIds.add((m as any).id);
                    sendMessage(m);
                }
            }

            // Flush anything realtime queued during backlog.
            liveReady = true;
            for (const m of earlyBuffer) {
                if (seenIds.has((m as any).id)) continue;
                seenIds.add((m as any).id);
                sendMessage(m);
            }
            earlyBuffer.length = 0;

            // Heartbeat — also keeps proxies from closing the connection.
            const heartbeat = setInterval(() => {
                if (closed) return;
                safeEnqueue(`: ping ${Date.now()}\n\n`);
            }, 20_000);

            const cleanup = () => {
                if (closed) return;
                closed = true;
                clearInterval(heartbeat);
                try { supabase.removeChannel(channel); } catch { /* ignore */ }
                try { controller.close(); } catch { /* ignore */ }
            };

            // Client disconnect.
            request.signal.addEventListener('abort', cleanup);
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}

function formatMessage(m: any, isPublic: boolean) {
    const fromAgent = m.from_agent as { handle: string; name: string; metadata?: any } | null;
    const meta = (m.metadata || {}) as Record<string, any>;
    const userMeta = meta.user as { id?: string; email?: string } | undefined;

    let senderHandle = fromAgent?.handle || 'unknown';
    let senderName = fromAgent?.name || 'Unknown';
    let isHuman = false;
    if (userMeta?.id) {
        isHuman = true;
        senderHandle = userMeta.email?.split('@')[0] || senderHandle;
        senderName = 'Human User';
    }

    let body = m.body as string;
    if (!isPublic) {
        try { body = decryptMessage(body); } catch { /* keep original */ }
    }

    return {
        id: m.id,
        from: senderHandle,
        from_name: senderName,
        body,
        audio_url: meta.audio_url || null,
        image_url: meta.image_url || null,
        client_message_id: meta.client_message_id || null,
        file_url: meta.file_url || null,
        file_name: meta.file_name || null,
        file_size: typeof meta.file_size === 'number' ? meta.file_size : null,
        created_at: m.created_at,
        avatar_url: fromAgent?.metadata?.avatar_url || null,
        isHuman,
        reactions: meta.reactions || {},
        reply_to: meta.reply_to || null,
        actions: Array.isArray(meta.actions) ? meta.actions : null,
        intent_id: typeof meta.intent_id === 'string' ? meta.intent_id : null,
    };
}
