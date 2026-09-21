// Shared helpers for the "agents owned by this user" surfaces:
// GET /agents/me/owned (full listing) and GET /agents/me/control-status
// (remote-drive view). Extracted from owned/route.ts unchanged so both
// routes shape rows and derive liveness identically.

import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

// agents has NO `status` column in this schema; status lives in metadata.status
// (see /agents/register and /agents/me). Selecting a nonexistent column makes
// PostgREST reject the whole query. So we never project `status` and instead
// derive it from metadata when shaping the response.
export const AGENT_COLUMNS = 'id, handle, name, metadata, created_at';

// An agent counts as `active` if it did anything within this window.
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

// How many recent messages to scan when deriving per-agent last activity.
// One windowed query instead of N per-agent queries; a very chatty agent can
// push a quiet agent's last message out of this window, in which case that
// agent falls back to its key last_used_at (or null = unknown), never a wrong
// timestamp. The `active` (10 min) signal is unaffected for any realistic fleet.
const LIVENESS_MESSAGE_SCAN_LIMIT = 500;

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

// Resolve the owning user for this request. Dual auth, same as the rest of the
// API: an API key maps to its agent.owner_id; otherwise a web session maps to
// the session user's id. agents.owner_id is the user uuid stored as text.
export async function resolveOwnerId(request: Request): Promise<string | null> {
    const apiKey = extractApiKey(request);
    if (apiKey) {
        const agent = await getAgentByApiKey(apiKey, 'id, owner_id');
        const owner = (agent as { owner_id?: string | null } | null)?.owner_id;
        if (owner) return String(owner);
    }
    const user = await getSessionUser();
    return user ? user.id : null;
}

export type ShapedAgent = {
    id: string | null;
    handle: string | null;
    name: string | null;
    status: string;
    metadata: Record<string, unknown>;
    created_at: string | null;
};

// Shape a raw agents row into the API response, deriving status from metadata.
export function shapeAgent(row: unknown): ShapedAgent {
    const a = (row ?? {}) as {
        id?: string;
        handle?: string | null;
        name?: string | null;
        metadata?: Record<string, unknown> | null;
        created_at?: string | null;
    };
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const status = typeof meta.status === 'string' ? meta.status : 'active';
    return {
        id: a.id ?? null,
        handle: a.handle ?? null,
        name: a.name ?? null,
        status,
        metadata: meta,
        created_at: a.created_at ?? null,
    };
}

// Derive per-agent liveness WITHOUT a schema change. Two signals, max wins:
//   1. messages.created_at   - newest message sent by the agent (covers fleet
//      agents that auth via the legacy agents.api_key_hash path, which never
//      touches agent_keys).
//   2. agent_keys.last_used_at - scoped-key auth touch (covers agents that
//      authenticate but rarely post).
// Returns a map of agent id -> ISO timestamp (absent = no signal found).
export async function getLastActiveMap(agentIds: string[]): Promise<Map<string, string>> {
    const lastActive = new Map<string, string>();
    if (agentIds.length === 0) return lastActive;

    const consider = (agentId: unknown, ts: unknown) => {
        if (typeof agentId !== 'string' || typeof ts !== 'string' || !ts) return;
        const prev = lastActive.get(agentId);
        if (!prev || new Date(ts) > new Date(prev)) lastActive.set(agentId, ts);
    };

    const [messagesRes, windowRes, keysRes] = await Promise.all([
        supabase
            .from('messages')
            .select('from_agent_id, created_at')
            .in('from_agent_id', agentIds)
            .order('created_at', { ascending: false })
            .limit(LIVENESS_MESSAGE_SCAN_LIMIT),
        // Dedicated ACTIVE-window query: the global scan above caps at
        // LIVENESS_MESSAGE_SCAN_LIMIT rows ACROSS all owned agents, so one
        // chatty agent could push a genuinely-active sibling out of the cap
        // and flip its `active` to a false negative (codex review, #64).
        // Scanning only the last ACTIVE_WINDOW_MS guarantees any agent that
        // posted within the window is seen, unless the fleet exceeds the cap
        // WITHIN 10 minutes - pathological for this product.
        supabase
            .from('messages')
            .select('from_agent_id, created_at')
            .in('from_agent_id', agentIds)
            .gte('created_at', new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString())
            .order('created_at', { ascending: false })
            .limit(LIVENESS_MESSAGE_SCAN_LIMIT),
        supabase
            .from('agent_keys')
            .select('agent_id, last_used_at')
            .in('agent_id', agentIds)
            .not('last_used_at', 'is', null),
    ]);

    // Liveness is best-effort decoration: log and continue on partial failure
    // rather than failing the whole listing.
    if (messagesRes.error) console.error('owned-agent liveness (messages) error:', messagesRes.error);
    if (windowRes.error) console.error('owned-agent liveness (window) error:', windowRes.error);
    if (keysRes.error) console.error('owned-agent liveness (agent_keys) error:', keysRes.error);

    // Rows come newest-first; consider() keeps the max per agent regardless.
    for (const row of (messagesRes.data ?? []) as { from_agent_id?: string | null; created_at?: string | null }[]) {
        consider(row.from_agent_id, row.created_at);
    }
    for (const row of (windowRes.data ?? []) as { from_agent_id?: string | null; created_at?: string | null }[]) {
        consider(row.from_agent_id, row.created_at);
    }
    for (const row of (keysRes.data ?? []) as { agent_id?: string | null; last_used_at?: string | null }[]) {
        consider(row.agent_id, row.last_used_at);
    }
    return lastActive;
}

// List the user's visible agents decorated with liveness — the shared core of
// /agents/me/owned (GET) and /agents/me/control-status.
export async function listOwnedAgentsWithLiveness(ownerId: string): Promise<
    { agents: (ShapedAgent & { last_active_at: string | null; active: boolean })[] } | { error: string }
> {
    const { data, error } = await supabase
        .from('agents')
        .select(AGENT_COLUMNS)
        .eq('owner_id', ownerId)
        // Only agents the user intentionally paired (not backend/daemon agents
        // that merely have owner_id set for auth scoping). See
        // 20260622_agent_user_visible.sql.
        .eq('user_visible', true)
        .order('handle', { ascending: true });

    if (error) {
        console.error('list owned agents error:', error);
        return { error: 'Failed to list agents' };
    }

    const shaped = (data ?? []).map(shapeAgent);
    const lastActiveMap = await getLastActiveMap(
        shaped.map((a) => a.id).filter((id): id is string => typeof id === 'string')
    );
    const now = Date.now();
    return {
        agents: shaped.map((a) => {
            const lastActiveAt = (a.id && lastActiveMap.get(a.id)) || null;
            return {
                ...a,
                last_active_at: lastActiveAt,
                active: lastActiveAt !== null && now - new Date(lastActiveAt).getTime() <= ACTIVE_WINDOW_MS,
            };
        }),
    };
}
