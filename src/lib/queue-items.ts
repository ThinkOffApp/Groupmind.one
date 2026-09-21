/**
 * One queue of everything waiting on the owner, and what yes/no MEAN on each.
 *
 * Button 3 cycles. Cycling changes the item, and the item defines the verb:
 * yes merges a pull request, but yes approves an action. So the verb cannot
 * live in the button - it has to live with the item, and it has to be on
 * screen BEFORE the button is pressed.
 *
 * THIS TABLE IS THE MOST IMPORTANT COPY IN THE FEATURE. Three buttons stay
 * safe only while the screen is unambiguous about what yes will do. A person
 * who has cycled twice and looked away must be able to glance back and know
 * what they are about to authorise, so every kind states its verb in a full
 * sentence, in the present tense, naming the consequence.
 *
 * Adding a kind means adding a row here. Nothing else in the queue knows what
 * a pull request is.
 */

export type ItemKind = 'pull_request' | 'approval';

export interface Verbs {
    /** One or two words for the button face. */
    yesVerb: string;
    noVerb: string;
    /** The sentence shown on the card, before anything is pressed. */
    yesSentence: string;
    noSentence: string;
    /** Extra line inside the confirmation, about what cannot be undone. */
    yesConsequence: string;
    /**
     * Whether the action leaves this browser.
     *
     * Every action that writes somewhere else needs the bound confirmation;
     * an action that only changes what this queue shows does not. That is why
     * `no` on a pull request goes straight through and `no` on an approval
     * does not: one changes a local list, the other records a denial.
     */
    yesWrites: boolean;
    noWrites: boolean;
    /** Plain label for the kind, shown on the card. */
    kindLabel: string;
}

export const VERBS: Record<ItemKind, Verbs> = {
    pull_request: {
        yesVerb: 'Merge',
        noVerb: 'Leave it',
        yesSentence: 'Yes will MERGE this pull request into its base branch on GitHub.',
        noSentence:
            'No LEAVES IT ALONE. It is not closed, not rejected, and no review is left - nothing at all is written to GitHub. It drops out of this queue until you reload.',
        yesConsequence:
            'Merging cannot be undone from here. The merge is pinned to the head commit shown above, so if the branch has moved since you looked, GitHub refuses instead of merging something else.',
        yesWrites: true,
        noWrites: false,
        kindLabel: 'Pull request',
    },
    approval: {
        yesVerb: 'Approve',
        noVerb: 'Deny',
        yesSentence: 'Yes will APPROVE this action. The agent that asked will go ahead and run it.',
        noSentence: 'No will DENY this action. The agent that asked will not run it, and the denial is recorded.',
        yesConsequence:
            'The agent acts on this as soon as it sees the decision. A denial is recorded the same way, and neither can be taken back from this page.',
        yesWrites: true,
        noWrites: true,
        kindLabel: 'Approval',
    },
};

/** A pull request waiting to be merged. */
export interface PullRequestItem {
    kind: 'pull_request';
    id: string;
    /** What changed since the card was built; the merge is pinned to it. */
    fingerprint: string;
    title: string;
    subtitle: string;
    detail: string;
    url: string | null;
    /** A draft is shown but cannot be said yes to. */
    blocked: string | null;
    owner: string;
    repo: string;
    number: number;
    headSha: string;
}

/** An action an agent is asking permission to take. */
export interface ApprovalItem {
    kind: 'approval';
    id: string;
    fingerprint: string;
    title: string;
    subtitle: string;
    detail: string;
    url: string | null;
    blocked: string | null;
    intentId: string;
}

export type QueueItem = PullRequestItem | ApprovalItem;

export const verbsFor = (item: Pick<QueueItem, 'kind'>): Verbs => VERBS[item.kind];

/** Does this decision leave the browser, and therefore need confirming? */
export function writesSomewhereElse(item: Pick<QueueItem, 'kind'>, action: 'yes' | 'no'): boolean {
    const v = VERBS[item.kind];
    return action === 'yes' ? v.yesWrites : v.noWrites;
}

/** Stable across reloads, and unique across kinds. */
export const prItemId = (p: { owner: string; repo: string; number: number }): string =>
    `pr:${p.owner}/${p.repo}#${p.number}`;

export const approvalItemId = (intentId: string): string => `approval:${intentId}`;

export interface OpenPrShape {
    owner: string;
    repo: string;
    number: number;
    title: string;
    author: string;
    url: string;
    draft: boolean;
    headSha: string | null;
    mergeable: boolean | null;
    mergeableState: string | null;
}

/** A GitHub PR as a queue item. Returns null when it cannot be acted on. */
export function pullRequestItem(pr: OpenPrShape): PullRequestItem | null {
    if (!pr.headSha) return null;
    return {
        kind: 'pull_request',
        id: prItemId(pr),
        // The head commit IS the fingerprint: if it changes, the thing being
        // agreed to has changed.
        fingerprint: pr.headSha,
        title: pr.title,
        subtitle: `${pr.owner}/${pr.repo} #${pr.number}`,
        detail: [
            `by ${pr.author || 'unknown'}`,
            `head ${pr.headSha.slice(0, 10)}`,
            pr.mergeable === true
                ? 'mergeable'
                : pr.mergeable === false
                  ? `not mergeable${pr.mergeableState ? ` (${pr.mergeableState})` : ''}`
                  : 'mergeability unknown',
        ].join(' · '),
        url: pr.url,
        blocked: pr.draft ? 'This is a draft. Mark it ready on GitHub before merging.' : null,
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha,
    };
}

export interface PendingActionShape {
    intent_id: string;
    target_summary: string | null;
    actor: string | null;
    created_at: string | null;
    updated_at: string | null;
}

/** A pending action_status row as a queue item. */
export function approvalItem(row: PendingActionShape): ApprovalItem | null {
    if (!row.intent_id) return null;
    return {
        kind: 'approval',
        id: approvalItemId(row.intent_id),
        // The row's own last-write time: if the agent revised the request,
        // a confirmation opened on the old text must not carry over.
        fingerprint: row.updated_at || row.created_at || row.intent_id,
        title: row.target_summary?.trim() || 'An agent is asking for permission',
        subtitle: row.actor ? `asked by ${row.actor}` : 'asked by an agent',
        detail: `intent ${row.intent_id}`,
        url: null,
        blocked: null,
        intentId: row.intent_id,
    };
}
