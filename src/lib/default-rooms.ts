// SPDX-License-Identifier: AGPL-3.0-only
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Public rooms every NEW user is joined to at account creation, so a fresh
 * sign-up lands in live rooms instead of an empty list. Edit this list to
 * change which rooms new users are prejoined to.
 */
export const DEFAULT_PUBLIC_ROOM_SLUGS = ['codewatch-help', 'codewatch-general'];

/**
 * Join a newly provisioned user to the default public rooms.
 *
 * Called from every first-provisioning path (relay auth, relay CLI auth,
 * mobile google_id_token messages, lazy web profile creation) right after the
 * user_profiles row is created, i.e. once per new account.
 *
 * Membership rows are written with user_id (never agent_id) because that is
 * what the room-list queries match: GET /api/v1/rooms filters
 * room_members.user_id for web session users and unions the owner's user_id
 * rows for agent-key clients, so a user_id row surfaces the room on the web
 * and in the apps alike.
 *
 * Idempotent: re-running for an existing member hits the unique
 * (room_id, user_id) index and the duplicate error is swallowed. Never
 * throws: sign-up must not fail because a courtesy join did. Callers must
 * pass the service-role client (room_members writes bypass RLS server-side,
 * matching every other membership writer in the API routes).
 */
export async function joinDefaultRooms(
    supabase: SupabaseClient,
    userId: string,
): Promise<void> {
    try {
        const { data: rooms, error } = await supabase
            .from('rooms')
            .select('id, slug, is_public')
            .in('slug', DEFAULT_PUBLIC_ROOM_SLUGS);
        if (error) {
            console.error('Default-room lookup failed:', error);
            return;
        }

        // Loud (but non-fatal) signal when a configured slug has no room row:
        // slugs are pinned in code, so a missing/renamed prod room would
        // otherwise degrade into a silent no-op for every new sign-up.
        const foundSlugs = new Set((rooms || []).map(r => r.slug as string));
        const missingSlugs = DEFAULT_PUBLIC_ROOM_SLUGS.filter(slug => !foundSlugs.has(slug));
        if (missingSlugs.length > 0) {
            console.warn(
                `joinDefaultRooms: only ${rooms?.length || 0}/${DEFAULT_PUBLIC_ROOM_SLUGS.length} configured default rooms exist; missing slug(s):`,
                missingSlugs.join(', '),
            );
        }

        for (const room of rooms || []) {
            // Never auto-join a private room, even if a listed slug is
            // (re)created as private by someone else.
            if (!room.is_public) continue;
            // Insert per-row so one duplicate/race never aborts the rest —
            // same pattern as the personal-room member repair. Postgres
            // 23505 (unique_violation) is the expected already-a-member
            // idempotent case, not a failure.
            const { error: memberError } = await supabase
                .from('room_members')
                .insert({ room_id: room.id, user_id: userId });
            if (memberError && memberError.code !== '23505') {
                console.error('Failed to prejoin default room:', room.slug, memberError);
            }
        }
    } catch (error) {
        console.error('joinDefaultRooms failed:', error);
    }
}
