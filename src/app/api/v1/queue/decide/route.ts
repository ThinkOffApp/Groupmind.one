/**
 * Commit one decision from the queue.
 *
 * Every write the three buttons can cause comes through here, so there is one
 * place where the session is checked and one place where the freshness guard
 * is enforced. `fingerprint` is what the person had on screen: the head commit
 * for a pull request, the row's last-write time for an approval. If it no
 * longer matches, the write is refused rather than committing something the
 * person did not read.
 *
 * `no` on a pull request never reaches this route: leaving a PR alone writes
 * nothing anywhere, so it is a change to the local queue only.
 */

import { NextResponse } from 'next/server';
import { decideApproval } from '@/lib/approvals';
import { mergePr } from '@/lib/github-pr';
import { getGithubSession, sessionUserId } from '@/lib/github-session';

interface DecideBody {
    kind?: unknown;
    action?: unknown;
    fingerprint?: unknown;
    owner?: unknown;
    repo?: unknown;
    number?: unknown;
    draft?: unknown;
    intent_id?: unknown;
}

export async function POST(request: Request) {
    const userId = await sessionUserId();
    if (!userId) {
        return NextResponse.json({ error: 'Sign in to GroupMind first', reason: 'no-session' }, { status: 401 });
    }

    let body: DecideBody;
    try {
        body = (await request.json()) as DecideBody;
    } catch {
        return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });
    }

    const kind = typeof body.kind === 'string' ? body.kind : '';
    const action = body.action === 'yes' || body.action === 'no' ? body.action : null;
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim() : '';

    if (!action) {
        return NextResponse.json({ error: 'action must be "yes" or "no"' }, { status: 400 });
    }
    if (!fingerprint) {
        return NextResponse.json(
            {
                error:
                    'fingerprint is required - a decision is pinned to the version you were shown, ' +
                    'so anything that moved since then fails instead of being committed',
            },
            { status: 400 }
        );
    }

    if (kind === 'pull_request') {
        if (action === 'no') {
            // Leaving a pull request alone writes nothing. It is refused here
            // rather than quietly succeeding, so nobody builds a UI that
            // expects this route to close or reject a PR.
            return NextResponse.json(
                { error: 'Leaving a pull request alone changes nothing on GitHub and is not a server action' },
                { status: 400 }
            );
        }

        const session = await getGithubSession();
        if (!session.ok) {
            return NextResponse.json(
                { error: session.reason === 'no-session' ? 'Sign in to GroupMind first' : 'GitHub is not connected', reason: session.reason },
                { status: 401 }
            );
        }

        const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
        const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
        const number = typeof body.number === 'number' ? body.number : Number(body.number);
        if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
            return NextResponse.json({ error: 'owner, repo and number are required' }, { status: 400 });
        }

        const outcome = await mergePr(
            // The fingerprint IS the head SHA for a pull request.
            { owner, repo, number, headSha: fingerprint, draft: body.draft === true },
            { token: session.token }
        );
        if (outcome.merged) return NextResponse.json({ committed: true, message: outcome.message });
        return NextResponse.json({ committed: false, reason: outcome.reason }, { status: 409 });
    }

    if (kind === 'approval') {
        const intentId = typeof body.intent_id === 'string' ? body.intent_id.trim() : '';
        if (!intentId) return NextResponse.json({ error: 'intent_id is required' }, { status: 400 });

        const outcome = await decideApproval(
            userId,
            intentId,
            action === 'yes' ? 'approve' : 'deny',
            fingerprint,
            userId
        );
        if (outcome.ok) {
            return NextResponse.json({
                committed: true,
                message: outcome.status === 'approved' ? 'Approved' : 'Denied',
            });
        }
        return NextResponse.json({ committed: false, reason: outcome.reason }, { status: 409 });
    }

    return NextResponse.json({ error: `Unknown item kind "${kind}"` }, { status: 400 });
}
