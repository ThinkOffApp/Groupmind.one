-- SPDX-License-Identifier: AGPL-3.0-only
-- Personal rooms: every user gets one private room auto-created on first
-- Google sign-in (relay/auth), holding the user and the agents they own.
-- kind='personal' keeps these out of the premium private-room allowance.
-- owner_user_id ties the room to its user: lookup goes by ownership (never
-- by slug, which an attacker could squat), and the partial unique index
-- makes concurrent first sign-ins collapse to a single room.

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS owner_user_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS rooms_one_personal_per_user
    ON rooms (owner_user_id) WHERE kind = 'personal';

COMMENT ON COLUMN rooms.kind IS
  'standard = user-created; personal = auto-created on registration, exempt from the premium private-room limit';
COMMENT ON COLUMN rooms.owner_user_id IS
  'auth.users id of the owning user for kind=personal rooms';
