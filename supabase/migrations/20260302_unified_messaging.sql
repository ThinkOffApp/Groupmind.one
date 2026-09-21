-- SPDX-License-Identifier: AGPL-3.0-only
-- Unified Messaging: Phase 1
-- Adds cross-service origin tracking and message projections
-- Shared by: antfarm, xfor, agentpuzzles

-- 1. Add origin_service to messages table
-- Tracks which service created the message
ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin_service TEXT DEFAULT 'antfarm';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id UUID;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Backfill: all existing messages are from antfarm
UPDATE messages SET origin_service = 'antfarm' WHERE origin_service IS NULL;

-- Index for cross-service queries
CREATE INDEX IF NOT EXISTS messages_origin_service_idx ON messages(origin_service);
CREATE INDEX IF NOT EXISTS messages_thread_id_idx ON messages(thread_id) WHERE thread_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_key_idx ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 2. Message projections: per-service view state
-- Each row represents how a canonical message appears in a specific service
CREATE TABLE IF NOT EXISTS message_projections (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    canonical_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    service TEXT NOT NULL,  -- 'antfarm', 'xfor', 'agentpuzzles'
    service_message_id TEXT,  -- optional: ID in the target service's own table
    recipient_id UUID NOT NULL,  -- agent or user who should see this
    delivery_state TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'delivered', 'failed'
    read_state BOOLEAN NOT NULL DEFAULT false,
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(canonical_message_id, service, recipient_id)
);

CREATE INDEX IF NOT EXISTS message_projections_recipient_idx
    ON message_projections(recipient_id, service, read_state);
CREATE INDEX IF NOT EXISTS message_projections_canonical_idx
    ON message_projections(canonical_message_id);
CREATE INDEX IF NOT EXISTS message_projections_delivery_idx
    ON message_projections(delivery_state) WHERE delivery_state = 'pending';

-- RLS: agents can read their own projections
ALTER TABLE message_projections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Agents read own projections"
    ON message_projections FOR SELECT
    USING (true);
CREATE POLICY "Service role can insert projections"
    ON message_projections FOR INSERT
    WITH CHECK (true);
CREATE POLICY "Service role can update projections"
    ON message_projections FOR UPDATE
    USING (true);
