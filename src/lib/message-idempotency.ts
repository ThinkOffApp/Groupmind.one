// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Client-supplied message ids -> server-side idempotency (CodeWatch #157).
 *
 * A user reported the same dictated message posted twice ~300 ms apart
 * on a flaky network. The client keeps a stable id per queued message but
 * the server had nothing to key on. Now a POST may carry
 * `client_message_id`; the server derives a per-sender key, stores both on
 * the row's metadata (`client_message_id` for clients to match their echo,
 * `client_message_key` for the server to dedupe on) and returns the
 * existing message when the same sender repeats the same id.
 *
 * Storage is metadata rather than a column so the change works the moment
 * it deploys (production has no idempotency column: the 20260302 unified
 * messaging migration was never applied, checked 3 Sep 2026). The lookup
 * before insert catches retries; the unique expression index in
 * 20260903_client_message_key.sql makes the concurrent case safe too, at
 * which point the insert's unique violation is handled the same way.
 * Pure helpers here; the routes do the I/O.
 */

export const CLIENT_MESSAGE_ID_MAX = 128;

/** Validate the optional `client_message_id` field. Returns the trimmed id,
 * `null` when absent, or an error string for a malformed value. */
export function parseClientMessageId(value: unknown): { id: string | null; error?: string } {
    if (value === undefined || value === null || value === '') return { id: null };
    if (typeof value !== 'string') return { id: null, error: 'client_message_id must be a string' };
    const id = value.trim();
    if (!id) return { id: null };
    if (id.length > CLIENT_MESSAGE_ID_MAX) {
        return { id: null, error: `client_message_id longer than ${CLIENT_MESSAGE_ID_MAX} characters` };
    }
    if (/[\x00-\x1f\x7f]/.test(id)) return { id: null, error: 'client_message_id contains control characters' };
    return { id };
}

/** The stored key: scoped to the sender so two clients that both count from
 * 1 never collide. `senderId` is the agent id, or the user id for a human
 * posting through the shared web_user agent. */
export function clientMessageKeyFor(senderId: string, clientMessageId: string): string {
    return `cmid:${senderId}:${clientMessageId}`;
}

/** Metadata fields to merge onto a message that carries a client id. */
export function clientMessageMetadata(senderId: string, clientMessageId: string): {
    client_message_id: string; client_message_key: string;
} {
    return {
        client_message_id: clientMessageId,
        client_message_key: clientMessageKeyFor(senderId, clientMessageId),
    };
}

/** Postgres unique_violation, as surfaced by supabase-js. */
export function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
    return error?.code === '23505';
}

export const RESERVED_CLIENT_FIELDS = ['client_message_id', 'client_message_key'] as const;

/** Metadata keys that carry SENDER IDENTITY and are therefore set by the
 * server alone. `metadata.user` is what the room and DM readers use to decide
 * `isHuman` and to overwrite the displayed handle, so a caller that can set it
 * can post under any identity, including the owner's — which defeats every
 * check keyed on `msg.from` / `msg.isHuman` (the /approve precommand gate and
 * /lead both were). `dm` is likewise derived from the resolved recipient.
 * Stripped on every write; the authenticated values are re-added afterwards
 * from the session, never from the body. Found by codexmb, 2026-09-19. */
export const SERVER_OWNED_IDENTITY_FIELDS = ['user', 'dm'] as const;

/** Caller-supplied metadata must never carry the reserved fields: a forged
 * client_message_key would let one sender hijack another's dedupe (Codex
 * review of antfarm#123). The server sets both fields itself, after this. */
export function stripReservedClientFields<T extends Record<string, unknown>>(metadata: T | null | undefined): Record<string, unknown> {
    if (!metadata || typeof metadata !== 'object') return {};
    const out: Record<string, unknown> = { ...metadata };
    for (const f of RESERVED_CLIENT_FIELDS) delete out[f];
    for (const f of SERVER_OWNED_IDENTITY_FIELDS) delete out[f];
    return out;
}

/** The message already stored for this key BY THIS SENDER, or null. The
 * from_agent_id filter means a key can only ever match the authenticated
 * sender's own rows, whatever the metadata says. Takes the client as a
 * parameter so the routes share one query and tests can pass a stub. */
export async function findMessageByClientKey<T>(
    db: { from: (table: string) => any },
    key: string,
    fromAgentId: string,
    columns: string,
): Promise<T | null> {
    const { data } = await db
        .from('messages')
        .select(columns)
        .eq('from_agent_id', fromAgentId)
        .eq('metadata->>client_message_key', key)
        .limit(1);
    return (data && data[0]) ? (data[0] as T) : null;
}
