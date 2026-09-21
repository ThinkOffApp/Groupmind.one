-- CodeWatch relay events for push notifications

CREATE TABLE IF NOT EXISTS relay_events (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id TEXT NOT NULL,              -- target user (handle or UUID)
    event_type TEXT NOT NULL DEFAULT 'custom',  -- build, test, error, agent, mention, dm, custom
    severity TEXT NOT NULL DEFAULT 'info',       -- info, warning, error, critical
    title TEXT NOT NULL,
    body TEXT,
    source TEXT,                        -- e.g. "claude-code", "codex", "vscode", room name
    reply_target TEXT,                  -- where replies should route back to
    reply_text TEXT,                    -- reply from user (filled by reply endpoint)
    replied_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS relay_events_user_idx
    ON relay_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS relay_events_expires_idx
    ON relay_events(expires_at)
    WHERE reply_text IS NULL;
