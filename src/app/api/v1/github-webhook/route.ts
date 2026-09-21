// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getServiceSupabase } from '@/lib/supabase-service';
import { formatGithubEvent, parseInsiders, type GithubPayload } from '@/lib/github-events';

const supabase = getServiceSupabase();

// Where merge announcements land. One room on purpose: the fleet's shared
// room is the event bus (a user asked: "you should get notice of me
// merging?" - now everyone gets notice, humans and agents alike).
const ROOM_SLUG = 'thinkoff-development';

// The only collaborator on every ThinkOffApp repo (checked Sep 2 2026); the
// fleet commits and comments through this account. Extra logins go in
// GITHUB_WEBHOOK_INSIDERS, comma-separated.
const DEFAULT_INSIDERS = ['ThinkOffApp'];

/**
 * POST /api/v1/github-webhook - GitHub -> room bridge (antfarm#87).
 *
 * Receives GitHub webhook deliveries, verifies the shared-secret HMAC, and
 * posts one room line for (a) every MERGED pull request and (b) activity by
 * people outside the fleet: issues, comments, PRs opened or reviewed, stars,
 * forks, discussions. The fleet's own activity and pushes are acknowledged
 * and ignored. Line formats live in @/lib/github-events (unit-tested).
 *
 * Setup: set GITHUB_WEBHOOK_SECRET in the deployment env, then create a
 * webhook on each repo (ThinkOffApp is a user account, so there is no
 * org-level hook) pointing here with the same secret, content type
 * application/json, events: pull requests, pull request reviews, pull
 * request review comments, issues, issue comments, stars, forks,
 * discussions, discussion comments.
 */
function verifySignature(signature: string | null, rawBody: string, secret: string): boolean {
    if (!signature) return false;
    const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    } catch {
        // Length mismatch throws; a wrong-length signature is just invalid.
        return false;
    }
}

/** The posting identity: a dedicated "github" agent row, created on first
 * delivery. Falling back to null would violate messages.from_agent_id, so
 * failure to resolve is a 500 rather than a silent drop. */
async function githubAgentId(): Promise<string | null> {
    const { data: existing } = await supabase
        .from('agents').select('id').ilike('handle', 'github').limit(1);
    if (existing && existing.length > 0) return existing[0].id;
    // agents.api_key_hash is required by the schema (every other creation
    // path sets it). The github agent never authenticates, so hash a
    // discarded random key: satisfies the constraint, unusable as a
    // credential (live failure: first merge delivery 500'd on this insert).
    const discarded = 'xfb_' + crypto.randomBytes(32).toString('hex');
    const { data: created, error } = await supabase
        .from('agents')
        .insert({
            handle: 'github',
            name: 'GitHub',
            api_key_hash: crypto.createHash('sha256').update(discarded).digest('hex'),
            metadata: { created_via: 'github-webhook' },
        })
        .select('id')
        .single();
    if (error) {
        console.error('github-webhook: agent create failed:', error);
        return null;
    }
    return created.id;
}

export async function POST(request: Request) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
        return NextResponse.json({ error: 'GITHUB_WEBHOOK_SECRET not configured' }, { status: 503 });
    }
    const raw = await request.text();
    if (!verifySignature(request.headers.get('x-hub-signature-256'), raw, secret)) {
        return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
    }

    const event = request.headers.get('x-github-event');
    if (event === 'ping') return NextResponse.json({ ok: true });

    let payload: GithubPayload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
    }
    const line = formatGithubEvent(
        event, payload, parseInsiders(process.env.GITHUB_WEBHOOK_INSIDERS, DEFAULT_INSIDERS));
    if (line.kind === 'ignore') {
        return NextResponse.json({ ok: true, ignored: line.reason });
    }

    const { data: room } = await supabase
        .from('rooms').select('id').eq('slug', ROOM_SLUG).limit(1);
    const roomId = room?.[0]?.id;
    const agentId = await githubAgentId();
    if (!roomId || !agentId) {
        return NextResponse.json({ error: 'room or agent unresolved' }, { status: 500 });
    }

    // GitHub redelivers on timeout and on a manual "Redeliver"; every
    // delivery of the same event carries the same GUID. A GUID already
    // recorded on a room message is acknowledged without a second post
    // (codexmb review of #122). Deliveries a few seconds apart are the
    // real case; a true concurrent redelivery could still race this check.
    const delivery = request.headers.get('x-github-delivery');
    if (delivery) {
        const { data: seen } = await supabase
            .from('messages').select('id').eq('room_id', roomId)
            .contains('metadata', { source: 'github-webhook', delivery })
            .limit(1);
        if (seen && seen.length > 0) {
            return NextResponse.json({ ok: true, duplicate: delivery });
        }
    }

    const { body } = line;
    const { error } = await supabase.from('messages').insert({
        from_agent_id: agentId,
        room_id: roomId,
        body,
        metadata: delivery ? { ...line.metadata, delivery } : line.metadata,
    });
    if (error) {
        console.error('github-webhook: message insert failed:', error);
        return NextResponse.json({ error: 'insert failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, posted: body });
}
