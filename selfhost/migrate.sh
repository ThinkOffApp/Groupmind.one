#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Applies the repo's SQL migrations to the local Postgres, once each.
#
# Order matters and is NOT plain alphabetical across the two directories:
#   1. migrations/          - legacy dir, creates user_profiles
#   2. supabase/migrations/ - main chain, in filename order
#
# Idempotent: every applied file is recorded in schema_migrations_selfhost and
# skipped on the next boot. Any failure aborts with a non-zero exit so the
# `app` service never starts against a half-built schema.

set -eu

echo "[migrate] waiting for postgres at ${PGHOST}:${PGPORT} ..."
i=0
until psql -v ON_ERROR_STOP=1 -q -c 'SELECT 1' >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
        echo "[migrate] FATAL: postgres not reachable after 60 attempts" >&2
        exit 1
    fi
    sleep 2
done
echo "[migrate] postgres is up"

psql -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations_selfhost (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

# Who installed this instance, published to the database so the seed can author
# its demo content as the operator's own agent.
#
# ALTER DATABASE rather than SET: every migration file is applied in a separate
# psql process, so a session-level SET would not survive to 002. Read back with
# current_setting('groupmind.owner_name', true), which returns NULL rather than
# erroring when the setting was never made - so the migrations still apply on a
# plain Postgres where nobody ran this script.
#
# Single-quotes are doubled because these are operator-supplied strings.
OWNER_NAME="${GROUPMIND_OWNER_NAME:-Owner}"
AGENT_HANDLES="${GROUPMIND_AGENT_HANDLES:-agent-1}"
esc() { printf '%s' "$1" | sed "s/'/''/g"; }
psql -v ON_ERROR_STOP=1 -q -c \
    "ALTER DATABASE \"$PGDATABASE\" SET groupmind.owner_name = '$(esc "$OWNER_NAME")'"
psql -v ON_ERROR_STOP=1 -q -c \
    "ALTER DATABASE \"$PGDATABASE\" SET groupmind.agent_handles = '$(esc "$AGENT_HANDLES")'"
echo "[migrate] instance owner: $OWNER_NAME; agent handles: $AGENT_HANDLES"

apply_dir() {
    dir="$1"
    [ -d "$dir" ] || return 0
    for f in "$dir"/*.sql; do
        [ -e "$f" ] || continue
        name="$(basename "$dir")/$(basename "$f")"

        already="$(psql -v ON_ERROR_STOP=1 -tAc \
            "SELECT 1 FROM schema_migrations_selfhost WHERE filename = '$name'")"
        if [ "$already" = "1" ]; then
            echo "[migrate] skip    $name (already applied)"
            continue
        fi

        echo "[migrate] apply   $name"
        # Single transaction per file: a failure leaves nothing half-applied.
        if ! psql -v ON_ERROR_STOP=1 -q --single-transaction -f "$f"; then
            echo "[migrate] FATAL: $name failed. Schema is incomplete; aborting." >&2
            exit 1
        fi
        psql -v ON_ERROR_STOP=1 -q -c \
            "INSERT INTO schema_migrations_selfhost(filename) VALUES ('$name')"
    done
}

apply_dir /migrations/legacy
apply_dir /migrations/supabase

# Fail loudly if the chain somehow left the chat core missing - this is the
# exact first-boot failure this stack exists to prevent.
missing="$(psql -v ON_ERROR_STOP=1 -tAc "
    SELECT string_agg(t, ', ')
    FROM unnest(ARRAY['rooms','room_members','messages','agents']) AS t
    WHERE to_regclass('public.' || t) IS NULL")"
if [ -n "$missing" ]; then
    echo "[migrate] FATAL: core tables missing after migration: $missing" >&2
    exit 1
fi

count="$(psql -v ON_ERROR_STOP=1 -tAc \
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
echo "[migrate] done. $count tables in public schema."
