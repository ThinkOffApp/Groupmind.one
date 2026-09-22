// SPDX-License-Identifier: AGPL-3.0-only
import crypto from 'crypto';
import { getServiceSupabase } from './supabase-service';

export interface AuthenticatedAgent {
    id: string;
    handle: string;
    name?: string;
    metadata?: Record<string, unknown>;
    is_premium?: boolean;
    wallet_address?: string | null;
    /**
     * Scopes attached to the key used to authenticate this request.
     * - `undefined` = legacy agent key (full privileges, backwards compat)
     * - `[]` = key with no scopes (denies all scope checks)
     * - `[...]` = explicit allowlist; format `<resource>:<action>[:<filter>]`
     *   e.g. `messages:write:thinkoff-development`, `*` (catch-all)
     */
    scopes?: string[];
    /** ID of the agent_keys row used, if scoped path. */
    key_id?: string;
    [key: string]: unknown;
}

export function extractApiKey(request: Request): string | null {
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
        const key = authHeader.slice(7).trim();
        return key.length > 0 ? key : null;
    }
    const key = (
        request.headers.get('X-API-Key') ||
        request.headers.get('X-Agent-Key') ||
        ''
    ).trim();
    return key.length > 0 ? key : null;
}

export function hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Look up an agent by API key, checking the scoped `agent_keys` table first
 * and falling back to the legacy `agents.api_key_hash` column for backwards
 * compatibility. Returns null if the key is invalid, revoked, or expired.
 *
 * If the key is found in `agent_keys`, the returned object includes a `scopes`
 * array; if found via the legacy path, `scopes` is undefined (= full access).
 *
 * Also touches `agent_keys.last_used_at` for scoped keys (fire-and-forget).
 */
export async function getAgentByApiKey(
    apiKey: string,
    select = 'id, handle, name, metadata, is_premium'
): Promise<AuthenticatedAgent | null> {
    const supabase = getServiceSupabase();
    const apiKeyHash = hashApiKey(apiKey);

    // Scoped path: check agent_keys first.
    const { data: scopedKey } = await supabase
        .from('agent_keys')
        .select('id, agent_id, scopes, expires_at, revoked_at')
        .eq('api_key_hash', apiKeyHash)
        .maybeSingle();

    if (scopedKey) {
        if (scopedKey.revoked_at) return null;
        if (scopedKey.expires_at && new Date(scopedKey.expires_at) < new Date()) return null;

        const { data: agent, error: agentError } = await supabase
            .from('agents')
            .select(select)
            .eq('id', scopedKey.agent_id)
            .single();
        if (!agent) {
            // A lookup failure (e.g. a select naming a column the `agents`
            // table doesn't have) reads to callers exactly like "no such
            // agent", i.e. a bad key. Log the Supabase error so a schema bug
            // shows up in logs instead of masquerading as invalid auth.
            // Never log the key or its hash.
            if (agentError) console.error('getAgentByApiKey (scoped): agent lookup failed:', agentError.message);
            return null;
        }

        // Fire-and-forget last_used_at touch; do not block the request.
        supabase
            .from('agent_keys')
            .update({ last_used_at: new Date().toISOString() })
            .eq('id', scopedKey.id)
            .then(() => undefined);

        return {
            ...(agent as unknown as AuthenticatedAgent),
            scopes: (scopedKey.scopes as string[]) ?? [],
            key_id: scopedKey.id,
        };
    }

    // Legacy path: agents.api_key_hash, full privileges.
    const { data, error } = await supabase
        .from('agents')
        .select(select)
        .eq('api_key_hash', apiKeyHash)
        .single();
    if (error || !data) {
        // Same masking risk as the scoped path above: an error (bad select,
        // schema drift, etc.) must not look identical to "no matching key".
        // PGRST116 ("no rows") is the ordinary miss every wrong/unknown key
        // produces here and is not logged; any other error code is a real
        // failure (e.g. 42703 undefined column) worth surfacing. Never log
        // the key or its hash.
        if (error && error.code !== 'PGRST116') {
            console.error('getAgentByApiKey (legacy): agent lookup failed:', error.message);
        }
        return null;
    }
    return data as unknown as AuthenticatedAgent;
}

export async function authenticateAgent(
    request: Request,
    select = 'id, handle, name, metadata, is_premium, owner_id'
): Promise<AuthenticatedAgent | null> {
    const apiKey = extractApiKey(request);
    if (!apiKey) return null;
    return getAgentByApiKey(apiKey, select);
}

/**
 * Check whether the given agent's key is permitted to perform an action.
 *
 * @param agent     The authenticated agent (with optional `scopes`).
 * @param required  Required scope, e.g. `messages:write:thinkoff-development`.
 *
 * Match rules:
 * - Legacy key (scopes === undefined): always allowed.
 * - Key with `*` in scopes: always allowed.
 * - Key with exact `resource:action` (no filter): allowed for any filter.
 * - Key with `resource:action:filter`: only allowed if filter matches required's filter.
 */
export function agentHasScope(
    agent: Pick<AuthenticatedAgent, 'scopes'>,
    required: string
): boolean {
    // Legacy keys (undefined scopes) keep full access for backwards compat.
    if (agent.scopes === undefined) return true;
    if (agent.scopes.includes('*')) return true;

    const [reqResource, reqAction, reqFilter] = required.split(':');
    const reqPrefix = `${reqResource}:${reqAction}`;

    for (const scope of agent.scopes) {
        if (scope === required) return true;
        if (scope === reqPrefix) return true; // no-filter scope = all filters
        if (reqFilter && scope.startsWith(`${reqPrefix}:`)) {
            const scopeFilter = scope.slice(reqPrefix.length + 1);
            if (scopeFilter === reqFilter) return true;
        }
    }
    return false;
}
