-- SPDX-License-Identifier: AGPL-3.0-only
-- Blind index for room message search.
--
-- Private-room bodies are stored encrypted (lib/crypto, AES-256-GCM, `ENC:v1:`),
-- so there is no plaintext column to index and search had to decrypt-and-scan:
-- measured 27 s for a rare term, 20 000 rows examined, because reaching that
-- depth costs dozens of sequential round trips.
--
-- This table stores a KEYED HASH of each distinct word, never the word. A
-- database dump therefore still reveals no message text — the same property the
-- encryption gives today — while an exact-word lookup becomes a single indexed
-- query. The hashing key is derived from ROOM_ENCRYPTION_KEY, so no new secret
-- has to be created or distributed.
--
-- Known limits, stated so nobody assumes otherwise:
--   * whole words only. Substring and prefix search are NOT covered; the search
--     route falls back to the old scan for those.
--   * a dump still leaks word-frequency structure (which hashes are common),
--     though not the words themselves.

create table if not exists message_search_tokens (
    message_id  uuid        not null references messages(id) on delete cascade,
    room_id     uuid        not null,
    token_hash  bytea       not null,
    created_at  timestamptz not null,
    primary key (message_id, token_hash)
);

-- The lookup search actually performs: this room, this word, newest first.
create index if not exists message_search_tokens_lookup
    on message_search_tokens (room_id, token_hash, created_at desc);

-- Backfill progress and delete-cascade both walk by message.
create index if not exists message_search_tokens_message
    on message_search_tokens (message_id);
