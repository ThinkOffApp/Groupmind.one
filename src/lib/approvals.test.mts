// Unit test for the approvals half of the queue.
// Run: npx tsx src/lib/approvals.test.mts
//
// No Supabase: the client is injected, so the freshness guard and the
// owner scoping are exercised against a stub. What this CANNOT show is that
// the SQL function behaves as documented - see the PR body.

import { decideApproval, listPendingApprovals } from './approvals';

let passed = 0;
let failed = 0;
function assert(c: boolean, n: string) {
    if (c) {
        console.log(`  ✅ ${n}`);
        passed++;
    } else {
        console.log(`  ❌ ${n}`);
        failed++;
    }
}

const USER = 'user-uuid-1';
const OTHER = 'user-uuid-2';

interface Call { table?: string; filters: Record<string, unknown>; rpc?: string; args?: any }

/** Records the filters a query applied and returns the rows it is given. */
function stubClient(rows: any[], opts: { rpcError?: boolean } = {}) {
    const calls: Call[] = [];
    let currentCall: Call;
    const builder: any = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
            currentCall.filters[col] = val;
            return builder;
        },
        order: () => builder,
        limit: () => {
            const filtered = rows.filter((r) =>
                Object.entries(currentCall.filters).every(([k, v]) => r[k] === v)
            );
            return Promise.resolve({ data: filtered, error: null });
        },
        maybeSingle: () => {
            const filtered = rows.filter((r) =>
                Object.entries(currentCall.filters).every(([k, v]) => r[k] === v)
            );
            return Promise.resolve({ data: filtered[0] ?? null, error: null });
        },
    };
    return {
        calls,
        client: {
            from(table: string) {
                currentCall = { table, filters: {} };
                calls.push(currentCall);
                return builder;
            },
            rpc(name: string, args: any) {
                calls.push({ rpc: name, args, filters: {} });
                return Promise.resolve({ data: null, error: opts.rpcError ? { message: 'boom' } : null });
            },
        } as any,
    };
}

const pendingRow = (over: Record<string, unknown> = {}) => ({
    intent_id: 'intent-1',
    owner_id: USER,
    status: 'pending',
    target_summary: 'Restart the Pi',
    actor: '@claudemm',
    created_at: '2026-09-20T10:00:00Z',
    updated_at: '2026-09-20T10:00:00Z',
    ...over,
});

console.log('\nlistPendingApprovals');
{
    const { client, calls } = stubClient([
        pendingRow(),
        pendingRow({ intent_id: 'intent-2', status: 'approved' }),
        pendingRow({ intent_id: 'intent-3', owner_id: OTHER }),
    ]);
    const rows = await listPendingApprovals(USER, client);
    assert(rows.length === 1 && rows[0].intent_id === 'intent-1', 'only this person’s pending rows come back');
    assert(calls[0].filters.owner_id === USER, 'the query is scoped to the signed-in user');
    assert(calls[0].filters.status === 'pending', 'and to pending rows');
    assert(calls[0].table === 'action_status', 'it reads the table the agent side already writes');
}

console.log('\ndecideApproval: the freshness guard');
{
    const { client, calls } = stubClient([pendingRow()]);
    const out = await decideApproval(USER, 'intent-1', 'approve', '2026-09-20T10:00:00Z', USER, client);
    assert(out.ok === true, 'a decision on an unchanged row is recorded');
    const rpc = calls.find((c) => c.rpc);
    assert(rpc?.rpc === 'upsert_action_status', 'through the same SQL function the agent side uses');
    assert(rpc?.args.p_status === 'approved' && rpc?.args.p_decision === 'approve', 'as an approval');
    assert(rpc?.args.p_owner_id === USER, 'scoped to this user');
    assert(typeof rpc?.args.p_decided_at === 'string', 'with a decision timestamp');
}
{
    const { client } = stubClient([pendingRow()]);
    const out = await decideApproval(USER, 'intent-1', 'deny', '2026-09-20T10:00:00Z', USER, client);
    assert(out.ok === true, 'a denial is recorded too');
}
{
    // THE GUARD: the agent revised the request after the person read it.
    const { client, calls } = stubClient([pendingRow({ updated_at: '2026-09-20T11:00:00Z' })]);
    const out = await decideApproval(USER, 'intent-1', 'approve', '2026-09-20T10:00:00Z', USER, client);
    assert(out.ok === false, 'a request that changed since it was read is NOT approved');
    assert(out.ok === false && out.stale === true, 'and is reported as stale');
    assert(out.ok === false && /changed since you read it/i.test(out.reason), 'with a reason a person can act on');
    assert(!calls.some((c) => c.rpc), 'and nothing is written');
}
{
    const { client, calls } = stubClient([pendingRow({ status: 'approved' })]);
    const out = await decideApproval(USER, 'intent-1', 'deny', '2026-09-20T10:00:00Z', USER, client);
    assert(out.ok === false && /already approved/i.test(out.reason), 'an already-decided action is not decided again');
    assert(!calls.some((c) => c.rpc), 'and nothing is written');
}
{
    const { client, calls } = stubClient([pendingRow({ owner_id: OTHER })]);
    const out = await decideApproval(USER, 'intent-1', 'approve', '2026-09-20T10:00:00Z', USER, client);
    assert(out.ok === false && /not yours/i.test(out.reason), 'another person’s action cannot be decided');
    assert(!calls.some((c) => c.rpc), 'and nothing is written');
}
{
    const { client } = stubClient([pendingRow()], { rpcError: true });
    const out = await decideApproval(USER, 'intent-1', 'approve', '2026-09-20T10:00:00Z', USER, client);
    assert(out.ok === false && /Could not record/.test(out.reason), 'a write failure is an outcome, never a silent success');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
