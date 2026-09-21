import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { authenticateAgent, hashApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';

/**
 * Scoped agent key minting + listing.
 *
 * GET  /api/v1/agents/me/keys  — list this agent's scoped keys (never returns
 *                                the raw key, only id/label/scopes/timestamps).
 * POST /api/v1/agents/me/keys  — mint a new scoped key. The raw key is returned
 *                                ONCE in the response body and never again; the
 *                                server stores only its SHA-256 hash.
 *
 * Auth: any agent key on the agent in question can mint or list. (We could
 * lock minting to keys carrying a `keys:write` scope later; for the MVP any
 * authenticated key for the agent suffices.)
 */

interface MintBody {
    label?: string;
    scopes?: string[];
    expires_at?: string; // ISO 8601, optional
}

function isValidScope(s: unknown): s is string {
    if (typeof s !== 'string') return false;
    if (s === '*') return true;
    // resource:action[:filter] where each segment is non-empty alnum/dash/slash/dot
    return /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*(:[A-Za-z0-9_./-]+)?$/.test(s);
}

export async function GET(request: Request) {
    const agent = await authenticateAgent(request);
    if (!agent) {
        return NextResponse.json({ error: 'Missing or invalid API key' }, { status: 401 });
    }

    const supabase = getServiceSupabase();
    const { data, error } = await supabase
        .from('agent_keys')
        .select('id, label, scopes, expires_at, last_used_at, revoked_at, created_at, created_by')
        .eq('agent_id', agent.id)
        .order('created_at', { ascending: false });

    if (error) {
        return NextResponse.json({ error: 'Failed to list keys' }, { status: 500 });
    }

    return NextResponse.json({ keys: data ?? [] });
}

export async function POST(request: Request) {
    const agent = await authenticateAgent(request);
    if (!agent) {
        return NextResponse.json({ error: 'Missing or invalid API key' }, { status: 401 });
    }

    let body: MintBody;
    try {
        body = (await request.json()) as MintBody;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : null;
    const scopes = Array.isArray(body.scopes) ? body.scopes : [];
    const invalid = scopes.find((s) => !isValidScope(s));
    if (invalid !== undefined) {
        return NextResponse.json(
            { error: `Invalid scope: ${JSON.stringify(invalid)}. Use format "resource:action[:filter]" or "*".` },
            { status: 400 }
        );
    }
    const expiresAt = typeof body.expires_at === 'string' ? body.expires_at : null;
    if (expiresAt && isNaN(Date.parse(expiresAt))) {
        return NextResponse.json({ error: 'Invalid expires_at; must be ISO 8601 or omitted' }, { status: 400 });
    }

    // Mint a new key. Prefix mirrors the convention from agents.register:
    // antfarm_<64-hex>. Kept for backwards compat with existing clients
    // (X-API-Key header check, etc).
    const rawKey = `antfarm_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = hashApiKey(rawKey);

    const supabase = getServiceSupabase();
    const { data, error } = await supabase
        .from('agent_keys')
        .insert({
            agent_id: agent.id,
            api_key_hash: apiKeyHash,
            label,
            scopes,
            expires_at: expiresAt,
            created_by: agent.handle,
        })
        .select('id, label, scopes, expires_at, created_at')
        .single();

    if (error || !data) {
        return NextResponse.json({ error: 'Failed to mint key' }, { status: 500 });
    }

    return NextResponse.json(
        {
            ...data,
            api_key: rawKey,
            warning: 'Save this api_key now. It is shown only once and cannot be recovered.',
        },
        { status: 201 }
    );
}
