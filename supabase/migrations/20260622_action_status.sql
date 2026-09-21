-- Central action-status store for CodeWatch approval buttons.
--
-- Today the live status of an intent (pending → approved/denied → executed)
-- only exists in the Mini's localhost IAK daemon. Phones off the LAN cannot
-- reach that daemon, so CodeWatch buttons cannot render real state when away
-- from home. This table is a phone-reachable mirror: the IAK daemon pushes
-- every transition here via POST /api/v1/actions, and the app reads it back
-- via GET /api/v1/actions/{intent_id} to render the current button state.
--
-- Rows are scoped to an owner (the human user who owns the pushing agent),
-- matching how `agents.owner_id` and `relay_events.user_id` are TEXT handles
-- or UUIDs. Access is via the service-role client in API routes, so there is
-- no RLS policy here (mirrors relay_events / clawwatch_devices, which are also
-- gated entirely in-route by the X-API-Key check).
--
-- The primary key is the COMPOSITE (owner_id, intent_id): an intent_id is only
-- unique within an owner, so one owner can never read or overwrite another
-- owner's row even if it learns their intent_id. Writes upsert on this composite
-- key; reads scope by both columns.

CREATE TABLE IF NOT EXISTS action_status (
    intent_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,                 -- owning user (agent.owner_id; required, no handle fallback)
    status TEXT NOT NULL,                   -- pending | processing | approved | denied | completed | failed | expired | unknown
    decision TEXT,                          -- approve | deny | NULL
    approver TEXT,                          -- who approved/denied
    actor TEXT,                             -- which agent/daemon executed
    target_summary TEXT,                    -- human-readable description of the action
    receipt TEXT,                           -- execution result / receipt
    error TEXT,                             -- failure detail when status = failed
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, intent_id),
    CONSTRAINT action_status_status_check CHECK (status IN (
        'pending', 'processing', 'approved', 'denied',
        'completed', 'failed', 'expired', 'unknown'
    )),
    CONSTRAINT action_status_decision_check CHECK (
        decision IS NULL OR decision IN ('approve', 'deny')
    )
);

CREATE INDEX IF NOT EXISTS action_status_owner_idx
    ON action_status(owner_id, updated_at DESC);

COMMENT ON COLUMN action_status.status IS
    'Lifecycle state. One of: pending, processing, approved, denied, '
    'completed, failed, expired, unknown.';

COMMENT ON COLUMN action_status.owner_id IS
    'Owning user, set from the authenticated agent''s owner_id (required; the '
    'route rejects agents with no owner_id rather than falling back to the '
    'handle). Part of the composite primary key; GET scopes results to this value.';

-- Atomic conditional upsert for action_status.
--
-- The route previously did a SELECT then a separate UPSERT, which is a TOCTOU
-- race: a stale `pending` push could read the row BEFORE a `completed` push
-- landed, then overwrite the now-terminal row. This function collapses the
-- monotonic guard AND per-field preservation into a single SQL statement so the
-- read and the write are one atomic operation under the row lock taken by
-- INSERT ... ON CONFLICT.
--
-- Two behaviours:
--   1. Monotonic transitions — the DO UPDATE WHERE clause uses a status RANK to
--      decide whether an incoming push may overwrite the existing row:
--        * Terminal rows (completed/failed/denied/expired) are IMMUTABLE except
--          for identical-status enrichment (e.g. a `completed` push re-landing to
--          fill in a receipt). Any differing status is rejected.
--        * Non-terminal rows only ever move FORWARD or stay put: an incoming
--          status is accepted only when its rank is >= the existing row's rank.
--      This is stricter than a plain "non-terminal" guard: `approved` (rank 30)
--      is itself non-terminal, so under the old guard a stale `pending`/
--      `processing` push could overwrite an `approved` row and make the phone
--      re-show Approve/Deny. The rank guard blocks approved(30) -> pending(10)/
--      processing(20) while still allowing approved -> completed (50 >= 30) and
--      pending -> approved (30 >= 10).
--      When the guard rejects an update the conflicting INSERT writes nothing and
--      the statement RETURNS NO ROW. The caller treats "no row returned" as
--      "ignored — fetch & return the existing row" (idempotent 200).
--   2. Field preservation — every nullable column uses
--      COALESCE(EXCLUDED.col, action_status.col) so a push that omits a field
--      (passes NULL) keeps the previously stored value instead of clobbering it.
--
-- created_at is only written on INSERT (via VALUES) and never in DO UPDATE, so
-- the original creation timestamp is preserved across updates.

-- Monotonic rank for action statuses. Higher = further along the lifecycle.
-- unknown(0) < pending(10) < processing(20) < approved(30) < denied(40)
-- < completed/failed/expired(50). Used by the upsert guard to reject rank
-- downgrades (e.g. a stale pending push after approved). IMMUTABLE so it can be
-- inlined and used in the conditional upsert's WHERE clause cheaply.
CREATE OR REPLACE FUNCTION action_status_rank(p_status text)
RETURNS int AS $$
    SELECT CASE p_status
        WHEN 'unknown'    THEN 0
        WHEN 'pending'    THEN 10
        WHEN 'processing' THEN 20
        WHEN 'approved'   THEN 30
        WHEN 'denied'     THEN 40
        WHEN 'completed'  THEN 50
        WHEN 'failed'     THEN 50
        WHEN 'expired'    THEN 50
        ELSE 0
    END;
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION upsert_action_status(
    p_owner_id text,
    p_intent_id text,
    p_status text,
    p_decision text default null,
    p_approver text default null,
    p_actor text default null,
    p_target_summary text default null,
    p_receipt text default null,
    p_error text default null,
    p_decided_at timestamptz default null,
    p_executed_at timestamptz default null
) RETURNS action_status AS $$
    INSERT INTO action_status (
        owner_id, intent_id, status, decision, approver, actor,
        target_summary, receipt, error, decided_at, executed_at,
        created_at, updated_at
    )
    VALUES (
        p_owner_id, p_intent_id, p_status, p_decision, p_approver, p_actor,
        p_target_summary, p_receipt, p_error, p_decided_at, p_executed_at,
        now(), now()
    )
    ON CONFLICT (owner_id, intent_id) DO UPDATE SET
        status = EXCLUDED.status,
        decision = COALESCE(EXCLUDED.decision, action_status.decision),
        approver = COALESCE(EXCLUDED.approver, action_status.approver),
        actor = COALESCE(EXCLUDED.actor, action_status.actor),
        target_summary = COALESCE(EXCLUDED.target_summary, action_status.target_summary),
        receipt = COALESCE(EXCLUDED.receipt, action_status.receipt),
        error = COALESCE(EXCLUDED.error, action_status.error),
        decided_at = COALESCE(EXCLUDED.decided_at, action_status.decided_at),
        executed_at = COALESCE(EXCLUDED.executed_at, action_status.executed_at),
        updated_at = now()
    WHERE
        -- terminal rows are immutable except identical-status enrichment
        ( action_status.status IN ('completed', 'failed', 'denied', 'expired')
          AND EXCLUDED.status = action_status.status )
        OR
        -- non-terminal rows: only move forward or stay (no rank downgrade)
        ( action_status.status NOT IN ('completed', 'failed', 'denied', 'expired')
          AND action_status_rank(EXCLUDED.status) >= action_status_rank(action_status.status)
          -- a decided 'approved' must not flip to 'denied' (the two decision
          -- states are mutually exclusive once set). pending/processing -> denied
          -- stays valid (a pending intent can still be denied).
          AND NOT (action_status.status = 'approved' AND EXCLUDED.status = 'denied') )
    RETURNING *;
$$ LANGUAGE sql;
