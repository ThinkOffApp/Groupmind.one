// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { authenticateAgent } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';

/**
 * DELETE /api/v1/agents/me/keys/{keyId} — revoke a scoped key.
 *
 * Soft-delete: sets `revoked_at` so historical audit trail (which key signed
 * which past request) is preserved. The key returns 401 from any further
 * request immediately.
 *
 * Auth: any active key on the same agent. We do NOT let the key revoke itself
 * via this route if it's the only one (would lock the agent out); callers
 * needing to rotate should mint a new key first, then revoke the old.
 */

type RouteParams = { params: Promise<{ keyId: string }> };

export async function DELETE(request: Request, { params }: RouteParams) {
    const agent = await authenticateAgent(request);
    if (!agent) {
        return NextResponse.json({ error: 'Missing or invalid API key' }, { status: 401 });
    }

    const { keyId } = await params;
    if (!keyId) {
        return NextResponse.json({ error: 'Missing keyId' }, { status: 400 });
    }

    const supabase = getServiceSupabase();

    // Confirm the key belongs to this agent and is not already revoked.
    const { data: key } = await supabase
        .from('agent_keys')
        .select('id, agent_id, revoked_at')
        .eq('id', keyId)
        .maybeSingle();

    if (!key || key.agent_id !== agent.id) {
        return NextResponse.json({ error: 'Key not found' }, { status: 404 });
    }
    if (key.revoked_at) {
        return NextResponse.json({ id: keyId, already_revoked: true });
    }

    // Lockout guard: refuse to revoke the only active scoped key if it's
    // the key being used right now. Caller should mint a new one first.
    if (agent.key_id === keyId) {
        const { data: others } = await supabase
            .from('agent_keys')
            .select('id')
            .eq('agent_id', agent.id)
            .is('revoked_at', null)
            .neq('id', keyId);
        if (!others || others.length === 0) {
            return NextResponse.json(
                {
                    error: 'Cannot revoke the only active key while using it. Mint another scoped key first, or use the legacy agent key to revoke this one.',
                },
                { status: 409 }
            );
        }
    }

    const { error } = await supabase
        .from('agent_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', keyId);

    if (error) {
        return NextResponse.json({ error: 'Failed to revoke key' }, { status: 500 });
    }

    return NextResponse.json({ id: keyId, revoked: true });
}
