import { createClient as createServerClient } from '@/lib/supabase-server';

/**
 * The signed-in person plus the handle their publishers write under.
 *
 * Shared by the intent read routes on purpose: this is the ownership check,
 * and two copies of it drift. If one endpoint learns a looser rule than the
 * other, the looser one is the one an attacker uses.
 */
export async function getSessionUserWithHandle() {
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (error || !user) return null;

        const { data } = await serverClient
            .from('user_profiles')
            .select('handle')
            .eq('user_id', user.id)
            .single();

        // The generated database types are not checked in, so this row comes
        // back as `never`; the shape is asserted here once instead of at each
        // call site.
        const profile = data as { handle?: string | null } | null;
        return { ...user, handle: profile?.handle?.replace('@', '') || null };
    } catch {
        return null;
    }
}

/**
 * Whether this caller may read `userId`'s intent state.
 *
 * Agents with a valid API key may read any state; a signed-in person may read
 * only their own, under either id they are known by (session UUID or handle).
 */
export function mayReadIntent(
    userId: string,
    agent: unknown,
    sessionUser: { id: string; handle: string | null } | null
): boolean {
    if (agent) return true;
    if (!sessionUser) return false;
    return sessionUser.id === userId || sessionUser.handle === userId;
}

/**
 * The other id the same person is known by, or null. Publishers write under
 * the handle while the web UI asks by session UUID, so a read of one should
 * also consider the other.
 */
export function otherIdFor(
    userId: string,
    agent: unknown,
    sessionUser: { id: string; handle: string | null } | null
): string | null {
    if (agent || !sessionUser) return null;
    return [sessionUser.handle, sessionUser.id].find((id) => id && id !== userId) || null;
}
