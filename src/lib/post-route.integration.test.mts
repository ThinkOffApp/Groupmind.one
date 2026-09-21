// SPDX-License-Identifier: AGPL-3.0-only
// Authenticated generic POST through the real handler: what actually lands in
// the stored row (codexmb's last requested integration case).
// Run:
//   npx tsx --experimental-test-module-mocks src/lib/post-route.integration.test.mts
//
// The GET tests show a forged row cannot claim a sender on the way OUT. This
// shows the forgery never reaches the table on the way IN, while everything
// the confirmation and choice cards depend on still does.
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeStubSupabase } from './route-fixture.mjs';

const R = (p: string) => pathToFileURL(`${process.cwd()}/${p}`).href;

const AGENT = { id: 'agent-uuid-1', handle: '@hermes', name: 'Hermes', owner_id: null, scopes: ['messages:write'] };
const PETRUS_USER = 'user-petrus';
const OTHER_USER = 'user-ada';
const ROOM = { id: 'room-1', name: 'dev', slug: 'thinkoff-development', is_public: true };

let passed = 0, failed = 0;
function assert(c: boolean, n: string) { if (c) { console.log(`  ✅ ${n}`); passed++; } else { console.log(`  ❌ ${n}`); failed++; } }

let SESSION: any = null;
let READER: any = AGENT;
const tables: Record<string, any[]> = { rooms: [ROOM], room_members: [{ room_id: ROOM.id, agent_id: AGENT.id }, { room_id: ROOM.id, user_id: PETRUS_USER }], messages: [], agents: [], xfb_user_profiles: [], user_profiles: [] };
const inserts: { table: string; row: any }[] = [];

mock.module(R('src/lib/supabase-service.ts'), { namedExports: { getServiceSupabase: () => makeStubSupabase(tables, [], inserts) } });
mock.module(R('src/lib/supabase-server.ts'), { namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: SESSION } }) } }) } });
mock.module(R('src/lib/auth.ts'), {
    namedExports: { extractApiKey: () => (READER ? 'k' : null), getAgentByApiKey: async () => READER, agentHasScope: () => true },
});
// Recipient resolution is the SERVER's job and the source of dm.to_user_id —
// stubbed so the test can assert the server's value lands, not the caller's.
mock.module(R('src/lib/resolve-recipient.ts'), {
    namedExports: {
        resolveRecipient: async (_db: any, to: string) =>
            (String(to).replace(/^@/, '') === 'ada'
                ? { agentId: null, userId: OTHER_USER }
                : { agentId: null, userId: null }),
    },
});
mock.module(R('src/lib/webhook.ts'), {
    namedExports: { sendRoomWebhook: async () => {}, sendDMWebhook: async () => {}, extractMentions: () => [] },
});

// `after()` throws outside a Next request scope, which turns a successful
// POST into a 500 AFTER the row is already stored. Neutralise just that,
// keeping the real NextResponse so status codes stay meaningful.
const realNext = await import('next/server');
mock.module('next/server', {
    namedExports: { ...realNext, after: (fn: any) => { void fn; } },
});

const { POST } = await import(R('src/app/api/v1/messages/route.ts'));

async function post(payload: any, label = 'request') {
    inserts.length = 0;
    const req = new Request('https://x/api/v1/messages', {
        method: 'POST', headers: { 'X-API-Key': 'k', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const res = await POST(req);
    const out = { status: res.status, body: await res.json().catch(() => null), stored: inserts.find(i => i.table === 'messages')?.row };
    // Assert the status on EVERY case, not just the first (codexmb). A route
    // that throws AFTER the insert still leaves `stored` populated, so an
    // assertion that only inspects the row passes a 500 -- which is exactly
    // what next/server's after() did here before it was neutralised.
    assert(out.status === 200 || out.status === 201,
        `${label}: POST succeeded (got ${out.status}${out.status >= 400 ? ' ' + JSON.stringify(out.body) : ''})`);
    if (process.env.DEBUG_POST) console.log('    [debug] status', out.status, 'stored?', !!out.stored, 'body', JSON.stringify(out.body).slice(0, 200));
    return out;
}

console.log('\nPOST — a spoofed identity never reaches the stored row');
{
    const { stored } = await post({
        room: 'thinkoff-development', body: 'pretending to be the owner',
        metadata: { user: { id: PETRUS_USER, email: 'petrus@example.com' }, dm: { to_user_id: PETRUS_USER } },
    }, 'spoofed identity');
    assert(!!stored, 'a row was stored');
    assert(stored?.from_agent_id === AGENT.id, 'stored under the AUTHENTICATED agent id');
    assert(!stored?.metadata?.user, `caller metadata.user stripped, got ${JSON.stringify(stored?.metadata?.user)}`);
    assert(!stored?.metadata?.dm, `caller metadata.dm stripped, got ${JSON.stringify(stored?.metadata?.dm)}`);
}

console.log('\nPOST — what the cards depend on still survives');
{
    const { stored } = await post({
        room: 'thinkoff-development', body: '[Choice needed] pick a model',
        metadata: { actions: ['claude-opus-5', 'claude-sonnet-5'], intent_id: '4153315f', user: { id: PETRUS_USER } },
    }, 'card metadata');
    assert(Array.isArray(stored?.metadata?.actions) && stored.metadata.actions.length === 2,
        'actions survive — every Approve/Deny and choice card depends on this');
    assert(stored?.metadata?.intent_id === '4153315f', 'intent_id survives — without it a card cannot be settled');
    assert(!stored?.metadata?.user, 'and the spoof in the same object is still removed');
}

console.log('\nPOST — the server re-adds the values it owns');
{
    // A DM to a human: the server resolves the recipient and writes
    // dm.to_user_id itself. The caller supplied a DIFFERENT one, which must lose.
    const { stored } = await post({
        to: '@ada', body: 'hello ada',
        metadata: { dm: { to_user_id: PETRUS_USER } },
    }, 'dm recipient');
    assert(stored?.metadata?.dm?.to_user_id === OTHER_USER,
        `server-resolved recipient wins over the caller's, got ${JSON.stringify(stored?.metadata?.dm?.to_user_id)}`);
}
{
    // A genuine human session post: the server re-adds metadata.user from the
    // session, so the strip does not cost real attribution.
    READER = null; SESSION = { id: PETRUS_USER, email: 'petrus@example.com' };
    const { stored } = await post({ room: 'thinkoff-development', body: 'from the browser' }, 'session post');
    assert(stored?.metadata?.user?.id === PETRUS_USER,
        `a genuine session post still records its human sender, got ${JSON.stringify(stored?.metadata?.user)}`);
    READER = AGENT; SESSION = null;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
