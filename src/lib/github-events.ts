/**
 * GitHub webhook payload -> one room line (antfarm github-webhook route).
 *
 * Pure: no I/O, no env reads, so the route can stay thin and this can be
 * unit-tested with recorded payloads. Two kinds of line come out:
 *
 * 1. Merged pull requests, from anyone. The fleet reacts to this line
 *    (post-merge pulls, release checks), so its text is kept byte-for-byte
 *    as it has been since antfarm#87.
 * 2. Activity by OUTSIDERS: issues, comments, PRs opened or reviewed,
 *    stars, forks, discussions. The owner asked for this: "monitoring for github
 *    mentions or activity on our repos by someone else than us". Our own
 *    logins and GitHub's bots are filtered here so the room does not echo
 *    the fleet's own work back at it.
 */

export type GithubEventResult =
    | { kind: 'post'; body: string; metadata: Record<string, unknown> }
    | { kind: 'ignore'; reason: string };

// Whatever GitHub sends; only the fields read below are typed.
export interface GithubPayload {
    action?: string;
    sender?: { login?: string };
    repository?: { name?: string; full_name?: string; stargazers_count?: number };
    pull_request?: {
        number?: number; title?: string; merged?: boolean;
        html_url?: string; merged_by?: { login?: string };
    };
    review?: { state?: string; body?: string | null; html_url?: string };
    issue?: { number?: number; title?: string; html_url?: string; pull_request?: unknown };
    comment?: { body?: string | null; html_url?: string };
    forkee?: { full_name?: string; html_url?: string };
    discussion?: { number?: number; title?: string; html_url?: string };
}

const SNIPPET_CHARS = 140;

/** Logins that count as "us": case-insensitive, plus every GitHub app bot. */
export function isInsider(login: string | undefined, insiders: Iterable<string>): boolean {
    if (!login) return true; // no actor = nothing worth attributing
    const l = login.toLowerCase();
    if (l.endsWith('[bot]')) return true;
    for (const i of insiders) if (i.trim().toLowerCase() === l) return true;
    return false;
}

/** Parse the GITHUB_WEBHOOK_INSIDERS env value: comma-separated logins. */
export function parseInsiders(raw: string | undefined, defaults: string[]): string[] {
    const extra = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return [...new Set([...defaults, ...extra])];
}

/** Room messages render through ReactMarkdown with no element restriction,
 * so outsider text must not carry live Markdown: `![x](url)` in an issue
 * title would make every viewer fetch an attacker's URL (Codex review of
 * #122). CommonMark lets a backslash neutralise any ASCII punctuation; this
 * escapes the characters that open images, links, HTML, autolinks,
 * emphasis, code, headings, tables and strikethrough. */
export function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_[\]()!<>#~|]/g, '\\$&');
}

function snippet(text: string | null | undefined): string {
    const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
    const clipped = oneLine.length <= SNIPPET_CHARS ? oneLine : oneLine.slice(0, SNIPPET_CHARS - 1) + '…';
    return escapeMarkdown(clipped);
}

function quoted(text: string | null | undefined): string {
    const s = snippet(text);
    return s ? ` "${s}"` : '';
}

export function formatGithubEvent(
    event: string | null,
    payload: GithubPayload,
    insiders: Iterable<string>,
): GithubEventResult {
    const repo = payload.repository?.name ?? 'unknown-repo';
    const actor = payload.sender?.login;
    const base = { source: 'github-webhook', repo, actor };
    const ignore = (reason: string): GithubEventResult => ({ kind: 'ignore', reason });

    // Merged PRs are the one event that posts regardless of who did it.
    if (event === 'pull_request' && payload.action === 'closed') {
        const pr = payload.pull_request;
        if (!pr?.merged) return ignore('not a merge');
        const merger = pr.merged_by?.login ?? 'someone';
        const title = (pr.title ?? '').slice(0, 120);
        return {
            kind: 'post',
            body: `Merged: ${repo}#${pr.number} "${title}" by ${merger} - ${pr.html_url}`,
            metadata: { source: 'github-webhook', repo, pr: pr.number },
        };
    }

    if (isInsider(actor, insiders)) return ignore(`insider ${actor ?? 'unknown'}`);

    switch (event) {
        case 'pull_request': {
            const pr = payload.pull_request;
            if (payload.action !== 'opened' && payload.action !== 'reopened') {
                return ignore(`pull_request ${payload.action}`);
            }
            return {
                kind: 'post',
                body: `PR ${payload.action}: ${repo}#${pr?.number} "${snippet(pr?.title)}" by ${actor} - ${pr?.html_url}`,
                metadata: { ...base, kind: 'pull_request', pr: pr?.number },
            };
        }
        case 'pull_request_review': {
            if (payload.action !== 'submitted') return ignore(`review ${payload.action}`);
            const state = (payload.review?.state ?? '').toLowerCase().replace('_', ' ');
            // An empty "commented" review is GitHub's wrapper around inline
            // comments, which arrive as their own event below.
            if (state === 'commented' && !snippet(payload.review?.body)) return ignore('empty review wrapper');
            return {
                kind: 'post',
                body: `PR review (${state || 'submitted'}): ${repo}#${payload.pull_request?.number} by ${actor}${quoted(payload.review?.body)} - ${payload.review?.html_url}`,
                metadata: { ...base, kind: 'pull_request_review', pr: payload.pull_request?.number, state },
            };
        }
        case 'pull_request_review_comment': {
            if (payload.action !== 'created') return ignore(`review comment ${payload.action}`);
            return {
                kind: 'post',
                body: `PR comment: ${repo}#${payload.pull_request?.number} by ${actor}${quoted(payload.comment?.body)} - ${payload.comment?.html_url}`,
                metadata: { ...base, kind: 'pull_request_review_comment', pr: payload.pull_request?.number },
            };
        }
        case 'issues': {
            const a = payload.action;
            if (a !== 'opened' && a !== 'reopened' && a !== 'closed') return ignore(`issues ${a}`);
            const issue = payload.issue;
            return {
                kind: 'post',
                body: `Issue ${a}: ${repo}#${issue?.number} "${snippet(issue?.title)}" by ${actor} - ${issue?.html_url}`,
                metadata: { ...base, kind: 'issues', issue: issue?.number },
            };
        }
        case 'issue_comment': {
            if (payload.action !== 'created') return ignore(`issue comment ${payload.action}`);
            const issue = payload.issue;
            // GitHub sends PR conversation comments as issue_comment; the
            // metadata key follows what the number actually is.
            const onPr = Boolean(issue?.pull_request);
            return {
                kind: 'post',
                body: `${onPr ? 'PR' : 'Issue'} comment: ${repo}#${issue?.number} by ${actor}${quoted(payload.comment?.body)} - ${payload.comment?.html_url}`,
                metadata: onPr
                    ? { ...base, kind: 'issue_comment', pr: issue?.number }
                    : { ...base, kind: 'issue_comment', issue: issue?.number },
            };
        }
        case 'star': {
            if (payload.action !== 'created') return ignore(`star ${payload.action}`);
            const n = payload.repository?.stargazers_count;
            const count = typeof n === 'number' ? ` (${n} star${n === 1 ? '' : 's'})` : '';
            return {
                kind: 'post',
                body: `Star: ${repo} starred by ${actor}${count}`,
                metadata: { ...base, kind: 'star' },
            };
        }
        case 'fork': {
            return {
                kind: 'post',
                body: `Fork: ${repo} forked by ${actor} - ${payload.forkee?.html_url}`,
                metadata: { ...base, kind: 'fork', forkee: payload.forkee?.full_name },
            };
        }
        case 'discussion': {
            if (payload.action !== 'created') return ignore(`discussion ${payload.action}`);
            const d = payload.discussion;
            return {
                kind: 'post',
                body: `Discussion: ${repo}#${d?.number} "${snippet(d?.title)}" by ${actor} - ${d?.html_url}`,
                metadata: { ...base, kind: 'discussion', discussion: d?.number },
            };
        }
        case 'discussion_comment': {
            if (payload.action !== 'created') return ignore(`discussion comment ${payload.action}`);
            const d = payload.discussion;
            return {
                kind: 'post',
                body: `Discussion comment: ${repo}#${d?.number} by ${actor}${quoted(payload.comment?.body)} - ${payload.comment?.html_url}`,
                metadata: { ...base, kind: 'discussion_comment', discussion: d?.number },
            };
        }
        default:
            return ignore(event ?? 'no event');
    }
}
