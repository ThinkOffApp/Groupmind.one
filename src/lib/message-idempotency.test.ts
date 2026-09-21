// Unit test for client message id -> idempotency helpers
// Run: cd antfarm && npx tsx src/lib/message-idempotency.test.ts

import {
    parseClientMessageId, clientMessageKeyFor, clientMessageMetadata, isUniqueViolation, CLIENT_MESSAGE_ID_MAX,
    stripReservedClientFields, findMessageByClientKey,
} from './message-idempotency';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}`);
        failed++;
    }
}

console.log('\nparseClientMessageId');
assert(parseClientMessageId(undefined).id === null && !parseClientMessageId(undefined).error, 'absent -> null, no error');
assert(parseClientMessageId(null).id === null && !parseClientMessageId(null).error, 'null -> null, no error');
assert(parseClientMessageId('').id === null && !parseClientMessageId('').error, 'empty string -> null, no error');
assert(parseClientMessageId('   ').id === null && !parseClientMessageId('   ').error, 'whitespace only -> null, no error');
assert(parseClientMessageId('  abc-123 ').id === 'abc-123', 'trimmed');
assert(parseClientMessageId('9b2e6c0e-1f7b-4a4a-9c1e-0f0e1d2c3b4a').id === '9b2e6c0e-1f7b-4a4a-9c1e-0f0e1d2c3b4a', 'uuid passes');
assert(parseClientMessageId(42).error === 'client_message_id must be a string', 'number rejected');
assert(parseClientMessageId({ a: 1 }).error === 'client_message_id must be a string', 'object rejected');
assert(parseClientMessageId('x'.repeat(CLIENT_MESSAGE_ID_MAX)).id === 'x'.repeat(CLIENT_MESSAGE_ID_MAX), 'exactly max length passes');
assert(!!parseClientMessageId('x'.repeat(CLIENT_MESSAGE_ID_MAX + 1)).error, 'over max length rejected');
assert(!!parseClientMessageId('ab\ncd').error, 'newline rejected');
assert(!!parseClientMessageId('ab\u0000cd').error, 'NUL rejected');
assert(!!parseClientMessageId('ab\u007fcd').error, 'DEL rejected');
assert(parseClientMessageId('ab cd-ef_gh.ij').id === 'ab cd-ef_gh.ij', 'inner spaces, dashes, underscores and dots pass');

console.log('\nclientMessageKeyFor / clientMessageMetadata');
assert(clientMessageKeyFor('agent-1', 'm1') === 'cmid:agent-1:m1', 'key shape');
assert(clientMessageKeyFor('agent-1', 'm1') !== clientMessageKeyFor('agent-2', 'm1'), 'same client id, different senders -> different keys');
assert(clientMessageKeyFor('agent-1', 'm1') === clientMessageKeyFor('agent-1', 'm1'), 'deterministic');
const meta = clientMessageMetadata('agent-1', 'm1');
assert(meta.client_message_id === 'm1' && meta.client_message_key === 'cmid:agent-1:m1', 'metadata carries both the echoable id and the dedupe key');
assert(Object.keys(meta).length === 2, 'metadata adds exactly two fields');

console.log('\nstripReservedClientFields');
const stripped = stripReservedClientFields({ reply_to: 'r1', client_message_id: 'forged', client_message_key: 'cmid::' });
assert(stripped.reply_to === 'r1' && !('client_message_id' in stripped) && !('client_message_key' in stripped), 'reserved fields removed, others kept');
assert(Object.keys(stripReservedClientFields(null)).length === 0 && Object.keys(stripReservedClientFields(undefined)).length === 0, 'null/undefined -> empty object');
assert(Object.keys(stripReservedClientFields('nope' as unknown as Record<string, unknown>)).length === 0, 'non-object -> empty object');
const original = { a: 1, client_message_key: 'x' };
stripReservedClientFields(original);
assert('client_message_key' in original, 'input object is not mutated');

console.log('\nfindMessageByClientKey');
(async () => {
    const calls: Array<[string, unknown]> = [];
    const stubRow = { id: 'm-1', created_at: 't', body: 'stored' };
    const makeDb = (rows: unknown[]) => ({
        from: (table: string) => {
            calls.push(['from', table]);
            const q = {
                select: (c: string) => { calls.push(['select', c]); return q; },
                eq: (col: string, val: unknown) => { calls.push(['eq', `${col}=${val}`]); return q; },
                limit: (n: number) => { calls.push(['limit', n]); return Promise.resolve({ data: rows }); },
            };
            return q;
        },
    });
    const hit = await findMessageByClientKey(makeDb([stubRow]), 'cmid:a:1', 'agent-a', 'id, created_at, body');
    assert(hit === stubRow, 'returns the first stored row');
    assert(calls.some(c => c[0] === 'eq' && c[1] === 'from_agent_id=agent-a'), 'filters by the authenticated sender');
    assert(calls.some(c => c[0] === 'eq' && c[1] === 'metadata->>client_message_key=cmid:a:1'), 'filters by the client key');
    const miss = await findMessageByClientKey(makeDb([]), 'cmid:a:2', 'agent-a', 'id');
    assert(miss === null, 'no row -> null');

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();

console.log('\nisUniqueViolation');
assert(isUniqueViolation({ code: '23505' }), '23505 is a unique violation');
assert(!isUniqueViolation({ code: '42703' }), 'other codes are not');
assert(!isUniqueViolation(null) && !isUniqueViolation(undefined), 'null/undefined are not');
// The async findMessageByClientKey block above prints the summary and exits.
