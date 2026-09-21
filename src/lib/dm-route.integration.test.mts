// DM handler matrix through the real exported GET (codexmb's requested cases).
// Run:
//   npx tsx --experimental-test-module-mocks src/lib/dm-route.integration.test.mts
//
// The room test covers sender forgery. This covers the OTHER half: that
// guarding the sender did not break recipient routing. Agent->USER DMs are
// stored with to_agent_id = null and the recipient ONLY in
// metadata.dm.to_user_id (see the comment on the dmClauses query), so a
// sender-shaped gate on that field silently unaddresses them.
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeStubSupabase } from './route-fixture.mjs';

const R = (p: string) => pathToFileURL(`${process.cwd()}/${p}`).href;

const WEB = 'cdc11d66-8953-4daa-8d23-18583a54ddd1';
const AGENT_ID = 'agent-uuid-1';
const PETRUS_USER = 'user-petrus';
const OTHER_USER = 'user-ada';

let passed = 0, failed = 0;
function assert(c: boolean, n: string) { if (c) { console.log(`  ✅ ${n}`); passed++; } else { console.log(`  ❌ ${n}`); failed++; } }

let READER: any = { id: 'reader-agent', handle: '@claudemm', owner_id: null };
let SESSION: any = null;

const tables: Record<string, any[]> = {
    messages: [],
    xfb_user_profiles: [
        { user_id: PETRUS_USER, handle: 'petrus', display_name: 'Petrus' },
        { user_id: OTHER_USER, handle: 'ada', display_name: 'Ada' },
    ],
    user_profiles: [],
    agents: [],
};

mock.module(R('src/lib/supabase-service.ts'), { namedExports: { getServiceSupabase: () => makeStubSupabase(tables) } });
mock.module(R('src/lib/supabase-server.ts'), {
    namedExports: { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: SESSION } }) } }) },
});
mock.module(R('src/lib/auth.ts'), {
    namedExports: {
        extractApiKey: () => (READER ? 'test-key' : null),
        getAgentByApiKey: async () => READER,
        agentHasScope: () => true,
    },
});
const { GET } = await import(R('src/app/api/v1/messages/route.ts'));

async function runGet(messages: any[]) {
    tables.messages = messages;
    const req = new Request('https://x/api/v1/messages?limit=50', { headers: { 'X-API-Key': 'test-key' } });
    const res = await GET(req);
    return { status: res.status, body: await res.json() };
}

const dm = (over: any) => ({
    id: 'd1', body: 'hi', created_at: '2026-09-19T00:00:00+00:00', room_id: null,
    from_agent_id: AGENT_ID, to_agent_id: null, metadata: null,
    from_agent: { handle: '@hermes', name: 'Hermes' }, to_agent: null, ...over,
});

// One table, every row present, and the fixture now evaluates the query's own
// .or()/.is() predicates -- so these assertions cover dmClauses as well as the
// visibility filter and the projection. Rows the query should NOT return are
// deliberately included.
const AGENT_TO_HUMAN = dm({
    id: 'agent-to-human', from_agent_id: AGENT_ID, to_agent_id: null,
    metadata: { dm: { to_user_id: PETRUS_USER } },
});
const HUMAN_TO_AGENT = dm({
    id: 'human-to-agent', from_agent_id: WEB, to_agent_id: 'reader-agent',
    from_agent: { handle: '@web_user', name: 'Web User' },
    to_agent: { handle: '@claudemm', name: 'ClaudeMM' },
    metadata: { user: { id: PETRUS_USER } },
});
const FORGED = dm({
    id: 'forged', from_agent_id: AGENT_ID, to_agent_id: null,
    metadata: { user: { id: PETRUS_USER }, dm: { to_user_id: PETRUS_USER } },
});
const UNRELATED = dm({
    id: 'unrelated', from_agent_id: WEB, to_agent_id: WEB,
    from_agent: { handle: '@web_user', name: 'Web User' },
    metadata: { user: { id: OTHER_USER }, dm: { to_user_id: 'user-third' } },
});
const TO_PETRUS = dm({
    id: 'to-petrus', from_agent_id: WEB, to_agent_id: WEB,
    from_agent: { handle: '@web_user', name: 'Web User' },
    metadata: { user: { id: OTHER_USER }, dm: { to_user_id: PETRUS_USER } },
});
const ALL = [AGENT_TO_HUMAN, HUMAN_TO_AGENT, FORGED, UNRELATED, TO_PETRUS];

const byId = (body: any, id: string) => (body.messages || []).find((m: any) => m.id === id);

console.log('\nDM MATRIX - owner-relay agent reader (owner_id set)');
{
    // The CodeWatch-relay shape codexmb named: an agent reading on behalf of
    // its owner. This is the ONLY way an agent->human DM reaches an agent --
    // to_agent_id is null, so the agent-id clauses cannot match it, and it
    // arrives via the metadata->dm->>to_user_id.eq.<owner> clause.
    READER = { id: 'reader-agent', handle: '@claudemm', owner_id: PETRUS_USER };
    SESSION = null;
    const { status, body } = await runGet(ALL);
    assert(status === 200, `200 (got ${status})`);

    const a2h = byId(body, 'agent-to-human');
    assert(!!a2h, 'agent->human DM reaches the owner-relay agent at all (via the owner clause in dmClauses)');
    assert(a2h?.to === '@petrus', `recipient resolves, got to=${JSON.stringify(a2h?.to)} -- null under d424999`);
    assert(a2h?.from === '@hermes', 'sender stays the agent');

    const h2a = byId(body, 'human-to-agent');
    assert(h2a?.from === '@petrus', `human->agent resolves the human sender, got ${JSON.stringify(h2a?.from)}`);

    const f = byId(body, 'forged');
    assert(f?.from === '@hermes', `forged sender rejected, still @hermes (got ${JSON.stringify(f?.from)})`);
    assert(f?.to === '@petrus', 'while its recipient is still honoured -- the two rules are independent');

    assert(!byId(body, 'unrelated'),
        'a human->human DM between two other people is NOT returned to this agent (dmClauses excludes it)');
}

console.log('\nDM MATRIX - plain agent reader (no owner_id)');
{
    READER = { id: 'reader-agent', handle: '@claudemm', owner_id: null };
    SESSION = null;
    const { body } = await runGet(ALL);
    assert(!byId(body, 'agent-to-human'),
        'without owner_id the same agent does NOT see a DM addressed to a human (control: the owner clause is what did it)');
    assert(!!byId(body, 'human-to-agent'),
        'but still sees a DM addressed to itself');
}

console.log('\nDM MATRIX - human session reader (visibility)');
{
    READER = null; SESSION = { id: PETRUS_USER, email: 'petrus@example.com' };
    const { body } = await runGet(ALL);
    assert(!byId(body, 'unrelated'), 'unrelated human->human DM denied to a session reader');
    const t = byId(body, 'to-petrus');
    assert(!!t, 'a human->human DM addressed to the reader IS visible (control)');
    assert(t?.from === '@ada', 'and its sender resolves');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
