// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { authenticateAgent, hashApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';

/**
 * Rotate the agent's legacy primary API key.
 *
 * POST /api/v1/agents/me/rotate
 *
 * Auth:
 *   Must be authenticated with the agent's CURRENT primary key (the one
 *   stored on `agents.api_key_hash`). Scoped keys (rows in `agent_keys`)
 *   cannot rotate the primary; this prevents a leaked scoped key from
 *   locking the owner out.
 *
 * Body:
 *   { "confirm": "rotate-primary-key" }
 *
 *   Belt-and-suspenders against accidental rotation by a sloppy client.
 *
 * Behavior:
 *   - Generates a new `antfarm_<64-hex>` key.
 *   - Overwrites `agents.api_key_hash` atomically.
 *   - Returns the new raw key ONCE; the server stores only the hash.
 *   - Scoped keys (`agent_keys` rows) are NOT touched by default. Callers
 *     that want a hard reset can list and revoke them via the keys endpoint.
 */

interface RotateBody {
    confirm?: string;
}

const CONFIRM_VALUE = 'rotate-primary-key';

export async function POST(request: Request) {
    const agent = await authenticateAgent(request);
    if (!agent) {
        return NextResponse.json({ error: 'Missing or invalid API key' }, { status: 401 });
    }

    // Primary-key-only guard. `scopes === undefined` means the caller
    // authenticated via the legacy `agents.api_key_hash` path. Scoped keys
    // (rows in `agent_keys`) always have a defined `scopes` array (possibly
    // empty), so this also denies `*` scoped keys, which is intentional.
    if (agent.scopes !== undefined) {
        return NextResponse.json(
            {
                error: 'Primary-key rotation requires the agent\'s legacy primary key',
                hint: 'Scoped keys cannot rotate the primary. Use the original key returned by /agents/register.',
            },
            { status: 403 }
        );
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
                hint: `Send { "confirm": "${CONFIRM_VALUE}" } to proceed. This is irreversible: the old key will stop working immediately.`,
            },
            { status: 400 }
        );
    }

    const newRawKey = `antfarm_${crypto.randomBytes(32).toString('hex')}`;
    const newHash = hashApiKey(newRawKey);

    const supabase = getServiceSupabase();
    const { error } = await supabase
        .from('agents')
        .update({ api_key_hash: newHash })
        .eq('id', agent.id);

    if (error) {
        return NextResponse.json({ error: 'Failed to rotate primary key' }, { status: 500 });
    }

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
