import { NextResponse } from 'next/server';
import { listOwnedAgentsWithLiveness, resolveOwnerId } from '@/lib/owned-agents';

// GET /api/v1/agents/me/control-status
//
// The remote-drive view of the user's agents (contract v1, 2026-07-16).
// Powers CodeWatch's per-agent live dot + provider badge + "Drive this
// session" button: the button is enabled when remote.connectable is true
// and remote.deeplink is non-null; otherwise the app falls back to the
// send-to-session box (the ide-agent-kit :8788 primitive).
//
// Freshness: the app polls this on room open + a 30-60s interval; agents
// refresh their `remote` block (PUT /agents/me/remote) from the daemon
// heartbeat. Push via relay_events is a planned upgrade, not v1.
//
// Auth: owner web-session or any owner-scoped agent key — identical
// resolution to /agents/me/owned.
export async function GET(request: Request) {
    const ownerId = await resolveOwnerId(request);
    if (!ownerId) {
        return NextResponse.json(
            { error: 'Unauthenticated. Provide X-API-Key / Authorization: Bearer, or a web session.' },
            { status: 401 }
        );
    }

    const result = await listOwnedAgentsWithLiveness(ownerId);
    if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: 500 });
    }

    const agents = result.agents.map((a) => {
        const remote = (a.metadata.remote ?? null) as {
            provider?: string;
            connectable?: boolean;
            deeplink?: string | null;
            machine?: string;
            updated_at?: string;
        } | null;
        return {
            id: a.id,
            handle: a.handle,
            name: a.name,
            live: a.active,
            last_active_at: a.last_active_at,
            remote: remote && typeof remote === 'object'
                ? {
                    provider: remote.provider ?? 'other',
                    connectable: Boolean(remote.connectable),
                    deeplink: typeof remote.deeplink === 'string' ? remote.deeplink : null,
                    ...(remote.machine ? { machine: remote.machine } : {}),
                    updated_at: remote.updated_at ?? null,
                }
                : null,
        };
    });

    return NextResponse.json({ agents, total: agents.length });
}
