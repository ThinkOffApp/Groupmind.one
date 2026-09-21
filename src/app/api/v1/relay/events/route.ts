// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse, after } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { normalizeRelayReplyTarget, normalizeRelaySource } from '@/lib/relay-identifiers';
import { sendRelayPushNotifications } from '@/lib/relay-push';

// Simple in-memory rate limiter: max 30 events per minute per user
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(userId);
    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(userId, { count: 1, resetAt: now + 60_000 });
        return true;
    }
    if (entry.count >= 30) return false;
    entry.count++;
    return true;
}

async function getSessionUserWithHandle() {
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (error || !user) return null;
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

export async function POST(request: Request) {
    try {
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

        let body: Record<string, unknown> | null = null;
        try {
            body = await request.json();
        } catch (e) {
            return NextResponse.json({ error: 'Invalid JSON', detail: String(e) }, { status: 400 });
        }
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid event payload' }, { status: 400 });
        }

        const { user_id, event_type, severity, title, body: eventBody, source, reply_target } = body as Record<string, string>;

        if (!user_id || !title) {
            return NextResponse.json({ error: 'user_id and title are required' }, { status: 400 });
        }

        if (!checkRateLimit(user_id)) {
            return NextResponse.json({ error: 'Rate limit exceeded (30 events/min)' }, { status: 429 });
        }
        const normalizedReplyTarget = normalizeRelayReplyTarget(reply_target);
        const normalizedSource = normalizeRelaySource({
            source,
            eventType: event_type,
            replyTarget: normalizedReplyTarget,
            agentHandle: agent?.handle || null,
        });

        const supabase = getServiceSupabase();
        const { data, error } = await supabase
            .from('relay_events')
            .insert({
                user_id,
                event_type: event_type || 'custom',
                severity: severity || 'info',
                title,
                body: eventBody || null,
                source: normalizedSource,
                reply_target: normalizedReplyTarget,
            })
            .select()
            .single();

        if (error) {
            console.error('Error creating relay event:', error);
            return NextResponse.json({ error: 'Failed to create event' }, { status: 500 });
        }

        // Send push notifications after the response, but attached to the
        // request lifecycle: on serverless a bare fire-and-forget promise can
        // be frozen when the handler returns, silently dropping both the push
        // AND its diagnostic log (codex review, #63). after() keeps it alive.
        after(async () => {
            try {
                const r = await sendRelayPushNotifications(supabase, user_id, {
                    event_id: data.id,
                    title,
                    body: (eventBody || '').slice(0, 300),
                    source: normalizedSource,
                    reply_target: normalizedReplyTarget,
                    event_type: event_type || 'custom',
                    severity: severity || 'info',
                });
                // The {sent, devices} summary is the decisive diagnostic for
                // "push never arrived" reports (claudemm/claudeMB, 2026-07-13):
                // devices=0 -> the device never registered; sent=0 -> FCM rejected.
                console.log(`[RelayPush] event ${data.id} user ${user_id}: devices=${r.devices} sent=${r.sent}`);
            } catch (err) {
                console.warn('[RelayPush] notification dispatch failed:', err);
            }
        });

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        console.error('Error in POST /api/v1/relay/events:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
