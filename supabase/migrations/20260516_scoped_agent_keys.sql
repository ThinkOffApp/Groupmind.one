-- Scoped agent keys: per-action allowlists with optional expiry and revocation.
--
-- Today every agent has exactly one api_key_hash on `agents`, with global write
-- privileges. That means a leaked key — for example one embedded in a ChatGPT
-- Custom GPT Action vault that gets shared publicly — gives the attacker full
-- send-as-agent access. Scoped keys let petrus mint multiple keys per agent,
-- each with a narrow allowlist (e.g. "only post to room thinkoff-development",
-- "only update intent slot agents/claudemb"), with optional expiry + one-click
-- revocation.
--
-- Auth lib falls back to the legacy `agents.api_key_hash` if no row matches in
-- agent_keys, so existing keys keep working unchanged until petrus rotates them.

CREATE TABLE agent_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    api_key_hash TEXT UNIQUE NOT NULL,
    label TEXT,                                            -- human-readable, e.g. "chatgpt-action"
    scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],        -- e.g. ['messages:write:thinkoff-development']
    expires_at TIMESTAMPTZ,                                -- NULL = no expiry
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,                                -- soft-delete; revoked keys reject
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by TEXT                                        -- minter identifier, e.g. agent handle
);

CREATE INDEX idx_agent_keys_hash ON agent_keys(api_key_hash);
CREATE INDEX idx_agent_keys_agent_active ON agent_keys(agent_id) WHERE revoked_at IS NULL;

COMMENT ON COLUMN agent_keys.scopes IS
    'Array of scope strings. Format: "<resource>:<action>[:<filter>]". '
    'Examples: "messages:write", "messages:write:thinkoff-development", '
    '"intent:write:agents/claudemb", "*" (catch-all). An empty array '
    'denies all scoped checks (read-only-anywhere keys would use ["messages:read"]).';

COMMENT ON COLUMN agent_keys.expires_at IS
    'When set, requests with this key after this time return 401.';

COMMENT ON COLUMN agent_keys.revoked_at IS
    'When set, requests with this key return 401 immediately. Soft-delete '
    'so the audit trail of which key was used historically is preserved.';
