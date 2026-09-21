import type { SupabaseClient, User } from '@supabase/supabase-js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asCleanString(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.trim();
}

function sanitizeHandle(value: string): string {
    return value.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_-]/g, '');
}

function isUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}

async function resolveHandleToAuthUserId(
    supabase: SupabaseClient,
    handle: string
): Promise<string | null> {
    const clean = sanitizeHandle(handle);
    if (!clean) return null;

    const [upRes, xfbRes] = await Promise.all([
        supabase.from('user_profiles').select('user_id').eq('handle', clean).maybeSingle(),
        supabase.from('xfb_user_profiles').select('user_id').eq('handle', clean).maybeSingle(),
    ]);

    return upRes.data?.user_id || xfbRes.data?.user_id || null;
}

async function resolveAuthUserIdToHandle(
    supabase: SupabaseClient,
    authUserId: string
): Promise<string | null> {
    const clean = authUserId.trim().toLowerCase();
    if (!clean) return null;

    const [upRes, xfbRes] = await Promise.all([
        supabase.from('user_profiles').select('handle').eq('user_id', clean).maybeSingle(),
        supabase.from('xfb_user_profiles').select('handle').eq('user_id', clean).maybeSingle(),
    ]);

    const handle = upRes.data?.handle || xfbRes.data?.handle;
    return handle ? sanitizeHandle(handle) : null;
}

export async function expandRelayUserIds(
    supabase: SupabaseClient,
    userId: string
): Promise<string[]> {
    const raw = asCleanString(userId);
    if (!raw) return [];

    const candidates = new Set<string>();
    const lower = raw.toLowerCase();
    const noPrefix = lower.replace(/^@/, '');

    candidates.add(raw);
    candidates.add(lower);
    candidates.add(noPrefix);

    if (lower.includes('@')) {
        const local = sanitizeHandle(lower.split('@')[0] || '');
        if (local) {
            candidates.add(local);
            candidates.add(`@${local}`);
            const authUserId = await resolveHandleToAuthUserId(supabase, local);
            if (authUserId) candidates.add(authUserId.toLowerCase());
        }
    } else if (isUuid(noPrefix)) {
        const handle = await resolveAuthUserIdToHandle(supabase, noPrefix);
        if (handle) {
            candidates.add(handle);
            candidates.add(`@${handle}`);
        }
    } else {
        const handle = sanitizeHandle(noPrefix);
        if (handle) {
            candidates.add(handle);
            candidates.add(`@${handle}`);
            const authUserId = await resolveHandleToAuthUserId(supabase, handle);
            if (authUserId) candidates.add(authUserId.toLowerCase());
        }
    }

    return [...candidates].filter(Boolean);
}

/**
 * Look up an auth user by exact (case-insensitive) email.
 *
 * NOTE: supabase.auth.admin.listUsers accepts ONLY { page, perPage } — there is
 * no `filter` option. Passing `{ filter }` is silently ignored and returns page
 * 1 only, so any user past the first page never resolves. Email lookups must
 * paginate and match explicitly (this is the pattern the rest of the codebase
 * already uses).
 */
export async function findAuthUserByEmail(
    supabase: SupabaseClient,
    email: string
): Promise<User | null> {
    const target = email.trim().toLowerCase();
    if (!target) return null;

    const perPage = 200;
    for (let page = 1; page <= 100; page += 1) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
        if (error) throw error;
        const users = data?.users || [];
        const match = users.find(user => (user.email || '').toLowerCase() === target);
        if (match) return match;
        if (users.length < perPage) break;
    }
    return null;
}

export async function resolveRelayUserIdForDevice(
    supabase: SupabaseClient,
    userId: string
): Promise<string | null> {
    const raw = asCleanString(userId);
    if (!raw) return null;

    const lower = raw.toLowerCase();
    if (isUuid(lower)) return lower;

    if (lower.includes('@')) {
        const emailMatch = await findAuthUserByEmail(supabase, lower);
        if (emailMatch?.id) return emailMatch.id;
    }

    const handleCandidate = lower.includes('@') ? lower.split('@')[0] || '' : lower;
    return resolveHandleToAuthUserId(supabase, handleCandidate);
}

export function normalizeRelayReplyTarget(value: unknown): string | null {
    const clean = asCleanString(value);
    return clean || null;
}

export function normalizeRelaySource(input: {
    source?: unknown;
    eventType?: unknown;
    replyTarget?: unknown;
    agentHandle?: string | null;
}): string {
    const rawSource = asCleanString(input.source);
    const eventType = asCleanString(input.eventType).toLowerCase();
    const replyTarget = normalizeRelayReplyTarget(input.replyTarget);
    const fallback = asCleanString(input.agentHandle).replace(/^@/, '');

    let source = rawSource || fallback || 'unknown';

    if ((source === 'codewatch-app' || source === 'codewatch-cli' || eventType === 'user_message') && replyTarget) {
        source = replyTarget;
    }

    if (source.startsWith('@') && source.indexOf('@', 1) === -1) {
        source = source.slice(1);
    }

    return source || 'unknown';
}

export function deriveRelayChannel(source: unknown, replyTarget: unknown): string {
    const cleanSource = asCleanString(source);
    const cleanReplyTarget = asCleanString(replyTarget);

    if (!cleanSource) return cleanReplyTarget || 'unknown';
    if ((cleanSource === 'codewatch-app' || cleanSource === 'codewatch-cli') && cleanReplyTarget) {
        return cleanReplyTarget;
    }
    return cleanSource;
}
