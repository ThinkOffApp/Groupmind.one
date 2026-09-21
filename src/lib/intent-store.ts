import { after } from 'next/server';
import { getServiceSupabase } from './supabase-service';
import { WEB_USER_AGENT_ID } from './web-agent';
import { foldFleetSnapshot, foldStaleIds, isFresher, mergeSlotMaps } from './fleet-roster';

const INTENT_ROOM_SLUG = 'intent-kernel-state';
const INTENT_ROOM_NAME = 'Intent Kernel State';
const SCHEMA_VERSION = 1;

const DEFAULT_DEVICE_TTL_SEC = 90;
const DEFAULT_AGENT_TTL_SEC = 300;

// Canonical intent user id. Presence broke because daemons posted under
// "alice" while the app read "@alice" - two documents for one person
// (a user reported: "we need to get UIK working for real"). Canonical form
// strips a leading @ but PRESERVES case: lowercasing would let two
// case-distinct handles collapse into one document and cross-read each
// other's state (codexmb, PR #92 review P1). Reads also check the legacy
// "@"-prefixed variant so existing documents are never orphaned.
function canonicalUserId(userId: string): string {
    return (userId || '').trim().replace(/^@+/, '');
}

// The stored keys a person's document might live under: the canonical
// (no @) form written from now on, plus the legacy "@" form older writes
// used. Reads try both so no preferences/quiet-hours are lost during the
// transition (codexmb, PR #92 review P1 migration).
function userIdVariants(userId: string): string[] {
    const canonical = canonicalUserId(userId);
    return canonical.startsWith('@') ? [canonical] : [canonical, '@' + canonical];
}

let cachedIntentRoomId: string | null = null;

type SlotType = 'device' | 'agent';

type StoredSlot = {
    slot_type: SlotType;
    slot_id: string;
    state: Record<string, unknown>;
    updated_at: string;
    source_device: string;
    ttl_sec: number;
};

type StoredProfile = {
    personal?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
    agent_prefs?: Record<string, unknown>;
};

function generateInviteCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
}

function normalizeTimestamp(value: unknown, fallback: string) {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
        return value;
    }
    return fallback;
}

function normalizeNumber(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getNowIso() {
    return new Date().toISOString();
}

function isStale(updatedAt: string, ttlSec: number, nowMs: number) {
    const updatedMs = Date.parse(updatedAt);
    if (Number.isNaN(updatedMs)) return true;
    return nowMs - updatedMs > ttlSec * 1000;
}

function getMinutesInTimezone(now: Date, timezone: string) {
    const dtf = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = dtf.formatToParts(now);
    const hour = Number(parts.find(p => p.type === 'hour')?.value || '0');
    const minute = Number(parts.find(p => p.type === 'minute')?.value || '0');
    return hour * 60 + minute;
}

function parseClock(value: unknown) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
}

function inQuietHours(profile: StoredProfile | null, now: Date) {
    const quiet = (profile?.agent_prefs || {}) as Record<string, unknown>;
    const qh = (quiet.quiet_hours || {}) as Record<string, unknown>;
    const start = parseClock(qh.start);
    const end = parseClock(qh.end);
    const timezone = typeof qh.timezone === 'string' && qh.timezone ? qh.timezone : 'UTC';
    if (start === null || end === null) return false;
    const nowMinutes = getMinutesInTimezone(now, timezone);
    if (start <= end) {
        return nowMinutes >= start && nowMinutes < end;
    }
    return nowMinutes >= start || nowMinutes < end;
}

async function ensureIntentRoomId(createdBy: string | null = null) {
    if (cachedIntentRoomId) return cachedIntentRoomId;

    const supabase = getServiceSupabase();
    const { data: existing } = await supabase
        .from('rooms')
        .select('id')
        .eq('slug', INTENT_ROOM_SLUG)
        .single();

    if (existing?.id) {
        cachedIntentRoomId = existing.id;
        return existing.id;
    }

    const { data: inserted, error } = await supabase
        .from('rooms')
        .insert({
            name: INTENT_ROOM_NAME,
            slug: INTENT_ROOM_SLUG,
            is_public: false,
            invite_code: generateInviteCode(),
            created_by: createdBy,
        })
        .select('id')
        .single();

    if (!error && inserted?.id) {
        cachedIntentRoomId = inserted.id;
        return inserted.id;
    }

    const { data: afterRace } = await supabase
        .from('rooms')
        .select('id')
        .eq('slug', INTENT_ROOM_SLUG)
        .single();

    if (!afterRace?.id) {
        throw new Error('Failed to initialize intent state room');
    }

    cachedIntentRoomId = afterRace.id;
    return afterRace.id;
}

async function fetchProfileMessage(userId: string) {
    const supabase = getServiceSupabase();
    const roomId = await ensureIntentRoomId();
    // Read canonical AND legacy "@" variant, newest wins, so existing
    // profiles keep working through the key transition (codexmb P1).
    let newest: { id: string; body: unknown; created_at: string; metadata: unknown } | null = null;
    for (const key of userIdVariants(userId)) {
        const { data } = await supabase
            .from('messages')
            .select('id, body, created_at, metadata')
            .eq('room_id', roomId)
            .contains('metadata', {
                is_intent_profile_state: true,
                intent_user_id: key,
            })
            .order('created_at', { ascending: false })
            .limit(1);
        const row = data?.[0];
        if (row && (!newest || row.created_at > newest.created_at)) newest = row;
    }
    return newest;
}

export async function getIntentProfile(userId: string) {
    userId = canonicalUserId(userId);
    const row = await fetchProfileMessage(userId);
    const metadata = (row?.metadata || {}) as Record<string, unknown>;
    const profile = ((metadata.profile || {}) as StoredProfile) || {};
    const updatedAt = normalizeTimestamp(metadata.updated_at, row?.created_at || getNowIso());

    return {
        schema_version: SCHEMA_VERSION,
        user_id: userId,
        updated_at: updatedAt,
        personal: (profile.personal || {}) as Record<string, unknown>,
        preferences: (profile.preferences || {}) as Record<string, unknown>,
        agent_prefs: (profile.agent_prefs || {}) as Record<string, unknown>,
    };
}

export async function putIntentProfile(userId: string, patch: Record<string, unknown>, actorAgentId?: string | null) {
    userId = canonicalUserId(userId);
    const supabase = getServiceSupabase();
    const roomId = await ensureIntentRoomId(actorAgentId || null);
    const existing = await fetchProfileMessage(userId);

    const existingMeta = ((existing?.metadata || {}) as Record<string, unknown>) || {};
    const existingProfile = ((existingMeta.profile || {}) as StoredProfile) || {};
    const nowIso = getNowIso();

    const mergedProfile: StoredProfile = {
        personal: {
            ...(existingProfile.personal || {}),
            ...(((patch.personal || {}) as Record<string, unknown>) || {}),
        },
        preferences: {
            ...(existingProfile.preferences || {}),
            ...(((patch.preferences || {}) as Record<string, unknown>) || {}),
        },
        agent_prefs: {
            ...(existingProfile.agent_prefs || {}),
            ...(((patch.agent_prefs || {}) as Record<string, unknown>) || {}),
        },
    };

    const metadata = {
        ...existingMeta,
        is_intent_profile_state: true,
        intent_user_id: userId,
        schema_version: SCHEMA_VERSION,
        updated_at: nowIso,
        profile: mergedProfile,
        audit_last_writer: actorAgentId || WEB_USER_AGENT_ID,
    };

    if (existing?.id) {
        const { error } = await supabase
            .from('messages')
            .update({
                body: 'intent_profile_state',
                created_at: nowIso,
                metadata,
            })
            .eq('id', existing.id);
        if (error) throw error;
    } else {
        const { error } = await supabase.from('messages').insert({
            room_id: roomId,
            from_agent_id: actorAgentId || WEB_USER_AGENT_ID,
            body: 'intent_profile_state',
            metadata,
        });
        if (error) throw error;
    }

    return getIntentProfile(userId);
}

async function fetchIntentSlotMessages(userId: string, slotType?: SlotType, slotId?: string) {
    const supabase = getServiceSupabase();
    const roomId = await ensureIntentRoomId();

    // Read canonical AND legacy "@" variant so device/agent presence and
    // other slots survive the key transition (codexmb P1).
    const merged: Array<{ id: string; created_at: string; metadata: unknown }> = [];
    for (const key of userIdVariants(userId)) {
        let query = supabase
            .from('messages')
            .select('id, created_at, metadata')
            .eq('room_id', roomId)
            .contains('metadata', {
                is_intent_slot_state: true,
                intent_user_id: key,
            })
            .order('created_at', { ascending: false })
            .limit(2000);
        if (slotType) query = query.contains('metadata', { slot_type: slotType });
        if (slotId) query = query.contains('metadata', { slot_id: slotId });
        const { data, error } = await query;
        if (error) throw error;
        if (data) merged.push(...data);
    }
    merged.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return merged;
}

function pickLatestSlots(rows: Array<{ id: string; created_at: string; metadata: any }>) {
    const latestByKey = new Map<string, { id: string; created_at: string; metadata: any }>();
    for (const row of rows) {
        const md = (row.metadata || {}) as Record<string, unknown>;
        const slotType = String(md.slot_type || '');
        const slotId = String(md.slot_id || '');
        if (!slotType || !slotId) continue;
        const key = `${slotType}:${slotId}`;
        const current = latestByKey.get(key);
        if (!current) {
            latestByKey.set(key, row);
            continue;
        }
        if (Date.parse(row.created_at) > Date.parse(current.created_at)) {
            latestByKey.set(key, row);
        }
    }
    return latestByKey;
}

function computeDerivedState(input: {
    profile: StoredProfile | null;
    devices: Record<string, Record<string, unknown>>;
    nowIso: string;
}) {
    const now = new Date(input.nowIso);
    let urgencyMode = 'normal';
    let suppressAudio = false;
    let availableModalities = ['read', 'listen', 'speak'];
    let preferredDevice: string | null = null;

    const deviceEntries = Object.entries(input.devices);
    if (deviceEntries.length === 0) {
        urgencyMode = 'emergency-only';
        suppressAudio = true;
        availableModalities = ['read'];
    }

    let bestScreenActiveTs = -1;
    for (const [deviceId, state] of deviceEntries) {
        if (String(state.context || '') === 'meeting') {
            urgencyMode = 'text-only';
            suppressAudio = true;
            availableModalities = ['read'];
        }
        if (state.screen_active === true) {
            const ts = Date.parse(String(state.updated_at || ''));
            if (!Number.isNaN(ts) && ts > bestScreenActiveTs) {
                bestScreenActiveTs = ts;
                preferredDevice = deviceId;
            }
        }
    }

    if (inQuietHours(input.profile, now)) {
        urgencyMode = 'emergency-only';
        suppressAudio = true;
        availableModalities = ['read'];
    }

    // 2-level state model
    const overallState = inferOverallState(input, urgencyMode);
    const reachabilityMode = inferReachabilityMode(overallState, input, urgencyMode);

    return {
        urgency_mode: urgencyMode,
        available_modalities: availableModalities,
        preferred_device: preferredDevice,
        suppress_audio: suppressAudio,
        overall_state: overallState,
        reachability_mode: reachabilityMode,
        computed_at: input.nowIso,
    };
}

function inferOverallState(input: {
    profile: StoredProfile | null;
    devices: Record<string, Record<string, unknown>>;
    nowIso: string;
}, urgencyMode: string): string {
    const now = new Date(input.nowIso);
    const hour = now.getHours();
    const deviceEntries = Object.entries(input.devices);

    // Check quiet hours -> sleeping
    if (inQuietHours(input.profile, now)) return 'sleeping';

    // Check device context signals
    for (const [, state] of deviceEntries) {
        const ctx = String(state.context || '');
        if (ctx === 'meeting') return 'meeting_people';
        if (ctx === 'exercise' || ctx === 'exercising') return 'exercising';
        if (ctx === 'outdoors' || ctx === 'transit') return 'outdoors';
    }

    // No devices at all -> likely away
    if (deviceEntries.length === 0) {
        if (hour >= 23 || hour < 7) return 'sleeping';
        return 'resting';
    }

    // Screen active -> working
    const hasActiveScreen = deviceEntries.some(([, s]) => s.screen_active === true);
    if (hasActiveScreen) return 'working';

    // Default based on time
    if (hour >= 22 || hour < 8) return 'resting';
    return 'working';
}

function inferReachabilityMode(overallState: string, input: {
    devices: Record<string, Record<string, unknown>>;
}, urgencyMode: string): string {
    const deviceEntries = Object.entries(input.devices);
    const hasDesktop = deviceEntries.some(([id]) =>
        id.includes('macbook') || id.includes('mac-mini') || id.includes('desktop')
    );
    const hasMobile = deviceEntries.some(([id]) =>
        id.includes('phone') || id.includes('mobile') || id.includes('watch')
    );

    switch (overallState) {
        case 'working':
            if (hasDesktop) return 'desktop';
            if (hasMobile) return 'mobile_full_focus';
            return 'voice_only';
        case 'resting':
            if (urgencyMode === 'emergency-only') return 'dnd';
            return 'available';
        case 'meeting_people':
            return 'group_focus';
        case 'outdoors':
            if (hasMobile) return 'walking';
            return 'off_grid';
        case 'exercising':
            return 'light_voice_ok';
        case 'sleeping':
            return 'asleep';
        default:
            return 'unknown';
    }
}

/**
 * What a slot last published before it stopped reporting.
 *
 * `stale_devices` / `stale_agents` stay `string[]` forever: they are the
 * published API contract and at least one reader dedupes them through a Set.
 * This rides alongside them, keyed by the same slot id, so a reader that wants
 * "last seen 3 weeks ago, was running qwen3-coder" can have it and a reader
 * that only wants names is untouched.
 */
export type StaleSlotDetail = {
    /** ISO timestamp of the last heartbeat that arrived. */
    updated_at: string;
    /** The TTL it was judged against, so a reader can show why it is stale. */
    ttl_sec: number;
    source_device: string;
    /** The last state the slot published, in the same shape a live slot has. */
    state: Record<string, unknown>;
};

/** The live/stale split of one person's slots. */
export type SlotSnapshot = {
    devices: Record<string, Record<string, unknown>>;
    agents: Record<string, Record<string, unknown>>;
    stale_devices: string[];
    stale_agents: string[];
    stale_device_details: Record<string, StaleSlotDetail>;
    stale_agent_details: Record<string, StaleSlotDetail>;
};

/**
 * Split the latest row per slot into live entries and stale ones.
 *
 * Pulled out of getIntentState so it can be exercised without Supabase: this
 * is the whole of the freshness decision, and it is what src/lib/
 * intent-store.stale.test.ts tests.
 */
export function buildSlotSnapshot(
    rows: Iterable<{ created_at: string; metadata?: unknown }>,
    nowMs: number
): SlotSnapshot {
    const devices: Record<string, Record<string, unknown>> = {};
    const agents: Record<string, Record<string, unknown>> = {};
    const staleDevices: string[] = [];
    const staleAgents: string[] = [];
    const staleDeviceDetails: Record<string, StaleSlotDetail> = {};
    const staleAgentDetails: Record<string, StaleSlotDetail> = {};

    for (const row of rows) {
        const md = (row.metadata || {}) as Record<string, unknown>;
        const slotType = String(md.slot_type || '');
        const slotId = String(md.slot_id || '');
        if (!slotType || !slotId) continue;

        const ttlSec = normalizeNumber(
            md.ttl_sec,
            slotType === 'agent' ? DEFAULT_AGENT_TTL_SEC : DEFAULT_DEVICE_TTL_SEC
        );
        const updatedAt = normalizeTimestamp(md.updated_at, row.created_at);
        const sourceDevice = typeof md.source_device === 'string' ? md.source_device : slotId;
        const state = ((md.state || {}) as Record<string, unknown>) || {};

        const entry = {
            ...state,
            updated_at: updatedAt,
            source_device: sourceDevice,
            ttl_sec: ttlSec,
        };

        if (isStale(updatedAt, ttlSec, nowMs)) {
            // Everything this slot last said is already parsed above. Dropping
            // it here is what made six offline chips indistinguishable: a box
            // quiet for ten minutes and one quiet since spring rendered the
            // same. Keep the record beside the id, in a NEW field - the string
            // arrays are the published contract and other readers dedupe them
            // with a Set, so their type does not change.
            const detail: StaleSlotDetail = {
                updated_at: updatedAt,
                ttl_sec: ttlSec,
                source_device: sourceDevice,
                state,
            };
            if (slotType === 'agent') {
                staleAgents.push(slotId);
                staleAgentDetails[slotId] = detail;
            } else {
                staleDevices.push(slotId);
                staleDeviceDetails[slotId] = detail;
            }
            continue;
        }

        if (slotType === 'agent') {
            agents[slotId] = entry;
        } else {
            devices[slotId] = entry;
        }
    }

    return {
        devices,
        agents,
        stale_devices: staleDevices,
        stale_agents: staleAgents,
        stale_device_details: staleDeviceDetails,
        stale_agent_details: staleAgentDetails,
    };
}

export async function getIntentState(userId: string) {
    userId = canonicalUserId(userId);
    const rows = await fetchIntentSlotMessages(userId);
    const latest = pickLatestSlots(rows);
    const nowIso = getNowIso();

    const snapshot = buildSlotSnapshot(latest.values(), Date.now());
    const { devices } = snapshot;

    const profile = await getIntentProfile(userId);
    const derived = computeDerivedState({
        profile: {
            personal: profile.personal,
            preferences: profile.preferences,
            agent_prefs: profile.agent_prefs,
        },
        devices,
        nowIso,
    });

    // Fold the roster before anyone sees it, so the API, CodeWatch and the
    // dashboard all agree on who is in the fleet. Case-duplicate agent rows
    // collapse to the fresher one and placeholder registrations drop out; see
    // fleet-roster.ts for why this happens on read rather than on write.
    //
    // foldFleetSnapshot is generic over the snapshot type and spreads the rest
    // of it through, so the stale_*_details maps added here survive the fold
    // without fleet-roster.ts needing to know about them. `derived` is still
    // computed from the pre-fold devices, which is where it was computed before.
    const folded = foldFleetSnapshot(snapshot);

    return {
        schema_version: SCHEMA_VERSION,
        user_id: userId,
        ...folded,
        derived,
    };
}


// --- Telemetry history -------------------------------------------------
//
// Slot state is overwritten in place, so nothing about a machine's past
// survives a heartbeat. The dashboard wants a small time graph, which needs
// samples. These are appended to the same intent room as compact rows.
//
// Everything here is best-effort and swallowed: sampling runs on every
// heartbeat for every device, and a graph is not worth breaking presence for.

/** One sample per slot per this many ms; heartbeats are far more frequent. */
const SAMPLE_EVERY_MS = 5 * 60 * 1000;

/** How far back history is kept. Older samples are pruned on write. */
const SAMPLE_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Roughly one write in this many also prunes. */
const PRUNE_CHANCE = 1 / 20;

/**
 * Sampling is decoration on a heartbeat, so it gets a hard deadline. Without
 * one a hung PostgREST request keeps the presence PATCH open and the machine
 * reads as dead — swallowing exceptions does not help when nothing is thrown.
 */
const SAMPLE_TIMEOUT_MS = 2000;

/** The numbers worth plotting. Anything absent is simply not recorded. */
function sampleMetrics(state: Record<string, unknown>): Record<string, number> {
    const host = state.host && typeof state.host === 'object' && !Array.isArray(state.host)
        ? (state.host as Record<string, unknown>)
        : {};
    const merged = { ...state, ...host };
    const num = (k: string) => {
        const v = merged[k];
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };

    const out: Record<string, number> = {};
    const load = num('load_pct');
    if (load !== undefined) out.load_pct = load;
    const temp = num('temp_c');
    if (temp !== undefined) out.temp_c = temp;
    const watts = num('watts_w');
    if (watts !== undefined) out.watts_w = watts;

    // Memory as a percentage of installed, from AVAILABLE not free: free
    // memory on macOS is cache-adjusted to near zero and would plot a flat
    // line at the bottom on a machine with plenty spare.
    const total = num('mem_total_gb');
    const avail = num('mem_available_gb');
    if (total && avail !== undefined) out.mem_pct = Math.round((avail / total) * 100);

    return out;
}

/**
 * Append a telemetry sample for a slot, at most one per SAMPLE_EVERY_MS.
 * Never throws: callers are heartbeat paths.
 */
async function recordIntentSample(
    userId: string,
    slotType: SlotType,
    slotId: string,
    state: Record<string, unknown>
) {
    try {
        const metrics = sampleMetrics(state);
        if (Object.keys(metrics).length === 0) return; // nothing worth plotting

        const supabase = getServiceSupabase();
        const roomId = await ensureIntentRoomId();
        const canonical = canonicalUserId(userId);

        const { data: recent, error: recentError } = await supabase
            .from('messages')
            .select('created_at')
            .eq('room_id', roomId)
            .contains('metadata', {
                is_intent_sample: true,
                intent_user_id: canonical,
                slot_type: slotType,
                slot_id: slotId,
            })
            .order('created_at', { ascending: false })
            .limit(1)
            .abortSignal(AbortSignal.timeout(SAMPLE_TIMEOUT_MS));

        // A failed lookup is NOT "nothing recorded recently". supabase-js
        // returns errors rather than throwing, so treating a failure as an
        // empty result would insert on every heartbeat — the exact flood the
        // interval exists to prevent. Skip this round instead.
        if (recentError) return;

        const last = recent?.[0]?.created_at ? Date.parse(recent[0].created_at) : 0;
        if (Date.now() - last < SAMPLE_EVERY_MS) return; // too soon

        await supabase
            .from('messages')
            .insert({
                room_id: roomId,
                from_agent_id: WEB_USER_AGENT_ID,
                body: 'intent_sample',
                metadata: {
                    is_intent_sample: true,
                    intent_user_id: canonical,
                    slot_type: slotType,
                    slot_id: slotId,
                    ...metrics,
                },
            })
            .abortSignal(AbortSignal.timeout(SAMPLE_TIMEOUT_MS));

        // Probability, not a counter: module state does not survive between
        // serverless invocations, so a counter would sit at 1 forever and the
        // room would grow without bound.
        if (Math.random() < PRUNE_CHANCE) {
            const cutoff = new Date(Date.now() - SAMPLE_RETENTION_MS).toISOString();
            await supabase
                .from('messages')
                .delete()
                .eq('room_id', roomId)
                .contains('metadata', { is_intent_sample: true })
                .lt('created_at', cutoff)
                .abortSignal(AbortSignal.timeout(SAMPLE_TIMEOUT_MS));
        }
    } catch {
        // History is decoration. Presence must not fail because of it.
    }
}

/**
 * Run a sample write after the response, never as part of it.
 */
function scheduleIntentSample(
    userId: string,
    slotType: SlotType,
    slotId: string,
    state: Record<string, unknown>
) {
    const work = () => recordIntentSample(userId, slotType, slotId, state);
    try {
        after(work);
    } catch {
        // Not inside a request: nothing to defer to, so detach it. Already
        // swallowing, already deadlined.
        void work();
    }
}

/**
 * Telemetry samples for a user's slots, newest last, grouped by "type:id".
 */
export async function getIntentHistory(userId: string, hours = 24) {
    const supabase = getServiceSupabase();
    const roomId = await ensureIntentRoomId();
    const since = new Date(Date.now() - Math.max(1, Math.min(hours, 48)) * 3600_000).toISOString();

    const series: Record<string, Array<Record<string, unknown>>> = {};
    for (const key of userIdVariants(userId)) {
        const { data } = await supabase
            .from('messages')
            .select('created_at, metadata')
            .eq('room_id', roomId)
            .contains('metadata', { is_intent_sample: true, intent_user_id: key })
            .gte('created_at', since)
            .order('created_at', { ascending: true })
            .limit(4000);

        for (const row of data || []) {
            const md = (row.metadata || {}) as Record<string, unknown>;
            const slotKey = `${md.slot_type}:${md.slot_id}`;
            const point: Record<string, unknown> = { at: row.created_at };
            for (const k of ['load_pct', 'mem_pct', 'temp_c', 'watts_w']) {
                if (typeof md[k] === 'number') point[k] = md[k];
            }
            // Two heartbeats can pass the recency check at once and both
            // insert. A unique index would be the real gate, but that needs a
            // migration; collapsing same-minute points per slot on read costs
            // nothing and hides the duplicate rather than plotting it twice.
            const minute = String(row.created_at).slice(0, 16);
            const bucket = (series[slotKey] ||= []);
            const previous = bucket[bucket.length - 1];
            if (previous && String(previous.at).slice(0, 16) === minute) {
                bucket[bucket.length - 1] = point;
            } else {
                bucket.push(point);
            }
        }
    }
    return { schema_version: SCHEMA_VERSION, user_id: canonicalUserId(userId), hours, series };
}

export async function upsertIntentSlot(input: {
    userId: string;
    slotType: SlotType;
    slotId: string;
    payload: Record<string, unknown>;
    replace: boolean;
    actorAgentId?: string | null;
}) {
    input = { ...input, userId: canonicalUserId(input.userId) };
    const supabase = getServiceSupabase();
    const roomId = await ensureIntentRoomId(input.actorAgentId || null);
    const rows = await fetchIntentSlotMessages(input.userId, input.slotType, input.slotId);
    const existing = rows[0] || null;
    const duplicates = rows.slice(1).map(r => r.id);
    const existingMeta = ((existing?.metadata || {}) as Record<string, unknown>) || {};
    const existingState = ((existingMeta.state || {}) as Record<string, unknown>) || {};

    const nowIso = getNowIso();
    const payloadNoHeartbeat = { ...input.payload };
    delete payloadNoHeartbeat.heartbeat;

    const nextState = input.replace
        ? payloadNoHeartbeat
        : { ...existingState, ...payloadNoHeartbeat };

    const ttlSec = normalizeNumber(
        input.payload.ttl_sec ?? existingMeta.ttl_sec,
        input.slotType === 'agent' ? DEFAULT_AGENT_TTL_SEC : DEFAULT_DEVICE_TTL_SEC
    );

    const sourceDevice = typeof input.payload.source_device === 'string'
        ? input.payload.source_device
        : (typeof existingMeta.source_device === 'string' ? existingMeta.source_device : input.slotId);

    const metadata = {
        ...existingMeta,
        is_intent_slot_state: true,
        intent_user_id: input.userId,
        slot_type: input.slotType,
        slot_id: input.slotId,
        schema_version: SCHEMA_VERSION,
        updated_at: nowIso,
        source_device: sourceDevice,
        ttl_sec: ttlSec,
        state: nextState,
    };

    if (existing?.id) {
        const { error } = await supabase
            .from('messages')
            .update({
                body: 'intent_slot_state',
                created_at: nowIso,
                metadata,
            })
            .eq('id', existing.id);
        if (error) throw error;
    } else {
        const { error } = await supabase
            .from('messages')
            .insert({
                room_id: roomId,
                from_agent_id: input.actorAgentId || WEB_USER_AGENT_ID,
                body: 'intent_slot_state',
                metadata,
            });
        if (error) throw error;
    }

    if (duplicates.length > 0) {
        await supabase.from('messages').delete().in('id', duplicates);
    }

    // Off the critical path. Timeouts bound each query, but awaiting them here
    // still adds that budget to a presence publish, and presence is the thing
    // that must stay fast. `after` runs the work once the response is sent and
    // keeps the serverless invocation alive for it; outside a request scope
    // (scripts, tests) there is nothing to defer to, so it runs detached.
    scheduleIntentSample(input.userId, input.slotType, input.slotId, nextState);

    return {
        schema_version: SCHEMA_VERSION,
        user_id: input.userId,
        slot_type: input.slotType,
        slot_id: input.slotId,
        ...nextState,
        updated_at: nowIso,
        source_device: sourceDevice,
        ttl_sec: ttlSec,
    };
}

export async function deleteIntentSlot(userId: string, slotType: SlotType, slotId: string) {
    userId = canonicalUserId(userId);
    const supabase = getServiceSupabase();
    const rows = await fetchIntentSlotMessages(userId, slotType, slotId);
    const ids = rows.map(r => r.id);
    if (ids.length === 0) {
        return { removed: 0 };
    }
    const { error } = await supabase.from('messages').delete().in('id', ids);
    if (error) throw error;
    return { removed: ids.length };
}

type IntentState = Awaited<ReturnType<typeof getIntentState>>;

/**
 * Same freshest-wins rule as mergeSlots, restricted to the ids that survived
 * the stale lists. A slot live in one document and stale in the other is
 * dropped from the lists, so its detail must go too or the two disagree.
 */
function mergeStaleDetails(
    primary: Record<string, StaleSlotDetail>,
    secondary: Record<string, StaleSlotDetail>,
    keepIds: string[]
): Record<string, StaleSlotDetail> {
    const keep = new Set(keepIds);
    const merged: Record<string, StaleSlotDetail> = {};
    for (const [slotId, detail] of [...Object.entries(primary ?? {}), ...Object.entries(secondary ?? {})]) {
        if (!keep.has(slotId)) continue;
        const existing = merged[slotId];
        if (!existing || isFresher(detail?.updated_at, existing?.updated_at)) {
            merged[slotId] = detail;
        }
    }
    return merged;
}

/**
 * Combine the same person's state from two ids they are known by.
 *
 * A user has both a UUID and a handle, and publishers do not agree on which to
 * write to, so half the fleet can land in one document and half in the other.
 * The freshest entry for a given slot wins; a slot is only stale if neither
 * document has it live, otherwise mirrored publishers would flicker between
 * active and stale depending on which document was read first.
 */
export function mergeIntentStates(primary: IntentState, secondary: IntentState): IntentState {
    // mergeSlotMaps folds case as it merges: each document can carry a
    // different capitalisation of the same agent, so merging on the raw id
    // would put the duplicate straight back after getIntentState removed it.
    const devices = mergeSlotMaps('device', primary.devices, secondary.devices);
    const agents = mergeSlotMaps('agent', primary.agents, secondary.agents);
    const staleDevices = foldStaleIds(
        'device',
        [...primary.stale_devices, ...secondary.stale_devices],
        devices
    );
    const staleAgents = foldStaleIds(
        'agent',
        [...primary.stale_agents, ...secondary.stale_agents],
        agents
    );

    return {
        ...primary,
        devices,
        agents,
        stale_devices: staleDevices,
        stale_agents: staleAgents,
        stale_device_details: mergeStaleDetails(
            primary.stale_device_details, secondary.stale_device_details, staleDevices),
        stale_agent_details: mergeStaleDetails(
            primary.stale_agent_details, secondary.stale_agent_details, staleAgents),
    };
}

export { WEB_USER_AGENT_ID, SCHEMA_VERSION };
