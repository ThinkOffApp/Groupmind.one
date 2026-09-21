// SPDX-License-Identifier: AGPL-3.0-only
import type { SupabaseClient } from '@supabase/supabase-js';

// Case-insensitive DM recipient resolution.
//
// A user reported: "DMs not working since April that is too much".
// The DM path resolved `to` with `.eq('handle', ...)`, which is
// case-sensitive. Agent handles are stored mixed-case (@claudeMB), humans
// type lowercase (@claudemb), so every such DM 404'd with "Recipient not
// found" — and the last human→agent DM that actually arrived was April 17,
// the day the handle happened to be typed in exact case. A handle is an
// identifier, not prose: resolution must be case-insensitive everywhere.
//
// Matching rules:
// - Case-insensitive lookup via ilike, with % and _ escaped so user input
//   cannot act as a wildcard.
// - If several rows differ only by case (allowed historically), an
//   exact-case match wins; otherwise the first candidate is used, so the
//   result stays deterministic instead of erroring like maybeSingle().
//
// KNOWN SIBLING SITES still doing case-sensitive handle lookups (same bug
// class, listed so they do not stay invisible): watch/devices/route.ts,
// relay-push.ts, relay-identifiers.ts (lowercases input but agents table is
// mixed-case), members/route.ts:234, agents/route.ts:31. Migrate them to
// this helper as they are touched.

function escapeLike(value: string): string {
    return value.replace(/[%_]/g, '\\$&');
}

function pickByCase<T extends { handle: string | null }>(rows: T[], wanted: string): T | null {
    if (rows.length === 0) return null;
    return rows.find(r => r.handle === wanted) || rows[0];
}

export interface ResolvedRecipient {
    agentId: string | null;
    userId: string | null;
}

/**
 * Resolve a DM recipient handle to an agent id or a user id,
 * case-insensitively. Agents win over user profiles, matching the
 * previous resolution order; xfb_user_profiles wins over user_profiles.
 */
export async function resolveRecipient(
    supabase: SupabaseClient,
    to: string
): Promise<ResolvedRecipient> {
    const withAt = to.startsWith('@') ? to : `@${to}`;
    const plain = withAt.replace(/^@/, '');

    const { data: agents } = await supabase
        .from('agents')
        .select('id, handle')
        .ilike('handle', escapeLike(withAt))
        .limit(5);

    const agent = pickByCase((agents || []) as { id: string; handle: string }[], withAt);
    if (agent?.id) {
        return { agentId: agent.id, userId: null };
    }

    const { data: xfbProfiles } = await supabase
        .from('xfb_user_profiles')
        .select('user_id, handle')
        .ilike('handle', escapeLike(plain))
        .limit(5);

    const xfb = pickByCase((xfbProfiles || []) as { user_id: string; handle: string }[], plain);
    if (xfb?.user_id) {
        return { agentId: null, userId: xfb.user_id };
    }

    const { data: userProfiles } = await supabase
        .from('user_profiles')
        .select('user_id, handle')
        .ilike('handle', escapeLike(plain))
        .limit(5);

    const user = pickByCase((userProfiles || []) as { user_id: string; handle: string }[], plain);
    if (user?.user_id) {
        return { agentId: null, userId: user.user_id };
    }

    return { agentId: null, userId: null };
}
