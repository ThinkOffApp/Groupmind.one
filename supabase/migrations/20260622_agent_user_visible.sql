-- Decouple "show in the user's Your-agents list" from owner_id.
--
-- owner_id has been doubling as the "this agent belongs to the user, show it in
-- their Your-agents list" criterion. But owner_id is also required purely for
-- auth/data scoping — e.g. the action-status backend (PR #43) needs the pushing
-- daemon agent (@claudeMB) to have an owner_id so its action rows are scoped to
-- a user. Setting that owner_id surprise-added the daemon to Petrus's list.
--
-- Fix: a dedicated visibility flag. owner_id keeps meaning "which user this
-- agent's data is scoped to"; user_visible means "the user intentionally paired
-- this agent through the owned-agent registration flow." The Your-agents list
-- (GET /api/v1/agents/me/owned) filters on BOTH:
--   owner_id = <user> AND user_visible = true
--
-- Defaults false so backend/system ownership never auto-surfaces an agent.

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS user_visible boolean NOT NULL DEFAULT false;

-- Backfill: preserve every agent a user currently sees so this migration hides
-- nothing they already have. Everything presently owned stays visible...
UPDATE agents SET user_visible = true WHERE owner_id IS NOT NULL;

-- ...except agents owned ONLY for backend auth scoping, not because a human
-- paired them. A daemon agent that pushes action status needs an owner_id but
-- must not appear in Your-agents.
--
-- CONFIGURABLE, AND EMPTY BY DEFAULT. This used to name two specific agent
-- handles from the original deployment. On every other instance those rows do
-- not exist, so the statement matched nothing - it was dead weight that
-- published two handles into a public repository. Set
-- groupmind.backend_agent_handles to a comma-separated list if your deployment
-- has such agents; unset, this matches zero rows exactly as before.
-- Handle matching is case-insensitive.
UPDATE agents SET user_visible = false
    WHERE lower(handle) = ANY (
        SELECT lower(trim(h))
        FROM unnest(string_to_array(
            coalesce(current_setting('groupmind.backend_agent_handles', true), ''), ','
        )) AS h
        WHERE trim(h) <> ''
    );

COMMENT ON COLUMN agents.user_visible IS
    'Whether the owner intentionally paired this agent (via the owned-agent '
    'registration flow) and wants it in their Your-agents list. Distinct from '
    'owner_id, which only scopes the agent''s data to a user. '
    'GET /api/v1/agents/me/owned filters owner_id = user AND user_visible = true. '
    'Backend/daemon agents owned purely for auth stay false.';
