// Aggregated usage stats for the /admin dashboard.
// Service-role only — never import from client components.
//
// PII proportionality: the whole admin sits behind ONE shared password (see
// admin-auth.ts for the accepted tradeoff), so this module never hands full
// emails to any view — they are masked at the data layer (maskEmail) — and
// the auth.users pass is capped at LIST_USERS_MAX_PAGES pages.

import 'server-only';
import { getServiceSupabase } from './supabase-service';
import type { AppStats } from './admin-apps';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_USERS_PER_PAGE = 1000;
const LIST_USERS_MAX_PAGES = 5; // 5k users cap for the in-memory pass
const TOP_ROOMS_SAMPLE_MAX = 10000; // cap on 7d messages scanned for the top-rooms ranking
const ACTIVE_ROOMS_SAMPLE_MAX = 5000; // cap on 24h messages scanned for the active-rooms count

// METRICS PURITY: scratchpad/document autosave snapshots live in the SAME
// messages table, flagged with the `metadata.is_document_state` marker. The
// room API hides them from chat with exactly this PostgREST filter (see
// src/app/api/v1/rooms/[room]/messages/route.ts), and every message metric
// below must apply it too — otherwise each document keystroke-autosave
// inflates message counts, the per-day chart, active rooms and the top-rooms
// ranking. `is.null` also covers rows with no metadata at all.
const NOT_DOCUMENT_STATE =
    'metadata->is_document_state.is.null,metadata->is_document_state.eq.false';

export interface DailyCount {
    /** ISO date (UTC), e.g. "2026-07-13" */
    date: string;
    count: number;
}

export interface RecentUser {
    id: string;
    /** Masked (first-char***@domain) — full emails never leave this module. */
    email: string | null;
    handle: string | null;
    createdAt: string;
    lastSignInAt: string | null;
}

export interface TopRoom {
    roomId: string;
    name: string;
    slug: string;
    messages7d: number;
}

export interface AdminStats {
    totalUsers: number;
    totalAgents: number;
    totalRooms: number;
    signupsPerDay: DailyCount[]; // last 30 days, oldest first
    messagesPerDay: DailyCount[]; // last 30 days, oldest first
    messages30d: number;
    messages7d: number;
    topRooms: TopRoom[]; // top 10 by messages in last 7 days
    topRoomsSampleTruncated: boolean;
    recentUsers: RecentUser[]; // newest first
    generatedAt: string;
}

/** UTC midnight `daysAgo` days before now. */
function utcDayStart(daysAgo: number): Date {
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return new Date(todayUtc - daysAgo * DAY_MS);
}

function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

interface AuthUserLite {
    id: string;
    email: string | null;
    created_at: string;
    last_sign_in_at: string | null;
}

/**
 * Mask an email for display: first char + "***@" + domain. Admin views only
 * ever receive masked emails (shared-password gate = keep PII minimal).
 */
export function maskEmail(email: string | null): string | null {
    if (!email) return null;
    const at = email.indexOf('@');
    if (at <= 0) return '***';
    return `${email[0]}***@${email.slice(at + 1)}`;
}

/**
 * Page through auth.users via the GoTrue admin API (no direct SQL access to
 * the auth schema through PostgREST). Returns the users plus the exact total
 * reported by GoTrue's pagination headers.
 */
async function fetchAuthUsers(): Promise<{ users: AuthUserLite[]; total: number }> {
    const supabase = getServiceSupabase();
    const users: AuthUserLite[] = [];
    let total = 0;

    for (let page = 1; page <= LIST_USERS_MAX_PAGES; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({
            page,
            perPage: LIST_USERS_PER_PAGE,
        });
        if (error) throw error;

        const batch = data.users ?? [];
        for (const u of batch) {
            users.push({
                id: u.id,
                email: u.email ?? null,
                created_at: u.created_at,
                last_sign_in_at: u.last_sign_in_at ?? null,
            });
        }
        if (typeof data.total === 'number' && data.total > 0) {
            total = data.total;
        }
        if (batch.length < LIST_USERS_PER_PAGE) break;
    }

    if (total < users.length) total = users.length;
    return { users, total };
}

type CountQuery = ReturnType<
    ReturnType<ReturnType<typeof getServiceSupabase>['from']>['select']
>;

/** Exact row count via a HEAD request (SQL count(*), no rows transferred). */
async function countRows(
    table: string,
    filter?: (q: CountQuery) => CountQuery
): Promise<number> {
    const supabase = getServiceSupabase();
    let query: CountQuery = supabase.from(table).select('*', { count: 'exact', head: true });
    if (filter) query = filter(query);
    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
}

/** Per-day message counts for the last `days` days (one HEAD count per day). */
async function messagesPerDay(days: number): Promise<DailyCount[]> {
    const jobs = [];
    for (let i = days - 1; i >= 0; i--) {
        const start = utcDayStart(i);
        const end = new Date(start.getTime() + DAY_MS);
        jobs.push(
            countRows('messages', q =>
                q
                    .gte('created_at', start.toISOString())
                    .lt('created_at', end.toISOString())
                    .or(NOT_DOCUMENT_STATE)
            ).then(count => ({ date: isoDate(start), count }))
        );
    }
    return Promise.all(jobs);
}

/** Bucket signups per day (last `days` days) from the fetched auth users. */
function signupsPerDay(users: AuthUserLite[], days: number): DailyCount[] {
    const buckets = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
        buckets.set(isoDate(utcDayStart(i)), 0);
    }
    const windowStart = utcDayStart(days - 1).getTime();
    for (const u of users) {
        const t = new Date(u.created_at).getTime();
        if (Number.isNaN(t) || t < windowStart) continue;
        const key = isoDate(new Date(Math.floor(t / DAY_MS) * DAY_MS));
        if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return Array.from(buckets, ([date, count]) => ({ date, count }));
}

/**
 * Top rooms by message volume over the last 7 days. PostgREST does not expose
 * GROUP BY, so we page over (room_id) tuples and aggregate in memory, capped
 * at TOP_ROOMS_SAMPLE_MAX rows (most recent first).
 */
async function topRoomsLast7d(): Promise<{ rooms: TopRoom[]; truncated: boolean }> {
    const supabase = getServiceSupabase();
    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const counts = new Map<string, number>();
    const pageSize = 1000;
    let from = 0;
    let truncated = false;

    while (from < TOP_ROOMS_SAMPLE_MAX) {
        const { data, error } = await supabase
            .from('messages')
            .select('room_id')
            .gte('created_at', since)
            .not('room_id', 'is', null)
            .or(NOT_DOCUMENT_STATE) // exclude scratchpad/document autosave rows
            .order('created_at', { ascending: false })
            .range(from, from + pageSize - 1);
        if (error) throw error;

        const rows = (data ?? []) as { room_id: string }[];
        for (const row of rows) {
            counts.set(row.room_id, (counts.get(row.room_id) ?? 0) + 1);
        }
        if (rows.length < pageSize) break;
        from += pageSize;
        if (from >= TOP_ROOMS_SAMPLE_MAX) truncated = true;
    }

    const top = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    if (top.length === 0) return { rooms: [], truncated };

    const { data: roomRows, error: roomsError } = await supabase
        .from('rooms')
        .select('id, name, slug')
        .in('id', top.map(([id]) => id));
    if (roomsError) throw roomsError;

    const byId = new Map((roomRows ?? []).map(r => [r.id as string, r]));
    const rooms = top.map(([roomId, messages7d]) => {
        const room = byId.get(roomId);
        return {
            roomId,
            name: (room?.name as string) ?? '(deleted room)',
            slug: (room?.slug as string) ?? roomId.slice(0, 8),
            messages7d,
        };
    });
    return { rooms, truncated };
}

/** Attach user_profiles.handle to the recent-users rows. */
async function attachHandles(users: AuthUserLite[]): Promise<RecentUser[]> {
    const supabase = getServiceSupabase();
    const ids = users.map(u => u.id);
    const handles = new Map<string, string>();
    if (ids.length > 0) {
        const { data } = await supabase
            .from('user_profiles')
            .select('user_id, handle')
            .in('user_id', ids);
        for (const row of data ?? []) {
            if (row.handle) handles.set(row.user_id as string, row.handle as string);
        }
    }
    return users.map(u => ({
        id: u.id,
        email: maskEmail(u.email),
        handle: handles.get(u.id) ?? null,
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at,
    }));
}

/**
 * Distinct rooms with at least one message in the last 24h, sampled from the
 * most recent ACTIVE_ROOMS_SAMPLE_MAX messages (PostgREST has no DISTINCT).
 */
async function activeRooms24h(): Promise<number> {
    const supabase = getServiceSupabase();
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const ids = new Set<string>();
    const pageSize = 1000;

    for (let from = 0; from < ACTIVE_ROOMS_SAMPLE_MAX; from += pageSize) {
        const { data, error } = await supabase
            .from('messages')
            .select('room_id')
            .gte('created_at', since)
            .not('room_id', 'is', null)
            .or(NOT_DOCUMENT_STATE) // exclude scratchpad/document autosave rows
            .order('created_at', { ascending: false })
            .range(from, from + pageSize - 1);
        if (error) throw error;
        const rows = (data ?? []) as { room_id: string }[];
        for (const row of rows) ids.add(row.room_id);
        if (rows.length < pageSize) break;
    }
    return ids.size;
}

/**
 * Cheap headline numbers for the unified /admin overview card (GroupMind /
 * CodeWatch entry in src/lib/admin-apps.ts). Full dashboard: getAdminStats().
 */
export async function getGroupMindHeadline(): Promise<AppStats> {
    const sevenDaysAgoMs = Date.now() - 7 * DAY_MS;
    const dayAgo = new Date(Date.now() - DAY_MS).toISOString();

    const [{ users, total: totalUsers }, messages24h, rooms24h] = await Promise.all([
        fetchAuthUsers(),
        countRows('messages', q => q.gte('created_at', dayAgo).or(NOT_DOCUMENT_STATE)),
        activeRooms24h(),
    ]);

    // Approximate beyond the pagination cap (exact for < 5k users).
    const newUsers7d = users.filter(u => {
        const t = new Date(u.created_at).getTime();
        return !Number.isNaN(t) && t >= sevenDaysAgoMs;
    }).length;

    return {
        headline: [
            { label: 'Users', value: totalUsers },
            { label: 'New users (7d)', value: newUsers7d },
            { label: 'Messages (24h)', value: messages24h },
            { label: 'Active rooms (24h)', value: rooms24h },
        ],
        generatedAt: new Date().toISOString(),
    };
}

export async function getAdminStats(): Promise<AdminStats> {
    const thirtyDaysAgo = utcDayStart(29).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS).toISOString();

    const [
        { users, total: totalUsers },
        totalAgents,
        totalRooms,
        msgsPerDay,
        messages30d,
        messages7d,
        { rooms: topRooms, truncated: topRoomsSampleTruncated },
    ] = await Promise.all([
        fetchAuthUsers(),
        countRows('agents'),
        countRows('rooms'),
        messagesPerDay(30),
        countRows('messages', q => q.gte('created_at', thirtyDaysAgo).or(NOT_DOCUMENT_STATE)),
        countRows('messages', q => q.gte('created_at', sevenDaysAgo).or(NOT_DOCUMENT_STATE)),
        topRoomsLast7d(),
    ]);

    const newestFirst = [...users].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const recentUsers = await attachHandles(newestFirst.slice(0, 15));

    return {
        totalUsers,
        totalAgents,
        totalRooms,
        signupsPerDay: signupsPerDay(users, 30),
        messagesPerDay: msgsPerDay,
        messages30d,
        messages7d,
        topRooms,
        topRoomsSampleTruncated,
        recentUsers,
        generatedAt: new Date().toISOString(),
    };
}
