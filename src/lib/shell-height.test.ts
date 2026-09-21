// The room column measured itself into a loop. Run:
//   npx tsx src/lib/shell-height.test.ts
//
// THE TEST THAT MATTERS is the first block. It is written from a recording of
// the live bug, taken on groupmind.one in the thinkoff-development room on
// 2026-09-20: at any window width >= 1024px the column flipped 620 -> 617 ->
// 620 -> 617 for as long as the room was open, which is what the owner saw as
// shaking. The numbers below are those measurements, not invented ones.
//
// It was written against the naive `nextShellHeight` (accept every computed
// value) and watched to FAIL there before the real decision function existed.

import {
    computeShellHeight,
    nextShellHeight,
    SHELL_MIN_HEIGHT,
    type ShellHeightDecision,
} from './shell-height';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string) {
    if (cond) { console.log(`  ✅ ${name}`); passed++; }
    else { console.log(`  ❌ ${name}`); failed++; }
}

// Drives the real feedback path: a measure function that is a pure function of
// the height currently applied to the column - which is what made this a loop
// rather than a one-off miscalculation. Returns every height actually
// committed to state, so a cycle shows up as a repeating tail.
function run(
    measureFrom: (applied: number | null) => number,
    steps: number,
    start: number | null = null,
): { committed: number[]; decisions: ShellHeightDecision[] } {
    let current = start;
    const history: number[] = start === null ? [] : [start];
    const committed: number[] = [];
    const decisions: ShellHeightDecision[] = [];
    for (let i = 0; i < steps; i++) {
        const decision = nextShellHeight(current, measureFrom(current), history);
        decisions.push(decision);
        if (decision.height !== null) {
            current = decision.height;
            history.push(decision.height);
            committed.push(decision.height);
        }
    }
    return { committed, decisions };
}

// The recording. At 620 the column overflows <main> by 3px, that overflow is
// counted as content below the column, and the next measure comes back 617; at
// 617 nothing overflows, so the next measure comes back 620 again.
const liveShake = (applied: number | null) => (applied === 620 ? 617 : 620);

console.log('\nOSCILLATION — the live 620/617 shake, the test that matters');
{
    const { committed, decisions } = run(liveShake, 12, 620);
    // The naive implementation commits on all 12 passes, tail
    // [617, 620, 617, 620, 617, 620]. That is the bug, in a list.
    const quiet = decisions.slice(2);
    assert(
        quiet.every((d) => d.height === null),
        `the 620/617 cycle stops committing: passes 3..12 all refuse (committed [${committed.join(', ')}])`,
    );
    assert(
        committed.length <= 2,
        `it gives up within a couple of frames, not after dozens (committed ${committed.length})`,
    );
    assert(
        committed[committed.length - 1] === 620,
        'and it settles on 620, the LARGER of the two, so the column does not creep downward',
    );
}

console.log('\nOSCILLATION — the same cycle entered from the other side');
{
    const { committed, decisions } = run(liveShake, 12, 617);
    assert(
        decisions.slice(2).every((d) => d.height === null),
        `starting at 617 also goes quiet (committed [${committed.join(', ')}])`,
    );
    assert(
        committed[committed.length - 1] === 620,
        'and it still settles on the larger value, not the one it happened to start from',
    );
}

console.log('\nCONVERGENCE — a measurement that agrees with itself must still settle');
{
    // The ordinary case: one pass moves the column, the second pass agrees.
    const { committed, decisions } = run((applied) => (applied === null ? 640 : 640), 5, 500);
    assert(committed[0] === 640, 'the first genuinely different value is committed');
    assert(committed.length === 1, 'and the passes after it commit nothing');
    assert(decisions[1].height === null, 'the second pass is refused, not re-set to the same number');
}

console.log('\nIDEMPOTENCE — sub-pixel jitter is not a resize');
{
    assert(nextShellHeight(620, 620, [620]).height === null, 'an identical value is never re-set');
    assert(nextShellHeight(620, 621, [620]).height === null, '1px of jitter is absorbed');
    assert(nextShellHeight(620, 618, [620]).height === null, '2px of jitter is absorbed');
    assert(nextShellHeight(620, 617, [620]).height === 617, 'but 3px is a real change and is applied');
    assert(nextShellHeight(620, 900, [620]).height === 900, 'and a big change is obviously applied');
}

console.log('\nGENUINE RESIZE — the cycle guard must not freeze a real one');
{
    // The window actually got taller. The new value has never been held before,
    // so nothing may refuse it.
    assert(nextShellHeight(620, 900, [620, 617, 620]).height === 900, 'a brand new height is applied');
    // First measure of all: there is nothing to compare against.
    assert(nextShellHeight(null, 568, []).height === 568, 'the first measure is always applied');
    // Being asked to go back to the value held before the current one IS the
    // flip-flop signature. It is not simply refused: refusing it outright would
    // strand the column on the smaller value, so the larger one is applied once
    // and everything after that is refused. One commit, then silence.
    const pin = nextShellHeight(500, 640, [640, 500]);
    assert(pin.height === 640 && pin.reason === 'oscillation-pinned',
        'the cycle signature pins to the larger of the two rather than flipping back');
    assert(nextShellHeight(640, 500, [640, 500, 640]).height === null,
        'and the pass after the pin is refused, so the cycle is over, not merely slowed');
    assert(nextShellHeight(500, 700, [640, 500]).height === 700,
        'a third, unseen value is not the cycle signature and is applied');
}

console.log('\nFLOOR — a short viewport leaves a usable transcript');
{
    assert(computeShellHeight(300, 208, 40) === SHELL_MIN_HEIGHT, 'the 320 floor holds when the maths goes small');
    assert(computeShellHeight(200, 500, 0) === SHELL_MIN_HEIGHT, 'and when the maths goes negative');
    assert(computeShellHeight(828, 208, 0) === 620, 'the live measurement reproduces: 828 - 208 - 0 = 620');
    assert(computeShellHeight(828, 208, 3) === 617, 'and the other half of the shake: 828 - 208 - 3 = 617');
    assert(computeShellHeight(828.4, 208.2, 0.1) === 620, 'fractional layout values are rounded, not floored piecemeal');
    // The floor is a floor, not a clamp: tall viewports are untouched.
    assert(computeShellHeight(2000, 208, 0) === 1792, 'a tall viewport is not capped');
}

console.log('\nNEGATIVE CONTROL — the guard has to be capable of refusing');
{
    // A check that cannot fail is not a check. If nextShellHeight returned a
    // height for every input, every assertion above about refusal would pass
    // vacuously against a broken implementation, so assert that SOME input is
    // refused and some input is accepted.
    const refusals = [
        nextShellHeight(620, 620, [620]),
        nextShellHeight(617, 620, [620, 617]),
    ].filter((d) => d.height === null);
    const acceptances = [
        nextShellHeight(null, 568, []),
        nextShellHeight(620, 900, [620]),
    ].filter((d) => d.height !== null);
    assert(refusals.length > 0, 'at least one input is refused');
    assert(acceptances.length === 2, 'and unambiguous changes are still accepted');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
