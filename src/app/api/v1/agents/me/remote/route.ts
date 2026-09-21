// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { validateDeeplink } from '@/lib/deeplink';

const supabase = getServiceSupabase();

// Remote-drive registration (contract v1, 2026-07-16): each agent's IAK
// daemon reports how its live session can be driven from the phone. Stored
// in agents.metadata.remote (no schema change), read back by the owner via
// GET /agents/me/control-status. Same GET/PUT shape as /agents/me/webhook.

const PROVIDERS = new Set(['claude', 'codex', 'gemini', 'other']);
const MAX_MACHINE_LENGTH = 100;

type RemoteInfo = {
    provider: string;
    connectable: boolean;
    deeplink: string | null;
    machine?: string;
    updated_at: string;
};

// GET - the agent's own current remote registration
export async function GET(request: Request) {
    const apiKey = extractApiKey(request);
    if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const agent = await getAgentByApiKey(apiKey, 'id, handle, metadata');
    if (!agent) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });

    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    return NextResponse.json({
        handle: agent.handle,
        remote: (meta.remote as RemoteInfo | undefined) ?? null,
    });
}

// PUT - register/refresh remote-drive info. Body:
//   provider    (required: claude|codex|gemini|other)
//   connectable (required boolean: is there a session the provider app can drive)
//   deeplink    (optional string|null: link the app opens to drive the session;
//                null/absent = headless -> CodeWatch falls back to send-to-session)
//   machine     (optional string: human-readable host name)
// Called from the daemon's liveness heartbeat, so registrations stay fresh
// without a dedicated scheduler.
export async function PUT(request: Request) {
    const apiKey = extractApiKey(request);
    if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const agent = await getAgentByApiKey(apiKey, 'id, handle, metadata');
    if (!agent) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const provider = typeof body.provider === 'string' ? body.provider.toLowerCase().trim() : '';
    if (!PROVIDERS.has(provider)) {
        return NextResponse.json(
            { error: `provider must be one of: ${[...PROVIDERS].join(', ')}` },
            { status: 400 }
        );
    }
    if (typeof body.connectable !== 'boolean') {
        return NextResponse.json({ error: 'connectable must be a boolean' }, { status: 400 });
    }
    let deeplink: string | null = null;
    if (body.deeplink !== undefined && body.deeplink !== null) {
        // Security boundary: the value becomes a tappable button in the app,
        // so schemes are an exact allowlist (no intent://, file://, etc.).
        // See @/lib/deeplink for the list and rationale.
        const verdict = validateDeeplink(body.deeplink);
        if (!verdict.ok) {
            return NextResponse.json({ error: verdict.error }, { status: 400 });
        }
        deeplink = verdict.url;
    }
    let machine: string | undefined;
    if (body.machine !== undefined) {
        if (typeof body.machine !== 'string' || body.machine.length > MAX_MACHINE_LENGTH) {
            return NextResponse.json(
                { error: `machine must be a string of at most ${MAX_MACHINE_LENGTH} characters` },
                { status: 400 }
            );
        }
        machine = body.machine;
    }

    const remote: RemoteInfo = {
        provider,
        connectable: Boolean(body.connectable),
        deeplink,
        ...(machine ? { machine } : {}),
        updated_at: new Date().toISOString(),
    };

    const mergedMeta = { ...((agent.metadata ?? {}) as Record<string, unknown>), remote };
    const { error } = await supabase
        .from('agents')
        .update({ metadata: mergedMeta })
        .eq('id', agent.id);

    if (error) {
        console.error('remote registration update error:', error);
        return NextResponse.json({ error: 'Failed to save remote registration' }, { status: 500 });
    }

    return NextResponse.json({ handle: agent.handle, remote });
}
