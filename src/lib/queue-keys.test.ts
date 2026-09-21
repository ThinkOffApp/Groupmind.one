// SPDX-License-Identifier: AGPL-3.0-only
// Unit test for the three-button queue model.
// Run: npx tsx src/lib/queue-keys.test.ts
//
// Three fixed buttons: 1 = yes, 2 = no, 3 = next. Cycling changes the item and
// the item defines the verb, so the two things this file cares about most are
// (a) the card always states what yes will do, and (b) a confirmation is bound
// to the ITEM, so anything moving under it cancels rather than commits.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
    CONFIRM_ARM_MS,
    KEY_BINDINGS,
    POINTER_CONTROLS,
    THREE_KEYS,
    actionForKey,
    currentId,
    initialQueueState,
    isEditableTarget,
    legendFor,
    reachableWithThreeKeys,
    reduceAction,
    reduceKey,
    releaseKeys,
    syncQueue,
    type QueueState,
} from './queue-keys';
import {
    VERBS,
    approvalItem,
    pullRequestItem,
    verbsFor,
    writesSomewhereElse,
    type ItemKind,
    type QueueItem,
} from './queue-items';

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

const pr = (over: Partial<Parameters<typeof pullRequestItem>[0]> = {}) =>
    pullRequestItem({
        owner: 'o',
        repo: 'r',
        number: 1,
        title: 'Fix the thing',
        author: 'claudemb',
        url: 'https://github.com/o/r/pull/1',
        draft: false,
        headSha: 'a'.repeat(40),
        mergeable: true,
        mergeableState: 'clean',
        ...over,
    })!;

const approval = (over: Partial<Parameters<typeof approvalItem>[0]> = {}) =>
    approvalItem({
        intent_id: 'intent-1',
        target_summary: 'Restart the Pi',
        actor: '@claudemm',
        created_at: '2026-09-20T10:00:00Z',
        updated_at: '2026-09-20T10:00:00Z',
        ...over,
    })!;

// One PR, one draft PR, one approval: a genuinely mixed queue.
const items: QueueItem[] = [pr(), pr({ number: 2, draft: true, headSha: 'b'.repeat(40) }), approval()];
const ids = items.map((i) => i.id);

const key = (
    k: string,
    over: Partial<{ repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}
) => ({ key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over });

// One distinct physical press: release whatever was down, then press. The
// held-button cases deliberately call reduceKey directly instead.
const press = (s: QueueState, k: string, now = 0, list: readonly QueueItem[] = items) =>
    reduceKey(releaseKeys(s), key(k), list, now);

console.log('\nThree buttons: yes, no, next. There is no defer action.');
{
    assert(THREE_KEYS.join(',') === 'y,n,m', 'the published keys are y / n / m');
    const actions = new Set(KEY_BINDINGS.map((b) => b.action));
    assert(!actions.has('defer' as never), 'there is no defer action at all - you defer by cycling past');
    assert(actions.has('next'), 'button 3 is a plain cycle');
    for (const b of KEY_BINDINGS) {
        assert(
            b.keys.every((k) => k.length === 1 || /^(Arrow(Up|Down|Left|Right)|Enter|Escape)$/.test(k)),
            `${b.phase}/${b.action} uses only plain keys (${b.keys.join(', ')})`
        );
    }
    const buttons = KEY_BINDINGS.filter((b) => b.phase === 'review' && b.button).map((b) => b.button);
    assert(JSON.stringify([...new Set(buttons)].sort()) === '[1,2,3]', 'exactly three physical buttons are bound');
    const s0 = initialQueueState(ids);
    assert(
        ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'].every(
            (m) => reduceKey(s0, key('y', { [m]: true } as any), items, 0).handled === false
        ),
        'a keypress carrying any modifier is left to the browser'
    );
}

console.log('\nCYCLING CHANGES WHAT YES AND NO MEAN');
{
    // The whole point: button 3 selects the target, the target defines the verb.
    const s0 = initialQueueState(ids);
    const onPr = byIdOf(currentId(s0)!);
    assert(onPr.kind === 'pull_request', 'the queue starts on a pull request');
    assert(verbsFor(onPr).yesVerb === 'Merge', 'on a pull request, yes = Merge');
    assert(verbsFor(onPr).noVerb === 'Leave it', 'on a pull request, no = Leave it');

    let s = press(s0, 'm').state;
    s = press(s, 'm').state;
    const onApproval = byIdOf(currentId(s)!);
    assert(onApproval.kind === 'approval', 'two cycles reach an approval');
    assert(verbsFor(onApproval).yesVerb === 'Approve', 'on an approval, yes = Approve');
    assert(verbsFor(onApproval).noVerb === 'Deny', 'on an approval, no = Deny');

    // Every kind must state the verb in a full sentence naming the consequence.
    for (const kind of Object.keys(VERBS) as ItemKind[]) {
        const v = VERBS[kind];
        assert(v.yesSentence.includes('Yes will'), `${kind}: the yes sentence says what yes WILL do`);
        assert(v.noSentence.startsWith('No '), `${kind}: the no sentence says what no does`);
        assert(v.yesSentence.length > 30 && v.noSentence.length > 30, `${kind}: both verbs are spelled out, not one word`);
        assert(!!v.kindLabel, `${kind}: has a plain label for the card`);
    }
    assert(VERBS.pull_request.yesVerb !== VERBS.approval.yesVerb, 'the two kinds genuinely differ in what yes means');

    // The card must render the sentence for whatever is showing, from this
    // same table - not a hardcoded string.
    const component = readFileSync(join(process.cwd(), 'src/components/QueueReview.tsx'), 'utf8');
    assert(component.includes('yesSentence'), 'the card renders the yes sentence for the item on screen');
    assert(component.includes('noSentence'), 'and the no sentence');
    assert(component.includes('yesVerb') && component.includes('noVerb'), 'and the buttons carry the item-specific verbs');
}

function byIdOf(id: string): QueueItem {
    return items.find((i) => i.id === id)!;
}

console.log('\nNo defer: cycling past is how you defer, and it settles nothing');
{
    const s0 = initialQueueState(ids);
    const r = press(s0, 'm');
    assert(r.effect === null, 'cycling commits nothing');
    assert(r.state.done.length === 0, 'cycling decides nothing');
    assert(r.state.order.length === s0.order.length, 'nothing leaves the queue');
    assert(currentId(r.state) === ids[1], 'the next item is showing');
    assert(r.state.order.includes(ids[0]), 'and the one cycled past is still in the cycle');

    let s = r.state;
    s = press(s, 'm').state;
    s = press(s, 'm').state;
    assert(currentId(s) === ids[0], 'cycling all the way round comes back to the first');
    assert(s.done.length === 0, 'after a full lap nothing has been decided');
    assert(!('deferred' in s), 'there is no defer bookkeeping in the state at all');
}

console.log('\n[codexmb 2] ONE KEYPRESS NEVER COMMITS');
{
    const s0 = initialQueueState(ids);
    const first = press(s0, 'y', 1_000);
    assert(first.effect === null, 'the first y commits nothing');
    assert(first.state.phase === 'confirm', 'it opens a confirmation');
    assert(first.state.awaitingKeyUp === true, 'and the page now waits for the button to be RELEASED');

    const stillDown = reduceKey(first.state, key('y'), items, 60_000);
    assert(stillDown.effect === null, 'a second key-down with no release in between does NOT commit');
    assert(!!stillDown.state.notice && /release/i.test(stillDown.state.notice), 'and it says to release first');

    const released = releaseKeys(first.state);
    assert(reduceKey(released, key('y'), items, 1_000 + CONFIRM_ARM_MS - 1).effect === null,
        'a released-and-repressed y inside the arming window still does not commit');
    const done = reduceKey(released, key('y'), items, 1_000 + CONFIRM_ARM_MS + 1);
    assert(done.effect?.type === 'commit' && done.effect.action === 'yes', 'a fresh, deliberate y commits');
    assert(done.effect?.id === ids[0], 'and commits the item it was opened on');
}

console.log('\n[codexmb 2 + owner] THE CONFIRMATION IS BOUND TO THE ITEM');
{
    const s0 = initialQueueState(ids);
    const open = press(s0, 'y', 0);
    assert(open.state.confirmFor?.id === ids[0], 'the confirmation records which item');
    assert(open.state.confirmFor?.action === 'yes', 'and which verb');
    assert(open.state.confirmFor?.fingerprint === 'a'.repeat(40), 'and the head SHA it was opened on');

    // THE CASE THE OWNER ASKED FOR: open a confirmation, cycle, press y.
    const cycled = press(open.state, 'm');
    assert(cycled.state.phase === 'review', 'cycling backs out of the confirmation');
    assert(cycled.state.confirmFor === null, 'and discards what it was bound to');
    const afterCycle = press(cycled.state, 'y', 10_000);
    assert(afterCycle.effect === null, 'OPEN A CONFIRMATION, CYCLE, PRESS y -> NOTHING IS MERGED');
    assert(afterCycle.state.done.length === 0, 'and nothing at all has been committed');
    // The item cycled to here happens to be the draft, so y is refused
    // outright. Cycle once more to a normal item and the point still holds:
    // the second press starts a FRESH confirmation, it never inherits one.
    const onApproval = press(press(cycled.state, 'm').state, 'y', 10_000);
    assert(onApproval.effect === null, 'y on the next item still commits nothing on its own');
    assert(onApproval.state.confirmFor?.id === ids[2], 'it opens a NEW confirmation, bound to the item now in front');
    assert(onApproval.state.confirmFor?.fingerprint === approval().fingerprint, 'with that item\u2019s own fingerprint');

    // A reload that moves the item out from under an open confirmation.
    const moved = syncQueue(open.state, [items[1], items[2]]);
    assert(currentId(moved) === ids[1], 'the reload left a different item in front');
    assert(moved.phase === 'review' && moved.confirmFor === null,
        'a reload that changes which item is showing cancels the confirmation');
    assert(reduceKey(releaseKeys(moved), key('y'), items, 10_000).effect === null,
        'so the next y commits nothing');
    const undisturbed = syncQueue(open.state, items);
    assert(undisturbed.phase === 'confirm' && undisturbed.confirmFor?.id === ids[0],
        'control: a reload that changes nothing leaves the confirmation standing, so the checks above mean something');

    // A reload where the item is still on screen but its CONTENT changed.
    const revised: QueueItem[] = [pr({ headSha: 'f'.repeat(40) }), items[1], items[2]];
    const changed = syncQueue(open.state, revised);
    assert(changed.confirmFor === null, 'a head SHA that moved under the confirmation cancels it');

    // And the reducer refuses even if a confirmation somehow survives.
    const stale: QueueState = { ...open.state, awaitingKeyUp: false };
    const r = reduceAction(stale, 'yes', revised, { enforceArm: false, now: 10_000 });
    assert(r.effect === null, 'committing against a changed fingerprint does nothing');
    assert(!!r.state.notice && /changed/i.test(r.state.notice), 'and says it changed');

    // A confirmation bound to a DIFFERENT item than the one showing.
    const mismatched: QueueState = {
        ...open.state,
        awaitingKeyUp: false,
        confirmFor: { id: ids[2], action: 'yes', fingerprint: approval().fingerprint },
    };
    assert(reduceAction(mismatched, 'yes', items, { enforceArm: false, now: 10_000 }).effect === null,
        'a confirmation bound to something other than the item in front commits nothing');
}

console.log('\n[codexmb 3] BOUNCE PROTECTION SPANS CARD TRANSITIONS');
{
    const s0 = initialQueueState(ids);
    const open = press(s0, 'y', 0).state;
    const committed = reduceKey(releaseKeys(open), key('y'), items, 10_000);
    assert(committed.effect?.type === 'commit', 'the first item is committed');
    assert(committed.state.awaitingKeyUp === true, 'and the gate re-arms as the next card arrives');
    const carried = reduceKey(committed.state, key('y'), items, 20_000);
    assert(carried.effect === null && carried.state.phase === 'review',
        'a button still down from the previous card does NOT open a confirmation on the new one');
    assert(carried.handled === true, 'the swallowed press is consumed, so it cannot fall through to a button');

    for (const [k, what] of [['m', 'cycling'], ['n', 'answering no']] as Array<[string, string]>) {
        const after = press(s0, k).state;
        assert(after.awaitingKeyUp === true, `${what} re-arms the gate`);
        assert(reduceKey(after, key('y'), items, 20_000).state.phase === 'review',
            `a held button carried across ${what} does not open a confirmation`);
    }

    const reloaded = syncQueue({ ...s0, awaitingKeyUp: false }, [items[1], items[2]]);
    assert(currentId(reloaded) === ids[1], 'the reload changed which item is showing');
    assert(reloaded.awaitingKeyUp === true, 'a reload that changes the visible item re-arms the gate');
    const sameCard = syncQueue({ ...s0, awaitingKeyUp: false }, items);
    assert(sameCard.awaitingKeyUp === false, 'a reload that leaves the same item showing does not gate needlessly');

    const repeat = reduceKey(s0, key('y', { repeat: true }), items, 0);
    assert(repeat.effect === null && repeat.handled === true, 'auto-repeat is inert but consumed');
}

console.log('\n[codexmb 4] no on a pull request is never a GitHub mutation');
{
    const s0 = initialQueueState(ids);
    const r = press(s0, 'n');
    assert(r.effect === null, 'no on a pull request produces NO effect - nothing leaves the browser');
    assert(r.state.phase === 'review', 'it does not even open a confirmation, because there is nothing to confirm');
    assert(r.state.done.includes(ids[0]), 'it drops out of this sitting');
    assert(writesSomewhereElse(items[0], 'no') === false, 'the verb table says so explicitly');
    assert(!!r.state.notice && /not closed, not rejected/i.test(r.state.notice),
        'and the person is told it is not closed or rejected');

    const restored = syncQueue(r.state, items);
    assert(restored.order.includes(ids[0]), 'a reload brings it back - nothing was written to make it permanent');

    const component = readFileSync(join(process.cwd(), 'src/components/QueueReview.tsx'), 'utf8');
    assert(/not closed, not rejected|noSentence/.test(component), 'the UI states it');
    const docs = readFileSync(join(process.cwd(), 'docs/queue.md'), 'utf8');
    assert(/not closed, not rejected/i.test(docs), 'and the documentation states it');
    assert(/nothing at all is written to GitHub/i.test(docs), 'in the same words as the UI');
}

console.log('\nA denial IS a write, so it is confirmed too');
{
    let s = initialQueueState(ids);
    s = press(s, 'm').state;
    s = press(s, 'm').state;
    assert(byIdOf(currentId(s)!).kind === 'approval', 'on an approval');
    assert(writesSomewhereElse(byIdOf(currentId(s)!), 'no') === true, 'no on an approval records a denial');
    const r = press(s, 'n', 1_000);
    assert(r.effect === null && r.state.phase === 'confirm', 'so it asks a second time, exactly like yes');
    assert(r.state.confirmFor?.action === 'no', 'and the confirmation remembers it is a denial, not an approval');
    const done = reduceKey(releaseKeys(r.state), key('y'), items, 1_000 + CONFIRM_ARM_MS + 1);
    assert(done.effect?.type === 'commit' && done.effect.action === 'no', 'confirming commits the DENIAL, not an approval');
}

console.log('\nA blocked item is shown and cyclable, but cannot be said yes to');
{
    let s = initialQueueState(ids);
    s = press(s, 'm').state;
    const draft = byIdOf(currentId(s)!);
    assert(!!draft.blocked, 'the draft pull request is blocked');
    const r = press(s, 'y');
    assert(r.effect === null && r.state.phase === 'review', 'yes on it opens nothing');
    assert(!!r.state.notice && /draft/i.test(r.state.notice), 'it says why');
    assert(r.state.order.includes(draft.id) && r.state.done.length === 0, 'and it is NOT settled - it stays in the cycle');
    assert(currentId(press(s, 'm').state) === ids[2], 'you can still cycle past it');
}

console.log('\n[codexmb 5] Keys in an editable field belong to the field');
{
    assert(isEditableTarget({ tagName: 'INPUT' }) === true, 'an input is editable');
    assert(isEditableTarget({ tagName: 'TEXTAREA' }) === true, 'a textarea is editable');
    assert(isEditableTarget({ tagName: 'SELECT' }) === true, 'a select is editable');
    assert(isEditableTarget({ tagName: 'DIV', isContentEditable: true }) === true, 'a contenteditable is editable');
    assert(isEditableTarget({ tagName: 'DIV', getAttribute: () => 'true' }) === true, 'contenteditable via attribute counts');
    assert(isEditableTarget({ tagName: 'BUTTON' }) === false, 'a button is not editable');
    assert(isEditableTarget(null) === false, 'no target is not editable');

    const s0 = initialQueueState(ids);
    for (const k of ['y', 'n', 'm']) {
        const r = reduceKey(s0, { ...key(k), target: { tagName: 'TEXTAREA' } } as any, items, 0);
        assert(r.handled === false && r.effect === null, `${k} typed into a textarea approves nothing`);
        assert(r.state.phase === 'review' && r.state.order[0] === ids[0], `${k} typed into a textarea does not even cycle`);
    }
}

console.log('\n[codexmb 6] Hardware input grants no new permission');
{
    const opts = { enforceArm: false, now: 10_000 };
    for (const [k, action] of [['y', 'yes'], ['n', 'no'], ['m', 'next']] as Array<[string, 'yes' | 'no' | 'next']>) {
        const viaKey = reduceKey(releaseKeys(initialQueueState(ids)), key(k), items, 10_000);
        const viaTap = reduceAction(initialQueueState(ids), action, items, opts);
        assert(JSON.stringify(viaKey.effect) === JSON.stringify(viaTap.effect), `${k} and the ${action} button produce the same effect`);
        assert(viaKey.state.phase === viaTap.state.phase, `${k} and the ${action} button reach the same phase`);
    }
    for (const b of KEY_BINDINGS) {
        assert(POINTER_CONTROLS.includes(b.control), `${b.phase}/${b.action} is reachable by pointer too`);
    }
    const component = readFileSync(join(process.cwd(), 'src/components/QueueReview.tsx'), 'utf8');
    for (const control of POINTER_CONTROLS) {
        assert(component.includes(`data-action="${control}"`), `the component renders a clickable control for ${control}`);
    }
    // A commit from a key and a commit from a click are the same object, so
    // they go down one path to one session-gated route.
    const openK = reduceKey(initialQueueState(ids), key('y'), items, 0).state;
    const fromKey = reduceKey(releaseKeys(openK), key('y'), items, 10_000).effect;
    const openT = reduceAction(initialQueueState(ids), 'yes', items, opts).state;
    const fromTap = reduceAction(openT, 'yes', items, opts).effect;
    assert(JSON.stringify(fromKey) === JSON.stringify(fromTap), 'a commit from a key is indistinguishable from a commit from a click');
}

console.log('\nThe three keys alone can do everything');
{
    assert(reachableWithThreeKeys('review').length === 3, 'review: all three buttons are live');
    assert(reachableWithThreeKeys('confirm').length === 3, 'confirm: all three buttons are live');
    assert(reachableWithThreeKeys('empty').includes('refresh'), 'empty: the three buttons reload rather than stranding you');
    const outside = KEY_BINDINGS.filter((b) => b.threeKey === null).map((b) => b.action);
    assert(outside.every((a) => a === 'refresh'), 'the only non-three-key binding is the laptop reload convenience');

    // A whole mixed session on y/n/m alone.
    let s = initialQueueState(ids);
    s = press(s, 'n').state;               // leave PR #1
    s = press(s, 'm').state;               // cycle past the draft
    assert(byIdOf(currentId(s)!).kind === 'approval', 'reached the approval on three keys');
    const open = press(s, 'y', 1_000);
    const committed = reduceKey(releaseKeys(open.state), key('y'), items, 1_000 + CONFIRM_ARM_MS + 1);
    assert(committed.effect?.type === 'commit' && committed.effect.action === 'yes', 'and approved it on three keys');
}

console.log('\nA full keyboard still works');
{
    const s0 = initialQueueState(ids);
    assert(press(s0, 'Enter', 0).state.phase === 'confirm', 'Enter opens the confirmation');
    assert(press(s0, 'ArrowRight', 0).state.phase === 'confirm', 'ArrowRight opens the confirmation');
    assert(press(s0, 'ArrowLeft').state.done.includes(ids[0]), 'ArrowLeft is no');
    assert(currentId(press(s0, 'ArrowDown').state) === ids[1], 'ArrowDown cycles');
    assert(press(s0, 'r').effect?.type === 'refresh', 'r reloads');
    const open = press(s0, 'y', 0).state;
    assert(reduceKey(releaseKeys(open), key('Escape'), items, 100).state.phase === 'review', 'Escape backs out');
    assert(press(s0, 'x').handled === false, 'an unbound key is not claimed');
}

console.log('\nThe queue surviving a reload');
{
    let s = initialQueueState(ids);
    s = press(s, 'm').state;
    const extra = approval({ intent_id: 'intent-9' })!;
    const synced = syncQueue(s, [items[1], items[2], items[0], extra]);
    assert(synced.order.join(',') === [ids[1], ids[2], ids[0], extra.id].join(','), 'cycle order is kept and new items join the back');
    const gone = syncQueue(s, [items[1]]);
    assert(gone.order.join(',') === ids[1], 'an item that disappeared drops out');
    assert(syncQueue(s, []).phase === 'empty', 'an emptied queue goes to the empty phase');
}

console.log('\nNothing waiting');
{
    const empty = initialQueueState([]);
    assert(empty.phase === 'empty' && currentId(empty) === null, 'an empty queue starts in the empty phase');
    for (const k of THREE_KEYS) {
        assert(reduceKey(empty, key(k), items, 0).effect?.type === 'refresh', `${k} reloads when nothing is waiting`);
    }
    for (const phase of ['review', 'confirm', 'empty'] as const) {
        assert(legendFor(phase).length > 0, `there is a published legend for the ${phase} phase`);
    }
    assert(actionForKey('y', 'review') === 'yes' && actionForKey('n', 'review') === 'no' && actionForKey('m', 'review') === 'next',
        'y/n/m map to yes/no/next');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
