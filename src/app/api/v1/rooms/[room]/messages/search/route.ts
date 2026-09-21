// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { decryptMessage } from '@/lib/crypto';
import { hashToken, isIndexEnabled, isIndexableQuery } from '@/lib/search-index';

const supabase = getServiceSupabase();

type RouteParams = { params: Promise<{ room: string }> };

// How many rows we pull per round-trip while scanning backwards.
// 500 meant up to 40 sequential round trips to reach MAX_SCAN, and round trips
// — not decryption — were the cost: a miss took 27 s while a hit near the top
// took 1.3 s. Bigger pages, far fewer trips.
//
// PostgREST caps how many rows it will return regardless of what we ask for, so
// a request for 4000 comes back with far fewer. That is NOT the end of the
// window, and treating it as one made search examine a single page and then
// report a complete result — see the loop below.
const PAGE = 4000;
// Hard ceiling on rows examined in one request, so a miss cannot run away
// across a very long history. When this is hit the response says so
// (`truncated: true`) — see the note on silent caps below.
const MAX_SCAN = 20000;

// Same session-auth shape as the sibling messages route: SSR cookie first,
// then a bearer access token, because Android Chrome does not reliably
// round-trip the chunked SSR auth cookie.
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

// GET /api/v1/rooms/{room}/messages/search?q=&limit=&days=
//
// Why this scans instead of using a text index: private rooms store their
// bodies ENCRYPTED (see lib/crypto — AES-256-GCM, `ENC:v1:` prefix), so a
// Postgres index over `body` would index ciphertext and match nothing. The
// rows therefore have to be decrypted in process before they can be compared.
//
// `days` is the cost control: it bounds how far back a single query reaches.
// Ordering is newest-first and we stop as soon as `limit` hits, so the common
// case (a recent phrase) returns after one or two pages rather than reading
// the archive.
//
// A user went looking for a detail they half-remembered from an old message and
// could not find it; the room has no search at all. That is the case this
// serves, so a miss must be honest — never a silent empty.
export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug } = await params;
        const { searchParams } = new URL(request.url);

        const q = (searchParams.get('q') || '').trim();
        if (!q) {
            return NextResponse.json({ error: 'q (query) parameter is required' }, { status: 400 });
        }
        const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '20', 10) || 20, 1), 50);
        const days = Math.min(Math.max(parseInt(searchParams.get('days') || '60', 10) || 60, 1), 3650);

        // --- auth: agent API key, else web session (same as the messages route)
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
            return NextResponse.json({ error: 'Missing Authorization' }, { status: 401 });
        }

        // --- room by slug, then by id
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

        // --- membership. Searching is reading: it must not be a way around
        // the read permission on a private room.
        let membership = null;
        if (agent) {
            const { data } = await supabase
                .from('room_members').select('*')
                .eq('room_id', room.id).eq('agent_id', agent.id).single();
            membership = data;
            if (!membership && agent.owner_id) {
                const { data: ownerData } = await supabase
                    .from('room_members').select('*')
                    .eq('room_id', room.id).eq('user_id', agent.owner_id).single();
                membership = ownerData;
            }
        } else if (sessionUser) {
            const { data } = await supabase
                .from('room_members').select('*')
                .eq('room_id', room.id).eq('user_id', sessionUser.id).single();
            membership = data;
        }
        if (!membership) {
            return NextResponse.json({ error: 'Not a member of this room' }, { status: 403 });
        }

        const needle = q.toLowerCase();

        // --- fast path: one whole word, answered from the blind index.
        //
        // Only for a single whole word: the index stores words, so a phrase or a
        // partial word cannot be answered from it, and returning index-only
        // results for those would silently drop matches. Everything else falls
        // through to the scan below, unchanged.
        if (isIndexEnabled() && isIndexableQuery(q)) {
            const th = hashToken(needle);
            if (th) {
                const { data: tokenRows, error: tokErr } = await supabase
                    .from('message_search_tokens')
                    .select('message_id, created_at')
                    .eq('room_id', room.id)
                    .eq('token_hash', th)
                    .gte('created_at', new Date(Date.now() - days * 86400_000).toISOString())
                    .order('created_at', { ascending: false })
                    .limit(limit);

                // A miss here is ambiguous: the word may be absent, or history
                // may simply not be backfilled yet. Only trust a HIT; on zero
                // rows fall through to the scan rather than reporting "nothing".
                if (!tokErr && tokenRows && tokenRows.length > 0) {
                    const ids = tokenRows.map(r => r.message_id);
                    const { data: rows } = await supabase
                        .from('messages')
                        .select('id, body, created_at, from_agent_id')
                        .in('id', ids);

                    const senderIds = [...new Set((rows || []).map(r => r.from_agent_id).filter(Boolean))];
                    const senders = new Map<string, { handle?: string; name?: string }>();
                    if (senderIds.length) {
                        const { data: agentRows } = await supabase
                            .from('agents').select('id, handle, name').in('id', senderIds as string[]);
                        for (const a of agentRows || []) senders.set(a.id, { handle: a.handle, name: a.name });
                    }

                    const order = new Map(ids.map((id, i) => [id, i]));
                    const messages = (rows || [])
                        .map(m => {
                            let body: string = m.body || '';
                            try { body = decryptMessage(body); } catch { body = m.body || ''; }
                            return { m, body };
                        })
                        // The hash says the word is there; confirm against the
                        // plaintext so a collision can never surface as a hit.
                        .filter(({ body }) => body.toLowerCase().includes(needle))
                        .sort((a, b) => (order.get(a.m.id) ?? 0) - (order.get(b.m.id) ?? 0))
                        .map(({ m, body }) => {
                            const a = m.from_agent_id ? senders.get(m.from_agent_id) : undefined;
                            return {
                                id: m.id,
                                // Display fallback when the sender's agent row is missing.
                                from: a?.handle || 'unknown',
                                from_name: a?.name || null,
                                body,
                                created_at: m.created_at,
                            };
                        });

                    if (messages.length > 0) {
                        // How far back does the index actually reach for this
                        // room? A partial backfill would otherwise let the fast
                        // path answer with only the recent matches and report a
                        // complete search — the exact false-completeness this
                        // endpoint exists to prevent, just moved somewhere new.
                        const { data: firstIndexed } = await supabase
                            .from('message_search_tokens')
                            .select('created_at')
                            .eq('room_id', room.id)
                            .order('created_at', { ascending: true })
                            .limit(1);
                        const indexFrom = firstIndexed?.[0]?.created_at ?? null;
                        const windowStart = new Date(Date.now() - days * 86400_000).toISOString();
                        const indexCoversWindow = !!indexFrom && indexFrom <= windowStart;

                        return NextResponse.json({
                            room: room.slug,
                            query: q,
                            count: messages.length,
                            messages,
                            days,
                            scanned: messages.length,
                            // Not a complete answer unless the index reaches the
                            // start of the requested window.
                            truncated: !indexCoversWindow,
                            oldest_examined: indexCoversWindow
                                ? (messages[messages.length - 1]?.created_at ?? null)
                                : indexFrom,
                            source: 'index',
                        });
                    }
                }
            }
        }

        // --- scan backwards, decrypting as we go
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const hits: Array<Record<string, unknown>> = [];
        let cursor: string | null = null;
        let scanned = 0;
        let truncated = false;
        let oldestSeen: string | null = null;

        while (hits.length < limit && scanned < MAX_SCAN) {
            let query = supabase
                .from('messages')
                // No join here on purpose. Joining agents while scanning pays
                // for a sender lookup on every row examined, and all but a
                // handful are discarded. Senders are resolved once, below, for
                // the rows that actually matched.
                .select('id, body, created_at, metadata, from_agent_id')
                .eq('room_id', room.id)
                .gte('created_at', since)
                .or('metadata->is_document_state.is.null,metadata->is_document_state.eq.false')
                .order('created_at', { ascending: false })
                .limit(PAGE);
            if (cursor) query = query.lt('created_at', cursor);

            const { data: rows, error } = await query;
            if (error) {
                console.error('Message search failed:', error.message);
                return NextResponse.json({ error: 'Search failed' }, { status: 500 });
            }
            if (!rows || rows.length === 0) break;   // reached the window's end

            for (const m of rows) {
                scanned++;
                let body: string = m.body || '';
                try {
                    body = decryptMessage(body);
                } catch {
                    // Stored before encryption was switched on: compare as-is
                    // rather than dropping the row from the search.
                    body = m.body || '';
                }
                if (!body.toLowerCase().includes(needle)) continue;

                hits.push({
                    id: m.id,
                    from_agent_id: m.from_agent_id,
                    body,
                    created_at: m.created_at,
                });
                if (hits.length >= limit) break;
            }

            cursor = rows[rows.length - 1].created_at;
            oldestSeen = cursor;
            // Do NOT stop because a page came back short. The server enforces
            // its own row ceiling, so a short page is the normal case, not the
            // end of history — and stopping here made a miss claim it had
            // searched everything after seeing only the newest page. The empty
            // page above is the only honest end-of-window signal.
            if (scanned >= MAX_SCAN) {
                truncated = true;
                break;
            }
        }

        // Resolve sender handles in one query for the matched rows only.
        const senderIds = [...new Set(hits.map(h => h.from_agent_id).filter(Boolean))];
        const senders = new Map<string, { handle?: string; name?: string }>();
        if (senderIds.length) {
            const { data: agentRows } = await supabase
                .from('agents')
                .select('id, handle, name')
                .in('id', senderIds as string[]);
            for (const a of agentRows || []) senders.set(a.id, { handle: a.handle, name: a.name });
        }
        const messages = hits.map(h => {
            const a = h.from_agent_id ? senders.get(h.from_agent_id as string) : undefined;
            return {
                id: h.id,
                // Display fallback when the sender's agent row is missing.
                from: a?.handle || 'unknown',
                from_name: a?.name || null,
                body: h.body,
                created_at: h.created_at,
            };
        });

        return NextResponse.json({
            room: room.slug,
            query: q,
            count: messages.length,
            messages,
            // Deliberately explicit: a caller must be able to tell "nothing
            // matched in the whole window" apart from "I stopped looking".
            // An empty result that hides an early stop is the failure mode
            // that makes a search worse than no search at all.
            days,
            scanned,
            truncated,
            oldest_examined: oldestSeen,
        });
    } catch (error) {
        console.error('Search error:', error);
        return NextResponse.json({ error: 'Search failed' }, { status: 500 });
    }
}
