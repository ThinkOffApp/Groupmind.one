// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';

// Statuses the POST handler will accept and store. This deliberately EXCLUDES
// 'unknown': that is a synthetic value the GET route returns for missing/stale
// intents and must never be persisted by the daemon. A POST with status
// 'unknown' (or anything outside this set) is rejected with HTTP 400.
const POST_STATUSES = [
    'pending',
    'processing',
    'approved',
    'denied',
    'completed',
    'failed',
    'expired',
] as const;
type PostStatus = (typeof POST_STATUSES)[number];

// The monotonic-transition guard (terminal states: completed, failed, denied,
// expired) now lives inside the upsert_action_status() SQL function so the read
// and write are atomic. See supabase/migrations/20260622_action_status.sql.

// POST /api/v1/actions
//
// Idempotent upsert of an action's status, keyed on the composite
// (owner_id, intent_id). The IAK daemon pushes every transition here so phones
// off the LAN can read real button state via GET /api/v1/actions/{intent_id}.
//
// Two guarantees enforced here:
//   1. Owner isolation — the row is scoped to the caller's owner_id, so one
//      owner can never overwrite another owner's row for the same intent_id.
//   2. Monotonic transitions — if the existing row is already in a terminal
//      status, an out-of-order push of a non-terminal status is ignored and the
//      existing row is returned unchanged (HTTP 200, idempotent-style).
//
// Duplicate pushes never error: the row is upserted on (owner_id, intent_id).
export async function POST(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        if (!apiKey) {
            return NextResponse.json(
                { error: 'Missing API key. Provide X-API-Key or Authorization: Bearer ***' },
                { status: 401 }
            );
        }

        const agent = await getAgentByApiKey(apiKey, 'id, handle, name, owner_id');
        if (!agent) {
            return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
        }

        let body: Record<string, unknown> | null = null;
        try {
            body = await request.json();
        } catch (e) {
            return NextResponse.json({ error: 'Invalid JSON', detail: String(e) }, { status: 400 });
        }
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid action payload' }, { status: 400 });
        }

        const {
            intent_id,
            status,
            decision,
            approver,
            actor,
            target_summary,
            receipt,
            error: actionError,
            decided_at,
            executed_at,
        } = body as Record<string, unknown>;

        if (typeof intent_id !== 'string' || intent_id.trim().length === 0) {
            return NextResponse.json({ error: 'intent_id is required' }, { status: 400 });
        }
        if (typeof status !== 'string' || !POST_STATUSES.includes(status as PostStatus)) {
            // Note: 'unknown' is intentionally rejected here. It is a synthetic
            // value the GET route returns for missing/stale intents and is never
            // a valid status to store.
            return NextResponse.json(
                { error: `status is required and must be one of: ${POST_STATUSES.join(', ')}` },
                { status: 400 }
            );
        }

        // Owner scoping: the human user who owns this agent. This table is read
        // by the phone under the owner's real user id, so we REQUIRE a real
        // owner_id — falling back to the agent handle (e.g. "@claudemm") would
        // write rows the phone can never see. Reject agents with no owner_id.
        const ownerId = (agent as { owner_id?: string | null }).owner_id;
        if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
            return NextResponse.json(
                {
                    error:
                        'Agent has no owner_id; action status requires an owner. ' +
                        'Cannot store under the agent handle.',
                },
                { status: 422 }
            );
        }

        const intentId = intent_id.trim();
        const supabase = getServiceSupabase();

        // Atomic conditional upsert. The monotonic-transition guard AND per-field
        // preservation both live inside the upsert_action_status() SQL function,
        // so the read and write are a single statement under one row lock. This
        // closes the TOCTOU race the old read-then-upsert had: a stale `pending`
        // push could read the row before a `completed` push landed, then
        // overwrite the now-terminal row.
        //
        // The function's DO UPDATE WHERE clause skips updating a row that is
        // already terminal (unless the incoming status equals it). When skipped,
        // the conflicting INSERT writes nothing and the function returns NO ROW —
        // we treat that as "ignored" and fetch + return the existing row so the
        // caller always gets the authoritative current state (idempotent 200).
        const { data: upserted, error: rpcError } = await supabase
            .rpc('upsert_action_status', {
                p_owner_id: ownerId,
                p_intent_id: intentId,
                p_status: status,
                p_decision: typeof decision === 'string' ? decision : null,
                p_approver: typeof approver === 'string' ? approver : null,
                p_actor: typeof actor === 'string' ? actor : null,
                p_target_summary: typeof target_summary === 'string' ? target_summary : null,
                p_receipt: typeof receipt === 'string' ? receipt : null,
                p_error: typeof actionError === 'string' ? actionError : null,
                p_decided_at: typeof decided_at === 'string' ? decided_at : null,
                p_executed_at: typeof executed_at === 'string' ? executed_at : null,
            })
            .maybeSingle();

        if (rpcError) {
            console.error('Error upserting action_status:', rpcError);
            return NextResponse.json({ error: 'Failed to store action status' }, { status: 500 });
        }

        if (upserted) {
            // The upsert took effect (insert or allowed update): return the new row.
            return NextResponse.json(upserted, { status: 200 });
        }

        // No row returned: the existing row was terminal and the monotonic guard
        // protected it from a non-terminal downgrade. Fetch the authoritative
        // existing row, scoped to this owner, and return it unchanged (200).
        const { data: existing, error: readError } = await supabase
            .from('action_status')
            .select('*')
            .eq('owner_id', ownerId)
            .eq('intent_id', intentId)
            .maybeSingle();

        if (readError) {
            console.error('Error reading existing action_status:', readError);
            return NextResponse.json({ error: 'Failed to store action status' }, { status: 500 });
        }

        return NextResponse.json(existing, { status: 200 });
    } catch (error) {
        console.error('Error in POST /api/v1/actions:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
