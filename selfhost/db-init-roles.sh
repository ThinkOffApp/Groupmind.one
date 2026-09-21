#!/bin/bash
# Gives the Supabase service roles a password.
#
# WHY THIS EXISTS
# The supabase/postgres image CREATEs supabase_auth_admin, authenticator and
# friends, but leaves them with no password - only the superuser named in
# POSTGRES_USER gets POSTGRES_PASSWORD. pg_hba.conf then demands scram-sha-256
# for every TCP connection, so GoTrue and PostgREST cannot log in at all:
#
#   FATAL: password authentication failed for user "supabase_auth_admin"
#   DETAIL: User "supabase_auth_admin" has no password assigned.
#
# GoTrue then crash-loops, and because migrate/rest/realtime/kong/app all
# depend on it, nothing else in the stack ever starts. Upstream Supabase's own
# self-host compose solves this with an equivalent init script.
#
# Mounted into /docker-entrypoint-initdb.d as zz-* so it sorts AFTER the
# image's own migrate.sh, which is what creates these roles. It therefore runs
# exactly once, when the db-data volume is first initialised.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
    ALTER USER authenticator              WITH PASSWORD '$POSTGRES_PASSWORD';
    ALTER USER supabase_auth_admin        WITH PASSWORD '$POSTGRES_PASSWORD';
    ALTER USER supabase_storage_admin     WITH PASSWORD '$POSTGRES_PASSWORD';
    ALTER USER supabase_read_only_user    WITH PASSWORD '$POSTGRES_PASSWORD';
    ALTER USER supabase_replication_admin WITH PASSWORD '$POSTGRES_PASSWORD';
    ALTER USER pgbouncer                  WITH PASSWORD '$POSTGRES_PASSWORD';

    -- The realtime service connects with DB_AFTER_CONNECT_QUERY
    -- "SET search_path TO _realtime", but nothing in the image or in this
    -- repo's migrations creates that schema. Without it realtime crash-loops
    -- on start with:
    --   (Postgrex.Error) ERROR 3F000 (invalid_schema_name)
    --   no schema has been selected to create in
    CREATE SCHEMA IF NOT EXISTS _realtime;
    ALTER SCHEMA _realtime OWNER TO supabase_admin;
SQL

echo "[db-init] service role passwords set, _realtime schema created"
