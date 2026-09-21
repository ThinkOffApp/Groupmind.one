/**
 * The owner's queue: everything waiting on a decision, in one list.
 *
 * Two sources today - open pull requests and pending approvals - folded into
 * one shape so the page cycles through them without knowing what either is.
 * Adding a third kind means adding a row to `VERBS` and a block here.
 *
 * A source that fails degrades to a warning rather than emptying the queue:
 * an unreachable GitHub must not hide a pending approval.
 */

import { NextResponse } from 'next/server';
import { listPendingApprovals } from '@/lib/approvals';
import { listOpenPrs } from '@/lib/github-pr';
import { getGithubSession, sessionUserId } from '@/lib/github-session';
import { approvalItem, pullRequestItem, type QueueItem } from '@/lib/queue-items';

export async function GET() {
    const userId = await sessionUserId();
    if (!userId) {
        return NextResponse.json({ error: 'Sign in to GroupMind first', reason: 'no-session' }, { status: 401 });
    }

    const items: QueueItem[] = [];
    const warnings: string[] = [];
    let githubConnected = false;

    const session = await getGithubSession();
    if (session.ok) {
        githubConnected = true;
        try {
            const { prs, warnings: prWarnings } = await listOpenPrs({ token: session.token });
            for (const pr of prs) {
                const item = pullRequestItem(pr);
                if (item) items.push(item);
            }
            warnings.push(...prWarnings);
        } catch (e) {
            warnings.push(e instanceof Error ? e.message : 'GitHub was unreachable');
        }
    }

    try {
        for (const row of await listPendingApprovals(userId)) {
            const item = approvalItem(row);
            if (item) items.push(item);
        }
    } catch (e) {
        warnings.push(e instanceof Error ? e.message : 'Could not read your pending approvals');
    }

    return NextResponse.json({ items, warnings, github_connected: githubConnected });
}
