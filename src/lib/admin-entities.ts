// SPDX-License-Identifier: AGPL-3.0-only
import 'server-only';
import { getServiceSupabase } from './supabase-service';

/**
 * Entity counts and recent rows for the unified admin.
 *
 * Ported from the ThinkOff admin (xforbot/src/app/api/admin/route.ts), which
 * has read these same tables for months while this dashboard showed two stat
 * tiles. Same database, same tables — nothing new had to be plumbed, the data
 * was simply never surfaced here.
 *
 * Every query is bounded and every failure is isolated: one unreadable table
 * degrades its own row to an error string instead of blanking the page. An
 * admin view that dies because one count failed is worse than one that says
 * which count failed.
 */

export interface EntityRow {
    key: string;
    label: string;
    /** null when the count could not be read; `error` then says why. */
    total: number | null;
    error?: string;
    /** Rows created in the trailing 7 days, when the table has a timestamp. */
    last7d: number | null;
}

const TABLES: Array<{ key: string; label: string; table: string; ts?: string }> = [
    { key: 'users', label: 'Humans', table: 'xfb_user_profiles', ts: 'created_at' },
    { key: 'agents', label: 'Agents', table: 'agents', ts: 'created_at' },
    { key: 'rooms', label: 'Rooms', table: 'rooms', ts: 'created_at' },
    { key: 'members', label: 'Room members', table: 'room_members', ts: 'joined_at' },
    { key: 'messages', label: 'Messages', table: 'messages', ts: 'created_at' },
    { key: 'leaves', label: 'Leaves', table: 'leaves', ts: 'created_at' },
    { key: 'posts', label: 'Posts', table: 'xfb_posts', ts: 'created_at' },
];

async function countTable(table: string, ts?: string): Promise<{ total: number | null; last7d: number | null; error?: string }> {
    try {
        const sb = getServiceSupabase();
        const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
        if (error) throw error;

        let last7d: number | null = null;
        if (ts) {
            const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
            const { count: recent, error: e2 } = await sb
                .from(table)
                .select('*', { count: 'exact', head: true })
                .gte(ts, since);
            // A missing/renamed timestamp column must not void the total.
            last7d = e2 ? null : recent ?? null;
        }
        return { total: count ?? null, last7d };
    } catch (err) {
        return {
            total: null,
            last7d: null,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/** Counts for every entity the admin covers. Never throws. */
export async function getEntityTotals(): Promise<EntityRow[]> {
    return Promise.all(
        TABLES.map(async t => {
            const { total, last7d, error } = await countTable(t.table, t.ts);
            return { key: t.key, label: t.label, total, last7d, ...(error ? { error } : {}) };
        })
    );
}

export interface RecentAgent {
    id: string;
    handle: string | null;
    name: string | null;
    createdAt: string | null;
    suspended: boolean;
    followers: number | null;
}

/** Most recently created agents. Returns [] rather than throwing. */
export async function getRecentAgents(limit = 10): Promise<RecentAgent[]> {
    try {
        const { data, error } = await getServiceSupabase()
            .from('agents')
            .select('id, handle, name, created_at, is_suspended, followers_count')
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return (data ?? []).map(a => ({
            id: String(a.id),
            handle: a.handle ?? null,
            name: a.name ?? null,
            createdAt: a.created_at ?? null,
            suspended: Boolean(a.is_suspended),
            followers: a.followers_count ?? null,
        }));
    } catch {
        return [];
    }
}
