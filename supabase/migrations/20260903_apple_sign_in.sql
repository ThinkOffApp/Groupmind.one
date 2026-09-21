-- Sign in with Apple on /api/v1/relay/auth (antfarm#125 / PR #126).
--
-- Two small tables give the exchange database-level atomicity, which
-- metadata check-then-update cannot (codexmb review of #126):
--
-- 1. apple_sign_in_nonces: every exchanged token's nonce (SHA-256 hex of the
--    client's raw nonce) is INSERTed with the token's expiry as the row's.
--    The primary key makes a replayed token fail with unique_violation, so
--    two concurrent exchanges of one token can never both mint a key.
--    Expired rows are pruned opportunistically by the route.
--
-- 2. apple_identities: Apple's stable `sub` -> auth user. The primary key
--    makes concurrent first sign-ins converge on one account: the second
--    INSERT fails and the route adopts the winner.
--
-- Both tables are read and written with the service role only; RLS is on
-- with no policies, so no anon or user key can touch them.
--
-- The route fails closed (503 "Sign in with Apple is not enabled") until
-- this has run. Apply: Supabase SQL Editor, paste and run. Idempotent.

CREATE TABLE IF NOT EXISTS apple_sign_in_nonces (
    nonce_hash  text        PRIMARY KEY,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apple_sign_in_nonces_expires_idx ON apple_sign_in_nonces (expires_at);
ALTER TABLE apple_sign_in_nonces ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS apple_identities (
    apple_sub   text        PRIMARY KEY,
    user_id     uuid        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apple_identities_user_idx ON apple_identities (user_id);
ALTER TABLE apple_identities ENABLE ROW LEVEL SECURITY;
