// SPDX-License-Identifier: AGPL-3.0-only
// Offline devices used to come back as six bare names. Run:
//   npx tsx src/lib/intent-store.stale.test.ts
//
// The bug: buildSlotSnapshot parsed a full record for every slot - updated_at,
// ttl_sec, source_device and the published state (model, device_kind) - and
// then, for a stale slot, threw all of it away:
//
//     if (isStale(updatedAt, ttlSec, nowMs)) {
//         if (slotType === 'agent') staleAgents.push(slotId);
//         else staleDevices.push(slotId);
//         continue;
//     }
//
// so /intent rendered six identical grey chips and the owner could not tell a
// box quiet for ten minutes from one quiet since spring.
//
// THE ONE THAT MUST NOT BREAK is "the API contract" block: stale_devices and
// stale_agents stay arrays of bare id strings. The new data rides alongside in
// stale_device_details / stale_agent_details.
//
// NEGATIVE CONTROL: this suite was run against a copy of intent-store.ts with
// the discard above restored, and it fails there. See the PR body for counts.

import { buildSlotSnapshot, mergeIntentStates } from './intent-store';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string) {
    if (cond) { console.log(`  ✅ ${name}`); passed++; }
    else { console.log(`  ❌ ${name}`); failed++; }
}

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const SECOND = 1000, MINUTE = 60 * SECOND, DAY = 24 * 60 * MINUTE;

function row(metadata: Record<string, unknown>, createdAt = iso(0)) {
    return { created_at: createdAt, metadata: { is_intent_slot_state: true, ...metadata } };
}

// A fleet with one live box, one box quiet since spring, and one agent that
// missed its 300 s window. Shapes copied from what publishers actually send.
const ROWS = [
    row({
        slot_type: 'device', slot_id: 'macbook', ttl_sec: 90,
        updated_at: iso(20 * SECOND), source_device: 'macbook',
        state: { model: 'models/qwen3-coder-30b.gguf', device_kind: 'laptop', status: 'working' },
    }),
    row({
        slot_type: 'device', slot_id: 'vta439', ttl_sec: 90,
        updated_at: iso(243 * DAY), source_device: 'vta439',
        state: { model: 'deepseek-ai/DeepSeek-V3.1', device_kind: 'workstation' },
    }),
    row({
        slot_type: 'device', slot_id: 'phone-noteair5c', ttl_sec: 90,
        updated_at: iso(11 * MINUTE), source_device: 'macbook',
        state: { device_kind: 'tablet' },
    }),
    row({
        slot_type: 'agent', slot_id: 'claudemm', ttl_sec: 300,
        updated_at: iso(3 * DAY), source_device: 'macmini',
        state: { model: 'claude-opus-5', task: 'reviewing PR #150' },
    }),
    row({
        slot_type: 'agent', slot_id: 'claudemb', ttl_sec: 300,
        updated_at: iso(30 * SECOND), source_device: 'macbook',
        state: { model: 'claude-opus-5', task: 'this branch' },
    }),
];

const snap = buildSlotSnapshot(ROWS, NOW);

console.log('\nFRESH SLOTS stay live and out of the stale output');
{
    assert('macbook' in snap.devices, 'a device inside its ttl lands in devices');
    assert(!snap.stale_devices.includes('macbook'), 'and not in stale_devices');
    assert(!('macbook' in snap.stale_device_details), 'and not in stale_device_details');
    assert(snap.devices.macbook?.model === 'models/qwen3-coder-30b.gguf', 'its state is still flattened onto the entry');
    assert('claudemb' in snap.agents && !snap.stale_agents.includes('claudemb'), 'same for a fresh agent');
}

console.log('\nSTALE SLOTS keep what they last published');
{
    const vta = snap.stale_device_details['vta439'];
    assert(!!vta, 'a device past its ttl has a detail record');
    assert(vta?.updated_at === iso(243 * DAY), 'the last-seen timestamp survives');
    assert(vta?.ttl_sec === 90, 'the ttl it was judged against survives');
    assert(vta?.source_device === 'vta439', 'source_device survives');
    assert(vta?.state?.model === 'deepseek-ai/DeepSeek-V3.1', 'the model it last ran survives');
    assert(vta?.state?.device_kind === 'workstation', 'and the rest of its state');

    const phone = snap.stale_device_details['phone-noteair5c'];
    assert(phone?.updated_at === iso(11 * MINUTE), 'a box quiet 11 minutes is distinguishable from one quiet 243 days');
    // Deliberately null-safe: with the fix reverted these are undefined, and a
    // suite that throws reports no counts at all.
    const phoneMs = Date.parse(phone?.updated_at ?? '');
    const vtaMs = Date.parse(vta?.updated_at ?? '');
    assert(Number.isFinite(phoneMs) && Number.isFinite(vtaMs) && phoneMs > vtaMs, 'the two timestamps order correctly');
    assert(phone?.source_device === 'macbook', 'a slot published by another box keeps its publisher');
    assert(!('model' in (phone?.state ?? {})), 'a slot that never published a model does not gain one');

    const agent = snap.stale_agent_details['claudemm'];
    assert(agent?.state?.model === 'claude-opus-5', 'stale agents carry their model too');
    assert(agent?.ttl_sec === 300, 'agents keep the agent ttl');
    assert(!('claudemm' in snap.stale_device_details), 'an agent does not leak into the device details');
}

console.log('\nTHE API CONTRACT - stale_devices / stale_agents are still bare id strings');
{
    // The pre-change behaviour, reimplemented over the same rows: push the id,
    // discard the record. Whatever the new code returns in the string arrays
    // has to equal this, element for element and in the same order.
    const beforeDevices: string[] = [];
    const beforeAgents: string[] = [];
    for (const r of ROWS) {
        const md = r.metadata as Record<string, unknown>;
        const ttlSec = Number(md.ttl_sec);
        const updatedAt = String(md.updated_at);
        if (Date.parse(updatedAt) + ttlSec * 1000 >= NOW) continue;
        if (md.slot_type === 'agent') beforeAgents.push(String(md.slot_id));
        else beforeDevices.push(String(md.slot_id));
    }
    assert(JSON.stringify(snap.stale_devices) === JSON.stringify(beforeDevices),
        `stale_devices unchanged: ${JSON.stringify(snap.stale_devices)}`);
    assert(JSON.stringify(snap.stale_agents) === JSON.stringify(beforeAgents),
        `stale_agents unchanged: ${JSON.stringify(snap.stale_agents)}`);
    assert(snap.stale_devices.every((id) => typeof id === 'string'), 'every stale_devices element is a string, not an object');
    assert(snap.stale_agents.every((id) => typeof id === 'string'), 'every stale_agents element is a string, not an object');
    assert(new Set(snap.stale_devices).size === snap.stale_devices.length, 'a consumer can still dedupe them with a Set');
    assert(Object.keys(snap.stale_device_details).sort().join() === [...snap.stale_devices].sort().join(),
        'the details record is keyed by exactly the ids in the array');
    assert(Object.keys(snap.stale_agent_details).sort().join() === [...snap.stale_agents].sort().join(),
        'same for agents');
}

console.log('\nMERGE of the two documents one person is published under');
{
    type State = Parameters<typeof mergeIntentStates>[0];
    const base = (over: Partial<State>): State => ({
        schema_version: 1,
        user_id: 'petrus',
        devices: {},
        agents: {},
        stale_devices: [],
        stale_agents: [],
        stale_device_details: {},
        stale_agent_details: {},
        derived: {} as State['derived'],
        ...over,
    });

    const older = { updated_at: iso(9 * DAY), ttl_sec: 90, source_device: 'vta439', state: { model: 'old-model' } };
    const newer = { updated_at: iso(2 * DAY), ttl_sec: 90, source_device: 'vta439', state: { model: 'new-model' } };

    const merged = mergeIntentStates(
        base({
            devices: { macbook: { updated_at: iso(5 * SECOND) } },
            stale_devices: ['vta439', 'clawwatch'],
            stale_device_details: { vta439: older, clawwatch: older },
            stale_agents: ['claudemm'],
            stale_agent_details: { claudemm: older },
        }),
        base({
            // The same person's other id: vta439 is stale here too but fresher,
            // clawwatch is LIVE here, so it must leave the stale output.
            devices: { clawwatch: { updated_at: iso(3 * SECOND) } },
            stale_devices: ['vta439', 'macmini'],
            stale_device_details: { vta439: newer, macmini: older },
            stale_agents: ['claudemm'],
            stale_agent_details: { claudemm: newer },
        }),
    );

    assert(JSON.stringify(merged.stale_devices) === JSON.stringify(['vta439', 'macmini']),
        'stale_devices still dedupes through a Set and drops ids that are live in the other document');
    assert(merged.stale_agents.length === 1 && merged.stale_agents[0] === 'claudemm', 'stale_agents still dedupes');
    assert('clawwatch' in merged.devices, 'the live copy of clawwatch survives the merge');
    assert(!('clawwatch' in merged.stale_device_details), 'and its stale detail is dropped with its id');
    assert(merged.stale_device_details['vta439']?.state?.model === 'new-model',
        'the fresher of two details for one slot wins');
    assert(merged.stale_device_details['macmini']?.updated_at === older.updated_at, 'a detail only the second document has is kept');
    assert(merged.stale_agent_details['claudemm']?.state?.model === 'new-model', 'agents merge by the same rule');
    assert(Object.keys(merged.stale_device_details).sort().join() === [...merged.stale_devices].sort().join(),
        'array and details stay in step after a merge');
}

console.log('\nNEGATIVE CONTROL - the fixture has to be able to fail');
{
    // Every assertion above about surviving data is vacuous if nothing in the
    // fixture is stale, and every assertion about liveness is vacuous if
    // everything is. Prove both sides are populated, and that the detail
    // records actually differ from each other rather than being one constant.
    assert(Object.keys(snap.devices).length > 0 && Object.keys(snap.agents).length > 0, 'the fixture has live slots');
    assert(snap.stale_devices.length === 2 && snap.stale_agents.length === 1, 'and exactly the expected stale ones');
    assert(new Set(Object.values(snap.stale_device_details).map((d) => d.updated_at)).size === 2,
        'the stale details are distinct, so a hardcoded value could not pass');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
