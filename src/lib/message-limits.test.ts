// Unit test for the shared message body limit (PR #134)
// Run: cd antfarm && npx tsx src/lib/message-limits.test.ts

import { MESSAGE_BODY_MAX_CHARS, messageBodyTooLong } from './message-limits';

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

console.log('message-limits');

assert(MESSAGE_BODY_MAX_CHARS === 20000, 'limit is 20,000 characters');
assert(messageBodyTooLong('') === null, 'empty body is not too long (emptiness is checked elsewhere)');
assert(messageBodyTooLong('x'.repeat(4001)) === null, '4,001 characters accepted (the old rooms-route cap was 4,000)');
assert(messageBodyTooLong('x'.repeat(12981)) === null, '12,981 characters accepted (the paste that failed on 2026-09-15)');
assert(messageBodyTooLong('x'.repeat(20000)) === null, 'exactly 20,000 characters accepted');

const over = messageBodyTooLong('x'.repeat(20001));
assert(over !== null, '20,001 characters rejected');
assert(over !== null && over.includes('20000') && over.includes('20001'), 'rejection names the limit and the actual length');

// The limit counts UTF-16 code units, the same unit String.length uses on
// both routes, so an astral character (emoji) counts as two. This pins that
// behaviour so a future change to grapheme counting is a deliberate one.
const emoji = '\u{1F600}';
assert(emoji.length === 2, 'an astral emoji is two code units');
assert(messageBodyTooLong(emoji.repeat(10000)) === null, '10,000 emoji (20,000 code units) accepted');
assert(messageBodyTooLong(emoji.repeat(10001)) !== null, '10,001 emoji (20,002 code units) rejected');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
