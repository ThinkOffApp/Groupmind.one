// SPDX-License-Identifier: AGPL-3.0-only
// Unit test for the room "Mentions" filter
// Run: cd antfarm && npx tsx src/lib/mentions.test.ts

import { isAddressedTo, mentionsHandle, normalizeHandle, pickAdjacentAnchor, stepFromAnchorId } from './mentions';

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

console.log('\nnormalizeHandle');
assert(normalizeHandle('@Petrus') === 'petrus', 'strips @ and lower-cases');
assert(normalizeHandle('  petrus ') === 'petrus', 'trims');
assert(normalizeHandle(null) === '' && normalizeHandle(undefined) === '', 'null/undefined -> empty');

console.log('\nmentionsHandle');
assert(mentionsHandle('@petrus button above merges', 'petrus'), 'mention at start');
assert(mentionsHandle('done, @Petrus please tap', 'petrus'), 'mention mid-sentence, case-insensitive');
assert(mentionsHandle('(@petrus)', 'petrus'), 'mention in parentheses');
assert(mentionsHandle('@petrus, @claudeMB', 'petrus'), 'mention before comma');
assert(!mentionsHandle('@petrus2 is someone else', 'petrus'), 'longer handle with the same prefix is not a match');
assert(!mentionsHandle('@petrus.dev posted', 'petrus'), 'dotted longer handle is not a match');
assert(!mentionsHandle('petrus without the at-sign', 'petrus'), 'bare name is not a mention');
assert(!mentionsHandle('email me at x@petrus', 'petrus'), 'an email-like token is not a mention');
assert(!mentionsHandle('', 'petrus') && !mentionsHandle('@petrus', ''), 'empty body or handle -> false');
assert(mentionsHandle('hi @a.b-c_d', 'a.b-c_d'), 'handles with dots, dashes and underscores work');

console.log('\nisAddressedTo');
const me = '@petrus';
assert(isAddressedTo({ from: '@claudemm', body: '@petrus codex is clean' }, me), 'mentioned -> addressed');
assert(isAddressedTo({ from: '@codexmb', body: 'reviewed', reply_to: { from: 'petrus' } }, me), 'reply to my message -> addressed (reply_to.from without @)');
assert(isAddressedTo({ from: '@codexmb', body: 'reviewed', reply_to: { from: '@Petrus' } }, me), 'reply_to.from with @ and capitals');
assert(isAddressedTo({ from: 'petrus', body: 'guys I' }, me), 'my own message -> shown (keeps my question above the answers)');
assert(!isAddressedTo({ from: '@claudeMB', body: '@codexmb please re-check', reply_to: { from: '@claudemm' } }, me), 'agent chatter not about me -> hidden');
assert(!isAddressedTo({ from: '@hermes', body: 'status', reply_to: null }, me), 'null reply_to handled');
assert(!isAddressedTo({ from: '@claudemm', body: '@petrus hi' }, ''), 'no handle known -> nothing matches');

console.log('\npickAdjacentAnchor (the up/down arrows)');
// Anchor offsets in document order, oldest first -- as the room renders them.
const pos = [0, 100, 200, 300];
assert(pickAdjacentAnchor(pos, 150, 'prev') === 1, 'prev from between anchors -> the one above');
assert(pickAdjacentAnchor(pos, 150, 'next') === 2, 'next from between anchors -> the one below');
assert(pickAdjacentAnchor(pos, 0, 'prev') === null, 'nothing above the first -> null, so the button disables rather than jumping');
assert(pickAdjacentAnchor(pos, 300, 'next') === null, 'nothing below the last -> null');
// The bug this tolerance exists for: parked exactly ON an anchor, a second
// press must move OFF it instead of re-selecting the same message.
assert(pickAdjacentAnchor(pos, 200, 'prev') === 1, 'parked on an anchor, prev moves to the previous one');
assert(pickAdjacentAnchor(pos, 200, 'next') === 3, 'parked on an anchor, next moves to the following one');
assert(pickAdjacentAnchor(pos, 203, 'next') === 3, 'a few pixels off an anchor still counts as parked on it');
assert(pickAdjacentAnchor([], 0, 'prev') === null && pickAdjacentAnchor([], 0, 'next') === null, 'no anchors at all -> null both ways');
assert(pickAdjacentAnchor([500], 0, 'next') === 0, 'a single anchor below is reachable');
assert(pickAdjacentAnchor([500], 900, 'prev') === 0, 'a single anchor above is reachable');

console.log('\npickAdjacentAnchor with REAL row geometry (the bug pure numbers missed)');
// @codexmb, 18 Sep: the room compared row.offsetTop against a cursor that
// scrollIntoView(center) had parked on the row's CENTRE. Model that properly:
// four rows 120px tall, and a cursor sitting where a jump actually leaves it.
const H = 120;
const tops = [0, 200, 400, 600];
const centres = tops.map(t => t + H / 2);
const parkedOn = (i: number) => centres[i];   // where scrollIntoView(center) leaves us

// Correct: compare centres against a centre.
assert(pickAdjacentAnchor(centres, parkedOn(2), 'prev') === 1, 'centres: prev from row 2 -> row 1');
assert(pickAdjacentAnchor(centres, parkedOn(2), 'next') === 3, 'centres: next from row 2 -> row 3');
assert(pickAdjacentAnchor(centres, parkedOn(0), 'prev') === null, 'centres: no row above the first');
assert(pickAdjacentAnchor(centres, parkedOn(3), 'next') === null, 'centres: no row below the last');

// The regression itself: tops against a centred cursor re-selects the CURRENT
// row, because its top is half a row-height above the cursor. This assertion
// documents the broken combination so nobody reintroduces it.
assert(pickAdjacentAnchor(tops, parkedOn(2), 'prev') === 2,
    'MIXED UNITS REGRESSION: tops vs a centred cursor re-selects the current row (why the room passes centres)');

// Walking up and then down across tall rows must never stall on one row.
let i = 3;
const seen: number[] = [i];
for (let step = 0; step < 3; step++) {
    const next = pickAdjacentAnchor(centres, parkedOn(i), 'prev');
    assert(next !== null && next !== i, `repeated prev moves off row ${i}`);
    i = next as number;
    seen.push(i);
}
assert(seen.join(',') === '3,2,1,0', 'prev walks 3->2->1->0 without repeating');
for (let step = 0; step < 3; step++) {
    const next = pickAdjacentAnchor(centres, parkedOn(i), 'next');
    assert(next !== null && next !== i, `repeated next moves off row ${i}`);
    i = next as number;
}
assert(i === 3, 'next walks back to the last row');

// Rows of different heights, which is the real room: a 40px line and a 400px
// code block must both be left correctly by one press.
const mixedH = [40, 400, 60, 300];
const mixedTops = [0, 40, 440, 500];
const mixedCentres = mixedTops.map((t, k) => t + mixedH[k] / 2);
assert(pickAdjacentAnchor(mixedCentres, mixedCentres[1], 'prev') === 0, 'tall row: prev leaves it');
assert(pickAdjacentAnchor(mixedCentres, mixedCentres[1], 'next') === 2, 'tall row: next leaves it');
assert(pickAdjacentAnchor(mixedCentres, mixedCentres[0], 'next') === 1, 'short row: next leaves it');

console.log('\nstepFromAnchorId (identity cursor -- what actually ships)');
const anchors = ['m0', 'm1', 'm3', 'm5', 'm6', 'm9'];
assert(stepFromAnchorId(anchors, 'm3', 'prev') === 1, 'prev from m3 -> m1');
assert(stepFromAnchorId(anchors, 'm3', 'next') === 3, 'next from m3 -> m5');
assert(stepFromAnchorId(anchors, 'm0', 'prev') === null, 'nothing before the first -> null');
assert(stepFromAnchorId(anchors, 'm9', 'next') === null, 'nothing after the last -> null');
assert(stepFromAnchorId(anchors, null, 'next') === -1, 'no cursor -> -1, caller uses geometry');
assert(stepFromAnchorId(anchors, 'gone', 'prev') === -1, 'cursor scrolled out of the window -> -1');
// The reason the cursor is an ID and not an index: the list grows underneath it.
const grown = ['mNEW', ...anchors];
assert(stepFromAnchorId(grown, 'm3', 'prev') === 2, 'a message arriving above does not shift the cursor');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
