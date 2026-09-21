// The room column's height, as arithmetic and a decision, with no DOM in it.
//
// The room screen measures the viewport left over around the chat column and
// applies it as an explicit height. That measurement runs from a
// ResizeObserver on the document - so the callback resizes the very thing the
// observer watches. Usually the second pass agrees with the first and it
// stops. Sometimes it does not, and then it never stops.
//
// Measured on groupmind.one (thinkoff-development, 2026-09-20, Chrome): at any
// window width of 1024px or more the column flipped
//
//     620 -> 617 -> 620 -> 617 -> ...
//
// once per animation frame, for as long as the room stayed open. At 620 the
// column overflowed <main> by 3px, that overflow was counted as content
// rendered BELOW the column and subtracted, giving 617; at 617 nothing
// overflowed, so the next measure gave 620 back. Below 1024px (Tailwind's `lg`,
// where the sidebar column appears) it settled at 568 and stood still, which is
// exactly how the owner described it: stable until the window gets wider.
//
// The arithmetic and the accept/reject decision live here, away from the
// effect, because this is the part that has to be exhaustively testable: the
// repo has no React or jsdom harness, and the decision is what the bug is
// about. See shell-height.test.ts, whose first block is that recording.

/** A very short viewport should still leave a usable transcript and let the page scroll. */
export const SHELL_MIN_HEIGHT = 320;

/**
 * Below this, a difference is layout noise rather than a resize. Deliberately
 * small: the live cycle was 3px, so an epsilon large enough to swallow it would
 * also swallow real changes. Epsilon handles settle-and-jitter; the cycle
 * detector below handles genuine two-value cycles. They are different faults
 * and need different guards.
 */
export const SHELL_SETTLE_EPSILON = 2;

/**
 * viewport - (everything above the column) - (everything that renders below it).
 * Rounded once, at the end, so fractional layout values cannot accumulate.
 */
export function computeShellHeight(viewportHeight: number, docTop: number, below: number): number {
    return Math.max(SHELL_MIN_HEIGHT, Math.round(viewportHeight - docTop - below));
}

export type ShellHeightReason =
    /** Nothing has been applied yet; any measurement beats no measurement. */
    | 'first-measure'
    /** Within epsilon of what is already applied: applying it would only re-trigger the observer. */
    | 'settled'
    /** A real change, applied. */
    | 'changed'
    /** A two-value cycle, pinned to the larger of the two so the column never creeps downward. */
    | 'oscillation-pinned'
    /** A two-value cycle, already sitting on the larger value. Nothing to do. */
    | 'oscillation-refused';

export type ShellHeightDecision = {
    /** The height to commit to state, or null to leave state untouched. */
    height: number | null;
    reason: ShellHeightReason;
};

/**
 * Decide whether a freshly computed height may be committed.
 *
 * @param current  the height currently applied, or null before the first measure
 * @param computed what this pass measured
 * @param history  heights committed so far, oldest first; the last entry is `current`
 *
 * `history` must be reset whenever something outside the column genuinely
 * changes (a window resize, a viewport change). The cycle detector below only
 * makes sense as a statement about measurements taken with the same inputs: if
 * the inputs moved, a repeated value is a coincidence, not a flip-flop.
 */
export function nextShellHeight(
    current: number | null,
    computed: number,
    history: readonly number[],
): ShellHeightDecision {
    if (current === null) return { height: computed, reason: 'first-measure' };

    // Idempotence. This alone ends the common case, where the second pass
    // reports a number a pixel or two off the first and every pass after that
    // re-triggers the observer for no visible benefit.
    if (Math.abs(computed - current) <= SHELL_SETTLE_EPSILON) {
        return { height: null, reason: 'settled' };
    }

    // Cycle detection, for the case epsilon cannot reach: A -> B -> A where A
    // and B are further apart than epsilon. The signature is that the value we
    // are about to apply is the one we held BEFORE the current one - we are
    // being asked to go back where we just came from.
    //
    // Pin to the larger of the two. Preferring the smaller would leave the
    // column a few pixels short every time this fires, and a fix that shaves
    // pixels is how the 489 -> 401 search-panel bug worked.
    const beforeLast = history.length >= 2 ? history[history.length - 2] : undefined;
    if (beforeLast !== undefined && beforeLast === computed) {
        const pinned = Math.max(current, computed);
        return pinned === current
            ? { height: null, reason: 'oscillation-refused' }
            : { height: pinned, reason: 'oscillation-pinned' };
    }

    return { height: computed, reason: 'changed' };
}

/** How much history the cycle detector needs. Two entries; a third for headroom. */
export const SHELL_HISTORY_LIMIT = 3;

/** Append a committed height, keeping the history bounded. */
export function pushShellHeight(history: readonly number[], height: number): number[] {
    return [...history, height].slice(-SHELL_HISTORY_LIMIT);
}
