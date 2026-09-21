-- Client message idempotency (CodeWatch #157, antfarm PR #123).
--
-- A POST /api/v1/messages or /api/v1/rooms/{room}/messages may carry
-- client_message_id. The API stores metadata.client_message_key =
-- 'cmid:<sender id>:<client id>' and looks it up (filtered by the
-- authenticated sender's from_agent_id) before inserting, so a retried
-- request returns the existing message instead of a second row.
--
-- The lookup alone leaves a window for two truly concurrent deliveries of
-- the same message. This unique expression index closes it: the second
-- insert fails with unique_violation (23505) and the API answers with the
-- first row. It also turns the lookup into an index probe. No column is
-- added, so the API works before and after this runs; the concurrent
-- guarantee only holds once it has run.
--
-- Apply: Supabase SQL Editor, paste and run. Idempotent.
--
-- Preflight: CREATE UNIQUE INDEX aborts if duplicate keys already exist
-- (possible if the API ran before this index and a concurrent pair got
-- through). Keep the key on the earliest row of each group and drop it from
-- the later rows. The later rows themselves are kept: nothing is deleted,
-- they only stop claiming the key.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY metadata->>'client_message_key'
               ORDER BY created_at, id
           ) AS rn
    FROM messages
    WHERE metadata->>'client_message_key' IS NOT NULL
)
UPDATE messages m
SET metadata = m.metadata - 'client_message_key'
FROM ranked r
WHERE m.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS messages_client_message_key_idx
    ON messages ((metadata->>'client_message_key'))
    WHERE metadata->>'client_message_key' IS NOT NULL;
