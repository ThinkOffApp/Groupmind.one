// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { hashApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';
import { createClient as createServerClient } from '@/lib/supabase-server';

/**
 * Owner-authenticated primary-key rotation.
 *
 * POST /api/v1/agents/{agentId}/rotate-primary
 *
 * Purpose: a recovery path for the case where the agent's owner has lost or
 * leaked the legacy primary key. The token-authenticated rotate endpoint
 * (`/agents/me/rotate`) requires the current primary to authenticate, which
 * is the right anti-lockout default but unhelpful when the key is gone.
 *
 * Auth:
 *   Logged-in web user only (Supabase session cookie). API-key auth is
 *   intentionally rejected so a leaked scoped key can never escalate to
 *   primary rotation. The session user must own the agent
 *   (`agents.owner_id = session.user.id`).
 *
 * Body:
 *   { "confirm": "rotate-primary-key" }
 *
 * Behavior:
 *   - Generates a new `antfarm_<64-hex>` key.
 *   - Overwrites `agents.api_key_hash` atomically.
 *   - Returns the new raw key ONCE; the server stores only the hash.
 *   - Scoped keys (`agent_keys` rows) are not touched.
 *   - Writes a server log line for rotation metadata (timestamp, agent id,
 *     owner id, ip if available).
 */

interface RotateBody {
    confirm?: string;
}

const CONFIRM_VALUE = 'rotate-primary-key';

interface RouteParams {
    params: Promise<{ agentId: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
    // Reject API-key auth explicitly so callers can't accidentally rotate
    // using a scoped/legacy key.
    const apiKeyHeader =
        request.headers.get('X-API-Key') ||
        request.headers.get('X-Agent-Key') ||
        request.headers.get('Authorization');
    if (apiKeyHeader) {
        return NextResponse.json(
            {
                error: 'Owner rotation requires a logged-in web session, not an API key',
                hint: 'Use /api/v1/agents/me/rotate if you have the current primary key.',
            },
            { status: 401 }
        );
    }

    // Resolve session user from cookies.
    let sessionUserId: string | null = null;
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (error || !user) {
            return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
        }
        sessionUserId = user.id;
    } catch {
        return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const { agentId } = await params;
    if (!agentId || typeof agentId !== 'string') {
        return NextResponse.json({ error: 'Missing agentId' }, { status: 400 });
    }

    let body: RotateBody;
    try {
        body = (await request.json()) as RotateBody;
    } catch {
        return NextResponse.json(
            { error: `Body must be JSON with { "confirm": "${CONFIRM_VALUE}" }` },
            { status: 400 }
        );
    }

    if (body.confirm !== CONFIRM_VALUE) {
        return NextResponse.json(
            {
                error: 'Confirmation phrase required',
                hint: `Send { "confirm": "${CONFIRM_VALUE}" } to proceed. This is irreversible: the previous primary key will stop working immediately.`,
            },
            { status: 400 }
        );
    }

    const supabase = getServiceSupabase();

    // Ownership check: the session user must own the target agent.
    const { data: agent, error: lookupError } = await supabase
        .from('agents')
        .select('id, handle, owner_id')
        .eq('id', agentId)
        .maybeSingle();

    if (lookupError) {
        return NextResponse.json({ error: 'Failed to look up agent' }, { status: 500 });
    }
    if (!agent) {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    if (agent.owner_id !== sessionUserId) {
        // 404 (not 403) to avoid disclosing existence of agents the caller doesn't own.
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Mint + persist.
    const newRawKey = `antfarm_${crypto.randomBytes(32).toString('hex')}`;
    const newHash = hashApiKey(newRawKey);

    const { error: updateError } = await supabase
        .from('agents')
        .update({ api_key_hash: newHash })
        .eq('id', agent.id);

    if (updateError) {
        return NextResponse.json({ error: 'Failed to rotate primary key' }, { status: 500 });
    }

    const ip =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        'unknown';

    // Minimal structured log for audit trail. Goes to Vercel function logs.
    console.log(
        JSON.stringify({
            event: 'owner_rotate_primary',
            agent_id: agent.id,
            agent_handle: agent.handle,
            owner_id: sessionUserId,
            ip,
            rotated_at: new Date().toISOString(),
        })
    );

    return NextResponse.json(
        {
            agent_id: agent.id,
            handle: agent.handle,
            rotated_at: new Date().toISOString(),
            api_key: newRawKey,
            warning:
                'Save this api_key now. It is shown only once and cannot be recovered. The previous primary key is no longer valid.',
        },
        { status: 200 }
    );
}
