/**
 * The approvals half of the queue: actions agents are asking permission for.
 *
 * This invents no storage. It reads the `action_status` table that already
 * backs `/api/v1/actions` - the same rows the IAK daemon pushes and CodeWatch
 * reads - and writes decisions back through the same `upsert_action_status`
 * function, so the monotonic-transition guard that lives in SQL applies to a
 * decision made here exactly as it does to one pushed by an agent.
 *
 * The one thing that is new is the caller. `/api/v1/actions` is authenticated
 * by agent API key and scopes rows by the agent's `owner_id`. Here the caller
 * is the signed-in person, so `owner_id` is their user id, and every query is
 * scoped by it. A person can only ever see and decide their own rows.
 */

import { getServiceSupabase } from './supabase-service';

export interface PendingAction {
    intent_id: string;
    target_summary: string | null;
    actor: string | null;
    created_at: string | null;
    updated_at: string | null;
}

export type Decision = 'approve' | 'deny';

/** Rows the agent side may have written that are still waiting on a person. */
const PENDING_STATUS = 'pending';

/**
 * Actions waiting on this person, oldest first.
 *
 * Oldest first on purpose: a queue you cycle should surface the thing that has
 * been waiting longest, not the newest arrival.
 */
export async function listPendingApprovals(
    userId: string,
    client = getServiceSupabase()
): Promise<PendingAction[]> {
    const { data, error } = await client
        .from('action_status')
        .select('intent_id, target_summary, actor, created_at, updated_at')
        .eq('owner_id', userId)
        .eq('status', PENDING_STATUS)
        .order('created_at', { ascending: true })
        .limit(50);

    if (error) throw new Error('Could not read your pending approvals');
    return (data ?? []) as unknown as PendingAction[];
}

export type DecideOutcome =
    | { ok: true; status: string }
    | { ok: false; reason: string; stale: boolean };

/**
 * Record a decision on one action.
 *
 * `expectedFingerprint` is the row's `updated_at` as it was when the person
 * read it. If the agent has revised the request since, the write is refused
 * rather than silently approving different text - the same rule as the head
 * SHA on a pull request, for the same reason.
 */
export async function decideApproval(
    userId: string,
    intentId: string,
    decision: Decision,
    expectedFingerprint: string,
    approver: string,
    client = getServiceSupabase()
): Promise<DecideOutcome> {
    const { data: row, error: readError } = await client
        .from('action_status')
        .select('intent_id, status, updated_at, created_at')
        .eq('owner_id', userId)
        .eq('intent_id', intentId)
        .maybeSingle();

    if (readError) return { ok: false, reason: 'Could not read that action', stale: false };
    if (!row) return { ok: false, reason: 'That action is not yours, or no longer exists', stale: true };

    const current = row as unknown as { status: string; updated_at: string | null; created_at: string | null };

    if (current.status !== PENDING_STATUS) {
        return {
            ok: false,
            reason: `That action is already ${current.status} - nothing was changed`,
            stale: true,
        };
    }

    const fingerprint = current.updated_at || current.created_at || intentId;
    if (fingerprint !== expectedFingerprint) {
        return {
            ok: false,
            reason: 'The request changed since you read it - nothing was changed. Read it again.',
            stale: true,
        };
    }

    const status = decision === 'approve' ? 'approved' : 'denied';
    const { error: writeError } = await client.rpc('upsert_action_status', {
        p_owner_id: userId,
        p_intent_id: intentId,
        p_status: status,
        p_decision: decision,
        p_approver: approver,
        p_actor: null,
        p_target_summary: null,
        p_receipt: null,
        p_error: null,
        p_decided_at: new Date().toISOString(),
        p_executed_at: null,
    });

    if (writeError) return { ok: false, reason: 'Could not record that decision', stale: false };
    return { ok: true, status };
}
