// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Who is actually in the fleet, and how many.
 *
 * The /intent header read "AGENTS 7 REPORTING, 9 OFFLINE" while the fleet has
 * nothing like sixteen agents. The arithmetic was right and the membership was
 * wrong, in two separate ways:
 *
 *  1. CASE-DUPLICATE IDENTITY. One agent, two rows. Two writers disagree about
 *     capitalisation and neither is wrong on its own: `POST /api/v1/messages`
 *     refreshes the poster's slot under `agent.handle.replace(/^@/, '')`, which
 *     strips the @ but keeps the case, so a DB handle of `@claudeMB` writes
 *     slot id `claudeMB`; the uik-daemon publishes the same agent from
 *     `INTENT_AGENT_HANDLE`, which on that machine is `@claudemb`. Both rows
 *     stay warm - the more the agent talks, the fresher its capitalised twin -
 *     so it renders as two cards and counts as two.
 *
 *  2. PLACEHOLDER REGISTRATIONS. `zz-probe-nonexistent` is a leftover test
 *     probe. `agent` is the daemon's fallback handle
 *     (`process.env.INTENT_AGENT_HANDLE || '@agent'`), so it means "a box
 *     nobody named", not a teammate. Counting them inflates "offline" and
 *     makes a healthy fleet look broken.
 *
 * Everything here is pure - no database, no React - so the server snapshot and
 * the dashboard can apply the same rules and a test can check them without a
 * Supabase client.
 *
 * WHY CASE FOLDING LIVES HERE AND NOT IN `canonicalUserId`.
 * `intent-store.ts` has a `canonicalUserId` that trims and strips a leading @
 * but deliberately does NOT lowercase: the comment above it records that
 * lowercasing USER ids would let two case-distinct people collapse into one
 * document and cross-read each other's state. That reasoning is about the
 * document key and still holds, and the function has nine call sites. So slot
 * ids get their own canonicaliser rather than a widened shared one.
 *
 * WHY MERGE ON READ. Existing rows are already split, and a write-side fix
 * would only stop new splits - the live dashboard would stay wrong until every
 * stale row aged out. Reading both forms and merging is also the pattern
 * `intent-store.ts` already uses for the canonical/legacy "@" user-id
 * transition, so this follows the file's own precedent.
 */

/** Later of two ISO timestamps wins; an unparseable one never wins. */
export function isFresher(candidate: unknown, incumbent: unknown): boolean {
    const a = Date.parse(String(candidate ?? ''));
    const b = Date.parse(String(incumbent ?? ''));
    if (Number.isNaN(a)) return false;
    if (Number.isNaN(b)) return true;
    return a > b;
}

export type FleetSlotType = 'device' | 'agent';

/** The minimum a slot needs for roster work. Callers keep their own richer types. */
export type RosterSlot = {
    name?: unknown;
    updated_at?: unknown;
    [key: string]: unknown;
};

export type RosterSlotMap<S extends RosterSlot = RosterSlot> = Record<string, S>;

/**
 * The identity key two rows are compared on.
 *
 * Agent slot ids are folded to lower case, because the two writers above differ
 * only in case and an agent handle is not case-sensitive anywhere else in the
 * product. Device ids are left exactly as published: no case-duplicate devices
 * exist in the live data, and device ids are chosen by the operator rather than
 * derived from a handle, so folding them would be a guess with no bug behind it.
 *
 * This is a comparison key only. The display casing shown on a card comes from
 * whichever row won, never from this.
 */
export function canonicalSlotKey(slotType: FleetSlotType, slotId: string): string {
    const bare = String(slotId ?? '').trim().replace(/^@+/, '');
    return slotType === 'agent' ? bare.toLowerCase() : bare;
}

/**
 * The uik-daemon's fallback agent handle: `INTENT_AGENT_HANDLE || '@agent'`.
 * A slot published under it names no one, so it is a placeholder rather than a
 * teammate.
 */
const DAEMON_FALLBACK_AGENT_HANDLE = 'agent';

/**
 * Test probes register themselves with this prefix. Anchored and literal on
 * purpose: `zz-probe-nonexistent` is excluded, while `zzprobe`, `probe-1` and
 * `my-zz-probe` are real ids and are kept. A looser heuristic would eventually
 * drop a real agent silently, which is a worse failure than one stale chip.
 */
const PROBE_SLOT_ID_PREFIX = /^zz-probe-/;

/**
 * True for registrations that are not fleet members.
 *
 * Deliberately narrow. Only two rules, both matching an exact string the code
 * elsewhere is known to produce. In particular there is NO rule for humans:
 * `petrus` shows up as an agent slot, but a slot row carries only
 * `slot_type: 'device' | 'agent'` and no owner/human marker, so the store
 * cannot tell a person's handle from an agent's. Hardcoding a name would be a
 * guess about one deployment, so that id is left in the fleet.
 */
export function isPlaceholderSlot(slotType: FleetSlotType, slotId: string): boolean {
    const key = canonicalSlotKey(slotType, slotId).toLowerCase();
    if (!key) return true;
    if (PROBE_SLOT_ID_PREFIX.test(key)) return true;
    return slotType === 'agent' && key === DAEMON_FALLBACK_AGENT_HANDLE;
}

/**
 * One entry per real slot: placeholders dropped, case-duplicates merged.
 *
 * The fresher row wins outright - its state AND the casing it published, which
 * becomes the returned key - because a merged card must show one machine's
 * readings, not a blend of two rows sampled minutes apart.
 */
export function foldSlotMap<S extends RosterSlot>(
    slotType: FleetSlotType,
    slots: RosterSlotMap<S>
): RosterSlotMap<S> {
    return foldSlotEntries(slotType, Object.entries(slots || {}));
}

/**
 * The same fold over an ordered list of entries, so a caller merging two
 * documents can put the preferred one first. Ties go to whichever entry was
 * seen first, because `isFresher` is a strict comparison.
 */
export function foldSlotEntries<S extends RosterSlot>(
    slotType: FleetSlotType,
    entries: Array<[string, S]>
): RosterSlotMap<S> {
    const winners = new Map<string, { slotId: string; slot: S }>();
    for (const [slotId, slot] of entries) {
        if (isPlaceholderSlot(slotType, slotId)) continue;
        const key = canonicalSlotKey(slotType, slotId);
        const current = winners.get(key);
        if (!current || isFresher(slot?.updated_at, current.slot?.updated_at)) {
            winners.set(key, { slotId, slot });
        }
    }
    const out: RosterSlotMap<S> = {};
    for (const { slotId, slot } of winners.values()) out[slotId] = slot;
    return out;
}

/**
 * Combine the same slot type from two documents, folding case as it goes.
 *
 * A user has both a UUID and a handle and publishers do not agree on which to
 * write to, so half the fleet can land in one document and half in the other.
 * Folding here as well as in `foldSlotMap` matters: each document can hold a
 * different casing of the same agent, and merging on the raw id would put the
 * duplicate straight back.
 */
export function mergeSlotMaps<S extends RosterSlot>(
    slotType: FleetSlotType,
    primary: RosterSlotMap<S>,
    secondary: RosterSlotMap<S>
): RosterSlotMap<S> {
    return foldSlotEntries(slotType, [
        ...Object.entries(primary || {}),
        ...Object.entries(secondary || {}),
    ]);
}

/**
 * The offline ids worth showing: placeholders dropped, case-duplicates
 * collapsed, and anything currently live removed.
 *
 * The live check is on the folded key, so an agent reporting as `claudeMB`
 * cannot also sit in the offline row as `claudemb`.
 */
export function foldStaleIds<S extends RosterSlot>(
    slotType: FleetSlotType,
    ids: string[],
    live: RosterSlotMap<S>
): string[] {
    const liveKeys = new Set(
        Object.keys(live || {}).map((id) => canonicalSlotKey(slotType, id))
    );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids || []) {
        if (isPlaceholderSlot(slotType, id)) continue;
        const key = canonicalSlotKey(slotType, id);
        if (liveKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push(id);
    }
    return out;
}

export type FleetSnapshot<S extends RosterSlot = RosterSlot> = {
    devices: RosterSlotMap<S>;
    agents: RosterSlotMap<S>;
    stale_devices: string[];
    stale_agents: string[];
};

/** Apply every roster rule to a snapshot, leaving the rest of it untouched. */
export function foldFleetSnapshot<S extends RosterSlot, T extends FleetSnapshot<S>>(state: T): T {
    const devices = foldSlotMap('device', state.devices);
    const agents = foldSlotMap('agent', state.agents);
    return {
        ...state,
        devices,
        agents,
        stale_devices: foldStaleIds('device', state.stale_devices, devices),
        stale_agents: foldStaleIds('agent', state.stale_agents, agents),
    };
}

export type FleetRoster<S extends RosterSlot> = {
    devices: Array<S & { slot_id: string }>;
    agents: Array<S & { slot_id: string }>;
    offlineDevices: string[];
    offlineAgents: string[];
};

/**
 * The exact four collections the dashboard renders.
 *
 * Counts are taken from these arrays and nowhere else. The header used to read
 * `intent.stale_devices.length` while the chips below it rendered
 * `intent.stale_devices.filter(id => !intent.devices[id])` - two expressions
 * over the same data, free to disagree, and they did. One builder now produces
 * the list, and `.length` of that list is the count, so the two cannot drift
 * apart again without the cards visibly changing too.
 */
export function buildFleetRoster<S extends RosterSlot>(state: FleetSnapshot<S>): FleetRoster<S> {
    const devices = foldSlotMap('device', state.devices);
    const agents = foldSlotMap('agent', state.agents);
    // Sorted by name, not by recency: the API returns slots most-recently-updated
    // first, so cards reordered under the cursor on every poll.
    const byName = (a: { name?: unknown; slot_id: string }, b: { name?: unknown; slot_id: string }) =>
        String(a.name || a.slot_id).localeCompare(String(b.name || b.slot_id), undefined, {
            sensitivity: 'base',
        });
    const toCards = (map: RosterSlotMap<S>) =>
        Object.entries(map)
            .map(([slot_id, slot]) => ({ ...slot, slot_id }))
            .sort(byName);
    return {
        devices: toCards(devices),
        agents: toCards(agents),
        offlineDevices: foldStaleIds('device', state.stale_devices, devices).sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' })
        ),
        offlineAgents: foldStaleIds('agent', state.stale_agents, agents).sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' })
        ),
    };
}
