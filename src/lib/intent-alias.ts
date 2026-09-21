// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The fleet publishes presence under the user's HANDLE ("alice"), the
 * signed-in web UI reads by the session UUID. GET /api/v1/intent/[userId]
 * already merges the two documents for browser sessions; API-key clients
 * (CodeWatch on the phone, publishers) got only the one document they asked
 * for, so a phone configured with the UUID saw itself and nothing else
 * (a user asked: "Where are all devices?"). This resolves the other
 * id for any caller so the route can merge for API-key reads as well.
 */
import { getServiceSupabase } from './supabase-service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(id: string): boolean {
    return UUID_RE.test(id);
}

export type AliasLookup = {
    /** handle for a user UUID, without '@'; null when unknown */
    handleForUserId(userId: string): Promise<string | null>;
    /** user UUID for a handle (with or without '@'); null when unknown */
    userIdForHandle(handle: string): Promise<string | null>;
};

/**
 * The id the same person is also known by, or null when there is none or it
 * equals the id given. Pure apart from the injected lookups, so it is unit
 * testable without a database.
 */
export async function resolveIntentAlias(userId: string, lookup: AliasLookup): Promise<string | null> {
    const id = userId.trim();
    if (!id) return null;
    const other = isUuid(id)
        ? await lookup.handleForUserId(id)
        : await lookup.userIdForHandle(id.replace(/^@/, ''));
    const cleaned = other?.replace(/^@/, '').trim() || null;
    return cleaned && cleaned !== id ? cleaned : null;
}

/** Lookups against user_profiles with the service client (no RLS, no session). */
export const supabaseAliasLookup: AliasLookup = {
    async handleForUserId(userId) {
        const { data } = await getServiceSupabase()
            .from('user_profiles')
            .select('handle')
            .eq('user_id', userId)
            .maybeSingle();
        const row = data as { handle?: string | null } | null;
        return row?.handle ?? null;
    },
    async userIdForHandle(handle) {
        const { data } = await getServiceSupabase()
            .from('user_profiles')
            .select('user_id')
            .in('handle', [handle, `@${handle}`])
            .limit(1)
            .maybeSingle();
        const row = data as { user_id?: string | null } | null;
        return row?.user_id ?? null;
    },
};
