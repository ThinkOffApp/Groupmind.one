// Unit test for the fleet roster: case-duplicate agents, placeholder
// registrations, and counts that cannot drift from the rendered list.
// Run: npx tsx src/lib/fleet-roster.test.ts

import {
    buildFleetRoster,
    canonicalSlotKey,
    foldFleetSnapshot,
    foldSlotMap,
    foldStaleIds,
    isFresher,
    isPlaceholderSlot,
    mergeSlotMaps,
    type RosterSlot,
} from './fleet-roster';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
    if (condition) { console.log(`  ✅ ${name}`); passed++; } else { console.log(`  ❌ ${name}`); failed++; }
}

const OLD = '2026-09-20T09:00:00.000Z';
const NEW = '2026-09-20T11:00:00.000Z';

function slot(updated_at: string, extra: Record<string, unknown> = {}): RosterSlot {
    return { updated_at, ttl_sec: 300, ...extra };
}

console.log('fleet-roster');

// --- canonical key ------------------------------------------------------
assert(canonicalSlotKey('agent', 'claudeMB') === 'claudemb', 'agent ids fold to lower case');
assert(canonicalSlotKey('agent', '@claudeMB') === 'claudemb', 'a leading @ is stripped from an agent id');
assert(canonicalSlotKey('agent', '  claudeMB  ') === 'claudemb', 'surrounding whitespace is trimmed');
assert(canonicalSlotKey('device', 'MacBook') === 'MacBook', 'device ids keep their case (no bug behind folding them)');

// --- placeholder / probe exclusion --------------------------------------
assert(isPlaceholderSlot('agent', 'agent'), 'the daemon fallback handle "agent" is a placeholder');
assert(isPlaceholderSlot('agent', '@Agent'), 'the fallback handle is matched regardless of case or @');
assert(isPlaceholderSlot('agent', 'zz-probe-nonexistent'), 'zz-probe-* is a probe');
assert(isPlaceholderSlot('device', 'zz-probe-box'), 'the probe rule applies to devices too');
assert(!isPlaceholderSlot('device', 'agent'), 'a DEVICE named "agent" is not the agent-handle fallback');

// NEGATIVE CONTROLS: real ids that merely resemble a placeholder must survive.
assert(!isPlaceholderSlot('agent', 'agentic'), 'a real agent "agentic" is NOT excluded');
assert(!isPlaceholderSlot('agent', 'agent-smith'), 'a real agent "agent-smith" is NOT excluded');
assert(!isPlaceholderSlot('agent', 'antigravity'), 'a real agent starting with "a" is NOT excluded');
assert(!isPlaceholderSlot('agent', 'zzprobe'), 'a real agent "zzprobe" (no hyphen) is NOT excluded');
assert(!isPlaceholderSlot('agent', 'probe-runner'), 'a real agent "probe-runner" is NOT excluded');
assert(!isPlaceholderSlot('agent', 'my-zz-probe-x'), 'the probe prefix is anchored, not a substring match');
assert(!isPlaceholderSlot('agent', 'petrus'), 'a human handle is left in the fleet (the store has no owner marker)');

// --- case-duplicate merge keeps the FRESHER row -------------------------
{
    const agents = {
        claudeMB: slot(NEW, { status: 'active', name: 'claudeMB' }),
        claudemb: slot(OLD, { status: 'idle', name: 'claudemb' }),
    };
    const folded = foldSlotMap('agent', agents);
    assert(Object.keys(folded).length === 1, 'two casings of one agent fold to a single entry');
    assert(folded.claudeMB?.status === 'active', 'the fresher row wins its state');
    assert('claudeMB' in folded, 'the fresher row also wins the display casing');
    assert(!('claudemb' in folded), 'the staler casing is gone');
}
{
    // Same pair, opposite freshness: the OTHER casing must win.
    const folded = foldSlotMap('agent', {
        claudeMB: slot(OLD, { status: 'idle' }),
        claudemb: slot(NEW, { status: 'active' }),
    });
    assert(Object.keys(folded).length === 1, 'the fold is symmetric (still one entry)');
    assert(folded.claudemb?.status === 'active', 'the fresher row wins whichever casing it has');
}
{
    // Insertion order must not decide it: the staler row listed first.
    const folded = foldSlotMap('agent', {
        claudemb: slot(OLD, { status: 'idle' }),
        claudeMB: slot(NEW, { status: 'active' }),
    });
    assert(folded.claudeMB?.status === 'active', 'insertion order does not beat freshness');
}
{
    const folded = foldSlotMap('agent', {
        good: slot(OLD, { status: 'idle' }),
        GOOD: slot('not-a-date', { status: 'broken' }),
    });
    assert(folded.good?.status === 'idle', 'an unparseable timestamp never wins the merge');
}

// --- a live agent is never also an offline chip -------------------------
{
    const live = foldSlotMap('agent', { claudeMB: slot(NEW) });
    const offline = foldStaleIds('agent', ['claudemb', 'kimi3', 'agent', 'zz-probe-nonexistent'], live);
    assert(!offline.includes('claudemb'), 'the other casing of a reporting agent is not listed offline');
    assert(offline.includes('kimi3'), 'a genuinely offline agent is still listed');
    assert(!offline.includes('agent'), 'the fallback handle is not listed offline');
    assert(!offline.includes('zz-probe-nonexistent'), 'a probe is not listed offline');
    assert(offline.length === 1, 'offline list holds exactly the real offline agents');
}
{
    const offline = foldStaleIds('agent', ['claudeMB', 'claudemb', 'CLAUDEMB'], {});
    assert(offline.length === 1, 'case-duplicates collapse inside the offline list too');
}

// --- merging two documents ----------------------------------------------
{
    // The same person's UUID document and handle document, each holding a
    // different casing of one agent.
    const merged = mergeSlotMaps(
        'agent',
        { claudeMB: slot(OLD, { doc: 'uuid' }) },
        { claudemb: slot(NEW, { doc: 'handle' }) }
    );
    assert(Object.keys(merged).length === 1, 'a cross-document case-duplicate does not survive the merge');
    assert(merged.claudemb?.doc === 'handle', 'the fresher document wins');
}
{
    const merged = mergeSlotMaps('agent', { a: slot(NEW, { doc: 'p' }) }, { a: slot(NEW, { doc: 's' }) });
    assert(merged.a?.doc === 'p', 'on an exact tie the primary document wins');
}

// --- the measured live fleet, end to end --------------------------------
//
// Reproduces what the API actually returned on 2026-09-20: agents 7 reporting
// / 9 offline, devices 6 / 6. claudeMB + claudemb are one agent; `agent`,
// `zz-probe-nonexistent` are placeholders; `petrus` is a human and stays.
{
    const reportingAgents = ['claudeMB', 'claudemb', 'claudemm', 'codexmb', 'eclass', 'hermes', 'qwenm5'];
    const offlineAgentIds = ['agent', 'antigravity', 'deepseek', 'gle', 'grok', 'kimi3', 'petrus', 'vta', 'zz-probe-nonexistent'];
    const reportingDevices = ['asus1', 'asus2', 'm5', 'mb', 'mini', 'vadelma'];
    const offlineDeviceIds = ['clawwatch', 'macbook', 'macmini', 'phone-noteair5c', 'phone-sm-f976b', 'vta439'];

    const snapshot = {
        devices: Object.fromEntries(reportingDevices.map((id) => [id, slot(NEW)])),
        agents: Object.fromEntries(
            reportingAgents.map((id) => [id, slot(id === 'claudeMB' ? NEW : OLD)])
        ),
        stale_devices: offlineDeviceIds,
        stale_agents: offlineAgentIds,
    };

    const roster = buildFleetRoster(snapshot);
    assert(roster.agents.length === 6, 'agents reporting: 7 -> 6 (claudeMB and claudemb are one)');
    assert(roster.agents.some((a) => a.slot_id === 'claudeMB'), 'the surviving card keeps the fresher casing');
    assert(roster.offlineAgents.length === 7, 'agents offline: 9 -> 7 (fallback handle and probe dropped)');
    assert(roster.offlineAgents.includes('petrus'), 'petrus is still counted, not silently special-cased');
    assert(roster.devices.length === 6, 'devices reporting is unchanged at 6');
    assert(roster.offlineDevices.length === 6, 'devices offline is unchanged at 6');

    // THE INVARIANT: every count on the page is the length of the very list
    // rendered beneath it. Same builder, same arrays, nothing computed twice.
    const folded = foldFleetSnapshot(snapshot);
    assert(Object.keys(folded.devices).length === roster.devices.length, 'device count matches the device card list');
    assert(Object.keys(folded.agents).length === roster.agents.length, 'agent count matches the agent card list');
    assert(folded.stale_devices.length === roster.offlineDevices.length, 'offline device count matches the chip list');
    assert(folded.stale_agents.length === roster.offlineAgents.length, 'offline agent count matches the chip list');

    // Folding twice changes nothing: the server folds the snapshot and the
    // dashboard folds it again, so the operation has to be idempotent.
    const twice = buildFleetRoster(foldFleetSnapshot(folded));
    assert(twice.agents.length === roster.agents.length, 'folding is idempotent for cards');
    assert(twice.offlineAgents.length === roster.offlineAgents.length, 'folding is idempotent for chips');

    // Cards are sorted by name, so a poll cannot reorder them.
    const names = roster.devices.map((d) => d.slot_id);
    assert(String(names) === String([...names].sort()), 'device cards come out name-sorted');
}

// --- isFresher ----------------------------------------------------------
assert(isFresher(NEW, OLD), 'isFresher: later timestamp wins');
assert(!isFresher(OLD, NEW), 'isFresher: earlier timestamp loses');
assert(!isFresher('nonsense', OLD), 'isFresher: an unparseable candidate never wins');
assert(isFresher(OLD, 'nonsense'), 'isFresher: anything beats an unparseable incumbent');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
