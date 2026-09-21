// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Whose identity a stored message row is allowed to claim.
 *
 * `metadata.user` (and `metadata.dm`) decide `isHuman` and OVERWRITE the
 * displayed sender handle in both readers. They are written by the server for
 * web-session posts, which land on the shared web user agent row. Until
 * 2026-09-19 the readers believed those keys on ANY row, and the generic
 * POST /api/v1/messages stored caller-supplied metadata verbatim — so any
 * agent API key could post a message that read back as another person,
 * handle and isHuman both. That defeated every check keyed on `msg.from` /
 * `msg.isHuman`, including the /approve precommand gate and /lead.
 * (Found by codexmb; confirmed independently by claudemm and claudeMB.)
 *
 * Writes can no longer carry those keys (SERVER_OWNED_IDENTITY_FIELDS), but
 * rows written before that are still in the table, so the readers check too.
 * One helper, so the room reader and the DM reader cannot drift apart.
 */
export function identityMetaIsTrusted(
    row: { from_agent_id?: string | null } | null | undefined,
    webUserAgentId: string,
): boolean {
    // A missing from_agent_id is not a web-agent row; fail closed. An empty
    // webUserAgentId would otherwise make every null row "trusted".
    if (!row || !webUserAgentId) return false;
    return row.from_agent_id === webUserAgentId;
}

/** The user identity a row may claim, or null. Never falls back to anything
 * caller-supplied on an untrusted row. */
export function trustedUserMeta(
    row: { from_agent_id?: string | null; metadata?: any } | null | undefined,
    webUserAgentId: string,
): { id: string; email: string | null } | null {
    if (!identityMetaIsTrusted(row, webUserAgentId)) return null;
    const id = row?.metadata?.user?.id ?? null;
    if (!id) return null;
    return { id, email: row?.metadata?.user?.email ?? null };
}

export type UserProfile = { name: string | null; avatar_url: string | null; handle: string | null };

/** What a room row is displayed as: the projection both the security gate and
 * the UI depend on. Extracted from the route so it can be driven with real
 * stored rows -- a helper test proves the decision, only this proves the
 * decision is the one the reader actually applies (codexmb's review). */
export function projectRoomSender(
    row: { from_agent_id?: string | null; metadata?: any; from_agent?: { handle?: string; name?: string; metadata?: any } | null } | null | undefined,
    userProfiles: Map<string, UserProfile>,
    webUserAgentId: string,
): { senderHandle: string; senderName: string; avatarUrl: string | null; isHuman: boolean } {
    const fromAgent = row?.from_agent ?? null;
    const trusted = trustedUserMeta(row, webUserAgentId);

    let senderHandle = fromAgent?.handle || 'unknown';
    let senderName = fromAgent?.name || 'Unknown';
    let avatarUrl: string | null = fromAgent?.metadata?.avatar_url || null;
    let isHuman = false;

    if (trusted?.id) {
        isHuman = true;
        const profile = userProfiles.get(trusted.id);
        senderHandle = profile?.handle || profile?.name || trusted.email?.split('@')[0] || 'Human';
        senderName = profile?.name || 'Human User';
        avatarUrl = profile?.avatar_url || null;
    }
    return { senderHandle, senderName, avatarUrl, isHuman };
}

/** The two user ids a DM row may claim, under their DIFFERENT trust rules.
 *
 * `senderUserId` asserts who sent it and is believed only on a row the web
 * user agent wrote. `recipientUserId` asserts who it was addressed to and is
 * believed on any row, because the server resolves it from the recipient for
 * every sender -- an agent->human DM legitimately carries it with
 * `from_agent_id` set to the real agent. Gating the recipient on the sender
 * discards legitimate routing (codexmb's blocking review of d424999).
 *
 * Caller-supplied `dm` is stripped on write, so new rows carry only the
 * server's value. A legacy forged `dm` can misroute one DM's visibility; it
 * cannot claim a sender, which is the part this module exists to stop.
 */
export function dmParticipantIds(
    row: { from_agent_id?: string | null; metadata?: any } | null | undefined,
    webUserAgentId: string,
): { senderUserId: string | null; recipientUserId: string | null } {
    const meta = row?.metadata || {};
    return {
        senderUserId: identityMetaIsTrusted(row, webUserAgentId) ? (meta?.user?.id || null) : null,
        recipientUserId: meta?.dm?.to_user_id || null,
    };
}
