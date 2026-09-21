-- SPDX-License-Identifier: AGPL-3.0-only
-- Core tables that the application queries but that no migration ever created.
--
-- WHY THIS FILE EXISTS
-- On a fresh database the previous migration set failed: 20260201, 20260302,
-- 20260304 and 20260612 are ALTER-only migrations against tables (rooms,
-- room_members, messages) whose CREATE TABLE was never committed. The
-- production database has them because they were created by hand in the
-- Supabase SQL editor. A new self-hoster got an app that rendered and then
-- errored on every chat query.
--
-- The column sets below are reconstructed from application usage, not from a
-- dump of production. Where production has drifted from this, production wins
-- and this file should be corrected - but it is enough for a working local
-- install and it makes the migration chain apply cleanly from empty.
--
-- Numbered 003 so it sorts after 001/002 and before the 2026* migrations that
-- ALTER these tables.

-- ---------------------------------------------------------------------------
-- agents: columns the app reads that 001_initial_schema.sql did not create.
-- ---------------------------------------------------------------------------
ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_url TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_address TEXT;

-- agents.owner_user_id
--
-- FLAGGED FOR REVIEW, not a fix. The RLS policies in
-- 20260201_add_user_id_to_room_members.sql are written against
-- `agents.owner_user_id`, a column no migration has ever created - that
-- migration cannot apply to an empty database without it. The application
-- itself stores the owning auth user in `agents.owner_id` (declared TEXT in
-- 001_initial_schema.sql, compared against auth.users UUIDs in the code).
--
-- Adding the column here is the minimum that lets the chain apply. It does
-- NOT make those policies correct: nothing writes owner_user_id, so the
-- policies match no rows. Every affected path goes through the service-role
-- client and bypasses RLS, so the app works regardless - but the mismatch
-- between owner_id and owner_user_id should be resolved deliberately rather
-- than papered over here.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_user_id UUID;

-- ---------------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    is_public   BOOLEAN NOT NULL DEFAULT true,
    invite_code TEXT UNIQUE,
    created_by  UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 20260612_personal_rooms.sql adds rooms.kind and rooms.owner_user_id.

CREATE INDEX IF NOT EXISTS idx_rooms_is_public ON rooms(is_public);

-- ---------------------------------------------------------------------------
-- room_members
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_members (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id   UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    agent_id  UUID REFERENCES agents(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 20260201_add_user_id_to_room_members.sql adds room_members.user_id and the
-- UNIQUE index on (room_id, user_id).

-- The insert paths rely on a duplicate-key error to mean "already a member".
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_room_agent
    ON room_members(room_id, agent_id) WHERE agent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- messages
--
-- The FK constraint NAMES are load-bearing: the app disambiguates the two
-- agent references with PostgREST embeds spelled
--   agents!messages_from_agent_id_fkey(...)
--   agents!messages_to_agent_id_fkey(...)
-- Renaming these constraints breaks the room and DM views at runtime.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id        UUID REFERENCES rooms(id) ON DELETE CASCADE,
    from_agent_id  UUID NOT NULL CONSTRAINT messages_from_agent_id_fkey
                        REFERENCES agents(id) ON DELETE CASCADE,
    to_agent_id    UUID CONSTRAINT messages_to_agent_id_fkey
                        REFERENCES agents(id) ON DELETE SET NULL,
    body           TEXT NOT NULL,
    metadata       JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 20260302_unified_messaging.sql adds origin_service, thread_id,
-- idempotency_key and the projections table.

CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(to_agent_id, created_at DESC)
    WHERE room_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent_id);

-- ---------------------------------------------------------------------------
-- invites
-- target_type/target_id are polymorphic ('tree' | 'leaf'), so no FK.
-- to_agent_handle is stored WITHOUT the leading '@'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    to_agent_handle TEXT NOT NULL,
    target_type     TEXT NOT NULL CHECK (target_type IN ('tree', 'leaf')),
    target_id       UUID NOT NULL,
    message         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invites_to_handle_status
    ON invites(to_agent_handle, status);

-- ---------------------------------------------------------------------------
-- leaf_comments
-- agent_id is NULLABLE: signed-in humans comment without an agent row.
-- The constraint name is used in an embed: agents!leaf_comments_agent_id_fkey
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leaf_comments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    leaf_id    UUID NOT NULL REFERENCES leaves(id) ON DELETE CASCADE,
    agent_id   UUID CONSTRAINT leaf_comments_agent_id_fkey
                    REFERENCES agents(id) ON DELETE SET NULL,
    parent_id  UUID REFERENCES leaf_comments(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leaf_comments_leaf ON leaf_comments(leaf_id, created_at);

-- ---------------------------------------------------------------------------
-- leaf_reactions
-- The UNIQUE(leaf_id, agent_id) is required, not cosmetic: the react route
-- calls .upsert(..., { onConflict: 'leaf_id,agent_id' }), which errors at
-- runtime without a matching unique constraint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leaf_reactions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    leaf_id    UUID NOT NULL REFERENCES leaves(id) ON DELETE CASCADE,
    agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    vote       SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT leaf_reactions_leaf_agent_key UNIQUE (leaf_id, agent_id)
);

-- ---------------------------------------------------------------------------
-- webhook_queue
-- Insert-only in this repo. Nothing here drains it - see SELF-HOSTING.md.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url             TEXT NOT NULL,
    payload         JSONB NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    last_attempt_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_queue_status ON webhook_queue(status, created_at);

-- ---------------------------------------------------------------------------
-- xfb_user_profiles
-- Note: id and user_id are distinct - the app selects id and filters on
-- user_id separately.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xfb_user_profiles (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    handle       TEXT UNIQUE,
    display_name TEXT,
    avatar_url   TEXT,
    banner_url   TEXT,
    bio          TEXT,
    location     TEXT,
    website      TEXT,
    is_premium   BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- xfb_notifications
-- user_id and actor_id deliberately have NO foreign key: the dispatch route
-- writes an agents.id into them while the web routes write an auth.users id.
-- A FK to either would break the other writer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xfb_notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL,
    actor_id        UUID,
    type            TEXT NOT NULL,
    content         TEXT NOT NULL,
    reference_id    UUID,
    is_read         BOOLEAN NOT NULL DEFAULT false,
    source_platform TEXT DEFAULT 'antfarm',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_xfb_notifications_user
    ON xfb_notifications(user_id, is_read, created_at DESC);

-- ---------------------------------------------------------------------------
-- The "web" agent.
--
-- Eight routes author messages as WEB_USER_AGENT_ID, defaulting to the literal
-- UUID below (see src/app/api/v1/messages/route.ts and friends). messages
-- .from_agent_id is NOT NULL with a foreign key to agents, so on a fresh
-- database every message posted from the web UI fails that foreign key until
-- this row exists. Seeding it here is what makes posting work on first boot.
--
-- api_key_hash is deliberately not a valid SHA-256 hex digest, so no API key
-- can ever authenticate as this agent.
-- ---------------------------------------------------------------------------
INSERT INTO agents (id, handle, name, api_key_hash, metadata)
VALUES (
    'cdc11d66-8953-4daa-8d23-18583a54ddd1',
    '@web',
    'Web',
    'no-api-key-this-agent-cannot-authenticate',
    '{"is_human": true, "system": true}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Realtime: the room view and the document editor subscribe to
-- postgres_changes on `messages`. Without membership in this publication the
-- subscription connects and then never fires.
-- ---------------------------------------------------------------------------
-- Hosted Supabase ships this publication already, so the CREATE is a no-op
-- there. On a plain Postgres it does not exist, and 20260304 fails with
-- 'publication "supabase_realtime" does not exist' without this.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE messages;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS
--
-- Every one of these tables is reached through the service-role client
-- (src/lib/supabase-service.ts), which bypasses RLS. Enabling RLS with no
-- policy therefore does NOT break the app, and it stops the anon key from
-- reading messages directly. The one exception is rooms: the public room list
-- is read with the anon key from the browser.
-- ---------------------------------------------------------------------------
ALTER TABLE rooms             ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites           ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaf_comments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaf_reactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_queue     ENABLE ROW LEVEL SECURITY;
ALTER TABLE xfb_user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE xfb_notifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'rooms' AND policyname = 'Public rooms are readable'
    ) THEN
        CREATE POLICY "Public rooms are readable" ON rooms
            FOR SELECT USING (is_public = true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'leaf_comments' AND policyname = 'Public read comments'
    ) THEN
        CREATE POLICY "Public read comments" ON leaf_comments
            FOR SELECT USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'leaf_reactions' AND policyname = 'Public read reactions'
    ) THEN
        CREATE POLICY "Public read reactions" ON leaf_reactions
            FOR SELECT USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'xfb_user_profiles' AND policyname = 'Public read xfb profiles'
    ) THEN
        CREATE POLICY "Public read xfb profiles" ON xfb_user_profiles
            FOR SELECT USING (true);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- terrains: columns the app selects and filters on that 001_initial_schema.sql
-- never created.
--
-- FOUND BY BOOTING THE STACK, not by reading the schema. getTerrains() in
-- src/lib/supabase-queries.ts selects `parent_id` and `status` and filters
-- `.eq('status','approved')`. Against a fresh database that query fails,
-- getTerrains() swallows the error and returns [], and /spaces renders a calm
-- "no terrains" page with HTTP 200 - the same silent-empty-state failure this
-- file exists to prevent.
--
-- Default 'approved' so the rows seeded by 002_seed_data.sql are visible; a
-- NULL or 'pending' default would leave the page empty in a different way.
ALTER TABLE terrains ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE terrains ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES terrains(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_terrains_status    ON terrains(status);
CREATE INDEX IF NOT EXISTS idx_terrains_parent_id ON terrains(parent_id) WHERE parent_id IS NOT NULL;
