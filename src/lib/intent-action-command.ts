/**
 * The chat command an action-button tap posts back to the room.
 *
 * Buttons used to be an Approve/Deny pair, and both clients recognised exactly
 * those two prefixes and silently dropped anything else. Choice intents
 * (ide-agent-kit feat/choice-intents) emit arbitrary labels — model names, for
 * instance — so the client must carry a label through rather than recognise
 * it. The daemon holds the option list as an allow-list and refuses unknown or
 * stale labels, leaving the intent pending; this function is plumbing, not a
 * security boundary.
 *
 * The declared spelling is posted verbatim: the daemon matches
 * case-insensitively and trimmed but stores the declared form, so normalising
 * here could only disagree with it.
 *
 * Returns null when there is nothing sensible to post. Callers must resolve
 * this BEFORE writing any optimistic state — the Android swallow bug was an
 * ordering bug, not a missing branch: it marked the intent decided, persisted
 * that, and only then hit the unknown-label return, so the tap greyed the
 * button out and sent nothing.
 */
export function intentActionCommand(
    intentId: string | null | undefined,
    action: string | null | undefined,
): string | null {
    if (!intentId) return null;
    const label = (action || '').trim();
    if (!label) return null;
    const lower = label.toLowerCase();
    if (lower.startsWith('approve')) return `/approve ${intentId}`;
    if (lower.startsWith('deny')) return `/deny ${intentId}`;
    return `/choose ${intentId} ${label}`;
}
