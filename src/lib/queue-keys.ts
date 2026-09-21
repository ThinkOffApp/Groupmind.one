/**
 * The three-button model for the owner's queue.
 *
 * THE DEVICE IS THREE BUTTONS. A desk gadget that presents as a Bluetooth
 * keyboard, with three fixed, physically labelled buttons. That is the whole
 * input vocabulary; there is no fourth button to fall back on.
 *
 *   button 3   m   cycle to the next item
 *   button 1   y   yes, on whatever is showing
 *   button 2   n   no,  on whatever is showing
 *
 * THERE IS NO DEFER ACTION. You defer by cycling past without pressing yes or
 * no. That deletes a concept, a state and a paragraph of explanation.
 *
 * CYCLING CHANGES WHAT YES AND NO MEAN, because it changes the target: yes
 * merges a pull request and approves an action. The verbs therefore live with
 * the item, in `queue-items.ts`, and the card states them before anything is
 * pressed. Three buttons stay safe only while the screen is unambiguous about
 * the verb.
 *
 * THE CONFIRMATION IS BOUND TO THE ITEM, NOT THE BUTTON. `y` opens a
 * confirmation carrying the item's id, the action, and the item's fingerprint
 * (the head SHA for a pull request). A second deliberate `y` commits. Because
 * cycling moves the target under the user, anything that moves between the
 * two presses - a cycle, a reload, a revised request - invalidates the
 * confirmation, and the second press commits the thing the first press was
 * about or NOTHING AT ALL. In this implementation it is always "nothing at
 * all", which is the conservative branch.
 *
 * A FULL KEYBOARD STILL WORKS - see [KEY_BINDINGS]. The three-key path is
 * added, not substituted, and is complete on its own.
 *
 * The guards below come from codexmb's review. Showing one card at a time
 * removed a SELECTION bug; it removed neither the stale-target hazard nor the
 * bouncing-button hazard, and cycling makes both MORE likely, not less.
 *
 *  1. NO CHORDS. Every binding is a single key. A keypress carrying a modifier
 *     is ignored rather than treated as its unmodified twin.
 *  2. ONE KEYPRESS NEVER COMMITS. Two separate key-downs with a release
 *     between them, plus an arming window, plus the binding above.
 *  3. AUTO-REPEAT AND HELD KEYS NEVER ACT, ACROSS CARDS. Every transition
 *     re-arms [QueueState.awaitingKeyUp]; only a real key-up clears it. This
 *     is the cross-card case a per-card repeat check misses.
 *  4. ANYTHING KEYBOARD-REACHABLE IS POINTER-REACHABLE, through this same
 *     reducer. Hardware input grants no permission a mouse does not have.
 *  5. KEYS IN AN EDITABLE FIELD BELONG TO THE FIELD - typing "yes" in a
 *     comment box must never approve anything.
 */

import { VERBS, writesSomewhereElse, type QueueItem } from './queue-items';

/** `review` shows one item. `confirm` is the bound second step. */
export type Phase = 'review' | 'confirm' | 'empty';

export type QueueAction = 'yes' | 'no' | 'next' | 'refresh';

/** Milliseconds the confirmation ignores `yes` after opening. */
export const CONFIRM_ARM_MS = 400;

/** The three keys we publish. We ship no configuration UI; this is the table. */
export const THREE_KEYS = ['y', 'n', 'm'] as const;

export interface KeyBinding {
    action: QueueAction;
    phase: Phase;
    /** Single keys only - `KeyboardEvent.key` values. No modifiers, ever. */
    keys: string[];
    threeKey: (typeof THREE_KEYS)[number] | null;
    /** Which physical button, for the printed labels on the gadget. */
    button: 1 | 2 | 3 | null;
    label: string;
    /** `data-action` of the control that does the same thing by mouse/touch. */
    control: string;
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
    { action: 'yes', phase: 'review', keys: ['y', 'Enter', 'ArrowRight'], threeKey: 'y', button: 1, label: 'yes, on this item', control: 'yes' },
    { action: 'no', phase: 'review', keys: ['n', 'ArrowLeft'], threeKey: 'n', button: 2, label: 'no, on this item', control: 'no' },
    { action: 'next', phase: 'review', keys: ['m', 'ArrowDown'], threeKey: 'm', button: 3, label: 'cycle to the next item', control: 'next' },
    // A laptop convenience, deliberately NOT one of the three: nothing in the
    // flow requires it, because cycling always comes back round and an empty
    // queue reloads from any key.
    { action: 'refresh', phase: 'review', keys: ['r'], threeKey: null, button: null, label: 'reload the queue', control: 'refresh' },

    { action: 'yes', phase: 'confirm', keys: ['y', 'Enter'], threeKey: 'y', button: 1, label: 'yes, do it', control: 'yes' },
    { action: 'no', phase: 'confirm', keys: ['n', 'Escape', 'ArrowLeft'], threeKey: 'n', button: 2, label: 'no, back out', control: 'no' },
    { action: 'next', phase: 'confirm', keys: ['m', 'ArrowDown'], threeKey: 'm', button: 3, label: 'back out and cycle on', control: 'next' },

    // Nothing pending: every key reloads, so three buttons are never stuck.
    { action: 'refresh', phase: 'empty', keys: ['y', 'n', 'm', 'Enter', 'r'], threeKey: 'y', button: 1, label: 'reload the queue', control: 'refresh' },
];

/**
 * What an open confirmation is bound to.
 *
 * All three fields matter. The id says which item; the action says which verb
 * (yes and no are different commitments); the fingerprint says which VERSION
 * of that item was read. Any of them changing means the person is no longer
 * confirming the thing they looked at.
 */
export interface ConfirmTarget {
    id: string;
    action: 'yes' | 'no';
    fingerprint: string;
}

export interface QueueState {
    phase: Phase;
    /** Ids in cycle order. The front is what is on screen. */
    order: string[];
    /** Ids decided in this sitting. Back after a reload. */
    done: string[];
    confirmFor: ConfirmTarget | null;
    /**
     * True while a key-down must be ignored until the key is RELEASED.
     *
     * The cross-card bounce guard. Cycling means the card changes under a
     * held button all the time, so this is re-armed on every transition and
     * cleared only by a real key-up.
     */
    awaitingKeyUp: boolean;
    armedAt: number | null;
    notice: string | null;
}

export type QueueEffect =
    | { type: 'commit'; id: string; action: 'yes' | 'no' }
    | { type: 'refresh' }
    | null;

export function initialQueueState(ids: readonly string[] = []): QueueState {
    return {
        phase: ids.length > 0 ? 'review' : 'empty',
        order: [...ids],
        done: [],
        confirmFor: null,
        awaitingKeyUp: false,
        armedAt: null,
        notice: null,
    };
}

/** The item on screen, or null when the queue is empty. */
export function currentId(state: QueueState): string | null {
    return state.order.length > 0 ? state.order[0] : null;
}

/**
 * A key was released, so the next key-down is a fresh, deliberate press.
 *
 * Wired to a window-level `keyup`. Missing a key-up leaves the gate closed,
 * which is the safe direction: a stuck button does nothing.
 */
export function releaseKeys(state: QueueState): QueueState {
    return state.awaitingKeyUp ? { ...state, awaitingKeyUp: false } : state;
}

/**
 * Fold a freshly fetched queue in.
 *
 * Cycle order is preserved for ids still present, new items join the back,
 * and items that have gone drop out. A reload restores anything said no to:
 * that was a decision about this sitting, and for a pull request nothing was
 * written anywhere to make it permanent.
 *
 * An open confirmation survives ONLY if its item is still present with the
 * same fingerprint AND still on screen. Otherwise it is dropped, so the next
 * `y` opens a fresh one rather than committing something that moved.
 */
export function syncQueue(state: QueueState, items: readonly QueueItem[]): QueueState {
    const present = new Map(items.map((i) => [i.id, i]));
    const kept = state.order.filter((id) => present.has(id));
    const added = items.map((i) => i.id).filter((id) => !kept.includes(id));
    const order = [...kept, ...added];

    const wasOnScreen = currentId(state);
    const nowOnScreen = order.length > 0 ? order[0] : null;
    const cardChanged = wasOnScreen !== nowOnScreen;

    const target = state.confirmFor;
    const stillConfirming =
        state.phase === 'confirm' &&
        target !== null &&
        nowOnScreen === target.id &&
        present.get(target.id)?.fingerprint === target.fingerprint;

    return {
        phase: order.length === 0 ? 'empty' : stillConfirming ? 'confirm' : 'review',
        order,
        done: [],
        confirmFor: stillConfirming ? target : null,
        awaitingKeyUp: state.awaitingKeyUp || cardChanged,
        armedAt: stillConfirming ? state.armedAt : null,
        notice: state.notice,
    };
}

/** Which action a key means in this phase, or null if the key is not bound. */
export function actionForKey(key: string, phase: Phase): QueueAction | null {
    for (const b of KEY_BINDINGS) {
        if (b.phase === phase && b.keys.includes(key)) return b.action;
    }
    return null;
}

/** Actions the three published keys can reach in this phase. */
export function reachableWithThreeKeys(phase: Phase): QueueAction[] {
    const out = new Set<QueueAction>();
    for (const k of THREE_KEYS) {
        const a = actionForKey(k, phase);
        if (a) out.add(a);
    }
    return [...out];
}

/**
 * Is this event target somewhere a person is typing?
 *
 * Global single-letter keys and text entry cannot share a page: typing "yes"
 * into a comment box would otherwise approve something.
 */
export function isEditableTarget(target: unknown): boolean {
    if (!target || typeof target !== 'object') return false;
    const el = target as { tagName?: unknown; isContentEditable?: unknown; getAttribute?: unknown };

    if (el.isContentEditable === true) return true;

    const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;

    if (typeof el.getAttribute === 'function') {
        const attr = (el.getAttribute as (n: string) => unknown)('contenteditable');
        if (attr === '' || attr === 'true' || attr === 'plaintext-only') return true;
    }
    return false;
}

export interface KeyEventLike {
    key: string;
    repeat?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    /** Where the keypress landed, for the editable-field check. */
    target?: unknown;
}

export interface ReduceOptions {
    /**
     * This input came from a KEY rather than a click.
     *
     * Two things hang off it: the arming window (a click is already a
     * deliberate act at a place on screen, a keypress is not) and re-arming
     * the key gate on a transition. A mouse user has nothing to release, so a
     * click never leaves the keyboard gated.
     */
    enforceArm: boolean;
    now: number;
}

export interface ReduceResult {
    state: QueueState;
    effect: QueueEffect;
    /** Whether the input was consumed, so the caller can preventDefault. */
    handled: boolean;
}

/** Move the item on screen to the back of the cycle. */
function cycle(state: QueueState, fromKey: boolean, note: string | null): QueueState {
    if (state.order.length === 0) return { ...state, notice: note };
    const [head, ...rest] = state.order;
    return {
        ...state,
        phase: 'review',
        order: [...rest, head],
        confirmFor: null,
        awaitingKeyUp: state.awaitingKeyUp || fromKey,
        armedAt: null,
        notice: note,
    };
}

/** Drop the item on screen from this sitting's queue. */
function settle(state: QueueState, id: string, fromKey: boolean, note: string): QueueState {
    const rest = state.order.filter((x) => x !== id);
    return {
        ...state,
        phase: rest.length > 0 ? 'review' : 'empty',
        order: rest,
        done: [...state.done, id],
        confirmFor: null,
        awaitingKeyUp: state.awaitingKeyUp || fromKey,
        armedAt: null,
        notice: note,
    };
}

/**
 * Apply one action. Pointer controls call this directly; the keyboard goes
 * through [reduceKey], which adds the editable-field check, the auto-repeat
 * check and the key gate.
 *
 * A key and a click reach the same effects through this one function on
 * purpose: hardware input grants no permission a mouse does not have, and
 * every commit - whichever it came from - goes down one path to one
 * session-gated route.
 */
export function reduceAction(
    state: QueueState,
    action: QueueAction,
    items: readonly QueueItem[],
    opts: ReduceOptions
): ReduceResult {
    const fromKey = opts.enforceArm;
    const byId = new Map(items.map((i) => [i.id, i]));
    const keep = (s: QueueState): ReduceResult => ({ state: s, effect: null, handled: true });
    const id = currentId(state);
    const item = id ? byId.get(id) : undefined;

    if (action === 'refresh') {
        return { state: { ...state, notice: null }, effect: { type: 'refresh' }, handled: true };
    }

    if (state.phase === 'empty' || !id || !item) {
        // Nothing to decide. Any key here reloads rather than doing nothing,
        // so a three-button user is never stranded on a screen they cannot
        // leave.
        return {
            state: { ...state, phase: 'empty', confirmFor: null, notice: null },
            effect: { type: 'refresh' },
            handled: true,
        };
    }

    if (state.phase === 'review') {
        if (action === 'next') return keep(cycle(state, fromKey, null));

        const verbs = VERBS[item.kind];
        // A blocked item (a draft PR) is shown, and cycling past it works,
        // but yes is refused. It is NOT settled: it stays in the cycle.
        if (action === 'yes' && item.blocked) {
            return keep({ ...state, notice: `${verbs.yesVerb} refused: ${item.blocked}` });
        }

        if (!writesSomewhereElse(item, action)) {
            // Nothing leaves the browser, so nothing needs confirming.
            return keep(settle(state, id, fromKey, `${verbs.noVerb}. ${verbs.noSentence}`));
        }

        // Everything that writes somewhere else gets the bound confirmation,
        // whether it is yes or no: a denial is a recorded decision too.
        return keep({
            ...state,
            phase: 'confirm',
            confirmFor: { id, action, fingerprint: item.fingerprint },
            awaitingKeyUp: state.awaitingKeyUp || fromKey,
            armedAt: opts.now,
            notice: null,
        });
    }

    // state.phase === 'confirm'
    const target = state.confirmFor;

    if (action === 'no') {
        return keep({
            ...state,
            phase: 'review',
            confirmFor: null,
            awaitingKeyUp: state.awaitingKeyUp || fromKey,
            armedAt: null,
            notice: 'Backed out. Nothing was done.',
        });
    }
    if (action === 'next') {
        return keep(cycle({ ...state, phase: 'review', confirmFor: null }, fromKey, 'Backed out. Nothing was done.'));
    }

    // action === 'yes': commit the BOUND action, or nothing.
    if (opts.enforceArm && state.armedAt !== null && opts.now - state.armedAt < CONFIRM_ARM_MS) {
        return keep({ ...state, notice: 'Release the button and press yes again' });
    }
    if (!target) {
        return keep({ ...state, phase: 'review', armedAt: null, notice: 'Nothing was pending. Nothing was done.' });
    }

    const bound = byId.get(target.id);
    const invalid =
        !bound ||
        target.id !== id ||
        bound.fingerprint !== target.fingerprint ||
        (target.action === 'yes' && bound.blocked);

    if (invalid) {
        return keep({
            ...state,
            phase: 'review',
            confirmFor: null,
            awaitingKeyUp: state.awaitingKeyUp || fromKey,
            armedAt: null,
            notice:
                bound && bound.fingerprint !== target.fingerprint
                    ? 'It changed while that was open - nothing was done. Read it again.'
                    : 'That is no longer what is in front of you - nothing was done.',
        });
    }

    return {
        state: settle(state, target.id, fromKey, ''),
        effect: { type: 'commit', id: target.id, action: target.action },
        handled: true,
    };
}

/**
 * Apply one key-down. Returns `handled: false` for anything not bound, so the
 * caller leaves the browser's own behaviour alone.
 *
 * Three refusals happen before any action runs, and each closes a hazard that
 * one-card-at-a-time did NOT remove:
 *  - a modified keypress belongs to the browser;
 *  - a keypress inside an editable field belongs to that field;
 *  - a key-down while the gate is armed is a held or bouncing button,
 *    possibly one carried over from the previous card.
 */
export function reduceKey(
    state: QueueState,
    event: KeyEventLike,
    items: readonly QueueItem[],
    now: number
): ReduceResult {
    const unhandled: ReduceResult = { state, effect: null, handled: false };

    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return unhandled;
    if (isEditableTarget(event.target)) return unhandled;

    const action = actionForKey(event.key, state.phase);
    if (!action) return unhandled;

    // Consumed but inert: swallowing it is what stops it falling through to a
    // focused button and acting anyway.
    if (event.repeat) return { state, effect: null, handled: true };
    if (state.awaitingKeyUp) {
        return {
            state:
                state.phase === 'confirm' && action === 'yes'
                    ? { ...state, notice: 'Release the button and press yes again' }
                    : state,
            effect: null,
            handled: true,
        };
    }

    return reduceAction(state, action, items, { enforceArm: true, now });
}

/** The legend rendered on the page, for the phase you are actually in. */
export function legendFor(phase: Phase): KeyBinding[] {
    return KEY_BINDINGS.filter((b) => b.phase === phase);
}

/** Every `data-action` the UI must render for pointer parity. */
export const POINTER_CONTROLS: readonly string[] = Array.from(new Set(KEY_BINDINGS.map((b) => b.control)));
