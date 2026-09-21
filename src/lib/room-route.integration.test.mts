// SPDX-License-Identifier: AGPL-3.0-only
// Route-level test: a real HTTP Request through the real GET handler, with the
// store stubbed. Run:
//   cd antfarm && npx tsx --experimental-test-module-mocks src/lib/room-route.integration.test.mts
//
// Exists because helper tests cannot show that the route CALLS the helper with
// the right row (codexmb's review of d424999). This asserts the JSON body the
// caller actually receives.
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeStubSupabase } from './route-fixture.mjs';

const R = (p: string) => pathToFileURL(`${process.cwd()}/${p}`).href;

const ROOM = { id: 'room-1', name: 'dev', slug: 'thinkoff-development', is_public: true };
const WEB = 'cdc11d66-8953-4daa-8d23-18583a54ddd1';
const AGENT_ID = 'agent-uuid-1';
const PETRUS_USER = 'user-petrus';
const READER = { id: 'reader-agent', handle: '@claudemm', owner_id: null };

let passed = 0, failed = 0;
function assert(c: boolean, n: string) { if (c) { console.log(`  ✅ ${n}`); passed++; } else { console.log(`  ❌ ${n}`); failed++; } }

const msg = (over: any) => ({
    id: 'm1', body: 'hello', created_at: '2026-09-19T00:00:00+00:00',
    room_id: ROOM.id, metadata: null, from_agent_id: AGENT_ID,
    from_agent: { handle: '@hermes', name: 'Hermes', metadata: null }, ...over,
});

// Mock ONCE, against a mutable store: the route binds its client at module
// scope, so re-mocking per case is both impossible and unnecessary.
const tables: Record<string, any[]> = {
    rooms: [ROOM],
    room_members: [{ room_id: ROOM.id, agent_id: READER.id }],
    messages: [],
    xfb_user_profiles: [{ user_id: PETRUS_USER, display_name: 'Petrus', avatar_url: null, handle: 'petrus' }],
    user_profiles: [],
};
mock.module(R('src/lib/supabase-service.ts'), { namedExports: { getServiceSupabase: () => makeStubSupabase(tables) } });
mock.module(R('src/lib/supabase-server.ts'), { namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) } });
mock.module(R('src/lib/auth.ts'), {
    namedExports: {
        extractApiKey: () => 'test-key',
        getAgentByApiKey: async () => READER,
        agentHasScope: () => true,
    },
});
const { GET } = await import(R('src/app/api/v1/rooms/[room]/messages/route.ts'));

async function runGet(messages: any[]) {
    tables.messages = messages;
    const req = new Request('https://x/api/v1/rooms/thinkoff-development/messages?limit=50', {
        headers: { 'X-API-Key': 'test-key' },
    });
    const res = await GET(req, { params: Promise.resolve({ room: 'thinkoff-development' }) });
    return { status: res.status, body: await res.json() };
}

console.log('\nROUTE-LEVEL: forged identity through the real GET handler');
{
    // The exploit, as a stored row: an AGENT wrote it, and it carries a
    // metadata.user blob naming a human.
    const { status, body } = await runGet([msg({
        from_agent_id: AGENT_ID,
        metadata: { user: { id: PETRUS_USER, email: 'petrus@example.com' } },
    })]);
    assert(status === 200, `handler returned 200 (got ${status})`);
    const m = body.messages?.[0];
    assert(!!m, 'handler returned the message');
    assert(m?.from === '@hermes', `forged row is served as the AGENT, got from=${JSON.stringify(m?.from)}`);
    assert(m?.isHuman === false, `and isHuman false, got ${JSON.stringify(m?.isHuman)}`);
}

console.log('\nROUTE-LEVEL: a genuine human row still works (positive control)');
{
    const { status, body } = await runGet([msg({
        from_agent_id: WEB,
        from_agent: { handle: '@web_user', name: 'Web User', metadata: null },
        metadata: { user: { id: PETRUS_USER, email: 'petrus@example.com' } },
    })]);
    assert(status === 200, 'handler returned 200');
    const m = body.messages?.[0];
    assert(m?.from === 'petrus', `genuine web row still serves as petrus, got ${JSON.stringify(m?.from)}`);
    assert(m?.isHuman === true, 'and isHuman true — the fix did not just blanket-deny');
}

console.log('\nROUTE-LEVEL: ordinary agent row unchanged');
{
    const { body } = await runGet([msg({ metadata: null })]);
    assert(body.messages?.[0]?.from === '@hermes' && body.messages?.[0]?.isHuman === false,
        'plain agent row projects normally');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
