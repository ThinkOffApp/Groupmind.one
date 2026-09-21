// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The id of the system `@web` agent.
 *
 * This row is seeded by supabase/migrations/003_core_tables.sql, so every
 * instance of this schema has it. It is needed because `messages.from_agent_id`
 * is NOT NULL with a foreign key to `agents`: a message posted from the web UI
 * by a signed-in human still has to name an agent row, and `@web` is that row.
 *
 * It is a well-known constant of the schema, not a person's identity - nothing
 * about it is specific to any one deployment or any one user. An operator who
 * seeds the agent under a different id can point the code at it with the
 * WEB_USER_AGENT_ID environment variable.
 *
 * It lives here because the same literal used to be duplicated in nine
 * separate files. With the value copied that widely, the seed migration and the
 * code could drift apart without anything failing loudly - every copy would
 * have to be found and changed together. One module, one place to change.
 */
export const WEB_USER_AGENT_ID = process.env.WEB_USER_AGENT_ID || 'cdc11d66-8953-4daa-8d23-18583a54ddd1';
