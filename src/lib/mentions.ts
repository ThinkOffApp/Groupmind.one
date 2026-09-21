/**
 * "Messages for me" filter (room page Mentions toggle).
 *
 * A user reported, after an agent flood: "I'm trying to read
 * replies to me but the whole groupmind is full I cannot scroll to my last
 * message". A message counts as addressed to a handle when it mentions
 * @handle in the body, replies to a message from that handle, or was sent
 * by that handle (so the reader's own question sits above the answers).
 * Pure so the room page and tests share one definition; the Android app
 * (CodeWatch) has the same rule on its side.
 */

export interface AddressableMessage {
    from: string;
    body: string;
    reply_to?: { from?: string | null } | null;
}

export function normalizeHandle(handle: string | null | undefined): string {
    return (handle || '').trim().replace(/^@/, '').toLowerCase();
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `body` mention @handle as a whole token (not a prefix of a longer handle)? */
export function mentionsHandle(body: string, handle: string): boolean {
    const h = normalizeHandle(handle);
    if (!h || !body) return false;
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])@${escapeRegExp(h)}(?![A-Za-z0-9_.-])`, 'i');
    return re.test(body);
}

export function isAddressedTo(msg: AddressableMessage, handle: string | null | undefined): boolean {
    const h = normalizeHandle(handle);
    if (!h) return false;
    if (normalizeHandle(msg.from) === h) return true;
    if (msg.reply_to && normalizeHandle(msg.reply_to.from) === h) return true;
    return mentionsHandle(msg.body || '', h);
}

/**
 * Which "for me" message should an up/down arrow jump to?
 *
 * A user asked: "can we have mentions up and down arrows, so i
 * can click to last mention of me or my message?" - after telling us the room
 * had become unreadable at ~100 messages an hour.
 *
 * Kept pure and separate from the DOM so the rule is testable: the room page
 * passes the anchor positions it measured and the current scroll position, and
 * gets back an index or null. `positions` must be in document order (oldest
 * first), which is how the room renders.
 *
 * `positions` and `current` must be THE SAME POINT of a row. The room passes
 * row CENTRES, because scrollIntoView({block:'center'}) leaves the viewport
 * centre on the centre of the row it jumped to. Passing tops against a centred
 * cursor makes the current row look half its own height above the cursor, and
 * ▲ then re-selects the row you are already reading -- the exact bug the
 * tolerance below exists to prevent, reintroduced by the units disagreeing.
 *
 * "prev" means older (up the page), "next" means newer. A tolerance stops the
 * anchor you are already parked on from counting as the one to move to —
 * without it, pressing ▲ twice lands on the same message.
 */
export function pickAdjacentAnchor(
    positions: number[],
    current: number,
    direction: 'prev' | 'next',
    tolerance = 8,
): number | null {
    if (!positions.length) return null;
    if (direction === 'prev') {
        for (let i = positions.length - 1; i >= 0; i--) {
            if (positions[i] < current - tolerance) return i;
        }
        return null;
    }
    for (let i = 0; i < positions.length; i++) {
        if (positions[i] > current + tolerance) return i;
    }
    return null;
}

/**
 * Step from a known anchor to its neighbour, by IDENTITY rather than geometry.
 *
 * The geometry version below (`pickAdjacentAnchor`) has to answer "where am I?"
 * from scroll position, and that question has no reliable answer: a row at the
 * very top or bottom of the scroll range CANNOT be centred, so the cursor stops
 * sitting where the previous jump left it and the comparison stalls -- pressing
 * ▲ at the first message returns the first message for ever. @codexmb found the
 * first half of this (tops vs a centred cursor); the DOM harness found the rest.
 *
 * So once we have jumped somewhere we remember WHICH message, and stepping is
 * an index move in the current anchor list. Remembering the id rather than the
 * index is what makes it survive a message arriving mid-read: the id is looked
 * up again every press, so the list can grow underneath it.
 *
 * Returns null when there is no neighbour in that direction, and -1 to mean
 * "I do not know where you are" -- the caller then falls back to geometry.
 */
export function stepFromAnchorId(
    ids: string[],
    currentId: string | null,
    direction: 'prev' | 'next',
): number | null | -1 {
    if (!currentId) return -1;
    const at = ids.indexOf(currentId);
    if (at === -1) return -1;
    const next = direction === 'prev' ? at - 1 : at + 1;
    if (next < 0 || next >= ids.length) return null;
    return next;
}
