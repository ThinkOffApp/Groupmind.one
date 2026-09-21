import crypto from 'crypto';
import { agentHasScope, type AuthenticatedAgent } from './auth';
import { getServiceSupabase } from './supabase-service';

/**
 * Per-user proxy identity resolution for OpenAI Custom GPT Actions.
 *
 * Problem: a public Custom GPT shares a single scoped integration key
 * (e.g. `@chatgpt`'s `messages:write:thinkoff-development`). Every end-user
 * of that GPT therefore posts under the same handle, which is bad for
 * attribution and product UX.
 *
 * Solution (option A, per ether's spec):
 *  - The scoped key carries a `proxy:openai` scope.
 *  - When such a key is used AND the request includes the trusted OpenAI
 *    header `openai-ephemeral-user-id` (set by OpenAI's infrastructure
 *    when a Custom GPT Action calls our endpoint), we derive a stable
 *    pseudonymous handle: `@chatgpt-<8-hex>`.
 *  - We auto-provision an `agents` row on first sighting and reuse it on
 *    subsequent posts. The proxy agent inherits ownership from the parent
 *    integration agent and stores its provenance in `metadata.proxy`.
 *  - The message is recorded with the proxy agent as the sender; scope
 *    enforcement still runs against the parent key.
 *
 * Trust model:
 *  - The `openai-ephemeral-user-id` header is set by OpenAI's servers, not
 *    by the GPT itself. It is stable per OpenAI user across conversations.
 *  - We only honour it when the authenticating key carries `proxy:openai`,
 *    so a bystander with the parent agent's primary key cannot spoof
 *    per-user identity (and a non-OpenAI client wouldn't naturally send
 *    that header).
 *  - We hash the user id with a server-side secret
 *    (`OPENAI_PROXY_HANDLE_SECRET`) before truncating, so handles cannot
 *    be precomputed by an external party who learns a target's
 *    openai-ephemeral-user-id.
 *
 * The proxy agent's `api_key_hash` is a random unique placeholder that
 * is never returned to a caller: there is no scenario where someone
 * authenticates AS the proxy. All writes happen through the parent key.
 */

const OPENAI_USER_ID_HEADER = 'openai-ephemeral-user-id';
const PROXY_SCOPE = 'proxy:openai';

// One-shot cold-start warning when OPENAI_PROXY_HANDLE_SECRET is missing.
// We don't want this to spam every request, just once per function instance.
let warnedMissingSecret = false;

function deriveProxyHandle(parentHandle: string, oaiUserId: string): {
    handle: string;
    userIdHash: string;
} | null {
    // Fail-closed: refuse to derive handles when the server secret is
    // missing. Without the secret, an attacker who learned a target's
    // openai-ephemeral-user-id could pre-compute their derived handle
    // from the publicly-known parent handle, defeating the
    // pseudonymity guarantee. The caller falls back to posting as
    // the parent agent in this case.
    const secret = process.env.OPENAI_PROXY_HANDLE_SECRET;
    if (!secret || secret.length === 0) return null;

    const userIdHash = crypto
        .createHash('sha256')
        .update(`${secret}|${parentHandle}|${oaiUserId}`)
        .digest('hex');
    const short = userIdHash.slice(0, 8);
    const cleanParent = parentHandle.replace(/^@/, '');
    return {
        handle: `@${cleanParent}-${short}`,
        userIdHash,
    };
}

function randomPlaceholderKeyHash(): string {
    // Generate a unique unguessable placeholder for agents.api_key_hash.
    // The proxy agent is never authenticated against; this is purely to
    // satisfy the NOT NULL + UNIQUE constraint on api_key_hash.
    return crypto.createHash('sha256').update(crypto.randomBytes(64)).digest('hex');
}

/**
 * Resolve the effective sender identity for a request.
 *
 * @param request   The incoming Request (used to read the OpenAI header).
 * @param parent    The agent that authenticated this request.
 * @param body      The parsed JSON body. We look for `chatgpt_display_name`
 *                  to set the proxy agent's name on first creation.
 * @returns         The proxy agent if one was applied; otherwise `null`,
 *                  meaning the caller should keep using `parent` as the
 *                  sender.
 */
export async function resolveOpenaiProxyAgent(
    request: Request,
    parent: AuthenticatedAgent,
    body: { chatgpt_display_name?: unknown } = {}
): Promise<AuthenticatedAgent | null> {
    // Only kick in if the key explicitly carries the proxy scope.
    if (!agentHasScope(parent, PROXY_SCOPE)) return null;

    const oaiUserId = request.headers.get(OPENAI_USER_ID_HEADER)?.trim();
    if (!oaiUserId) return null;

    const derived = deriveProxyHandle(parent.handle, oaiUserId);
    if (!derived) {
        // Secret missing in env: fail-closed. Caller posts as parent.
        // We log once-per-cold-start so misconfiguration is visible in logs.
        if (!warnedMissingSecret) {
            console.warn(
                'proxy-identity: OPENAI_PROXY_HANDLE_SECRET is not set; ' +
                'proxy:openai requests will fall back to parent identity'
            );
            warnedMissingSecret = true;
        }
        return null;
    }
    const { handle: proxyHandle, userIdHash } = derived;
    const supabase = getServiceSupabase();

    // Fast path: existing proxy agent.
    const { data: existing } = await supabase
        .from('agents')
        .select('id, handle, name, owner_id, metadata')
        .eq('handle', proxyHandle)
        .maybeSingle();

    if (existing) {
        return existing as unknown as AuthenticatedAgent;
    }

    // First sighting: provision a new agent. Use upsert-via-insert with
    // on-conflict so a race between two simultaneous first-posts converges.
    const displayName =
        typeof body.chatgpt_display_name === 'string' && body.chatgpt_display_name.trim().length > 0
            ? body.chatgpt_display_name.trim().slice(0, 80)
            : `ChatGPT user ${userIdHash.slice(0, 8)}`;

    const parentOwnerId = (parent as { owner_id?: string | null }).owner_id ?? null;

    const { data: inserted, error } = await supabase
        .from('agents')
        .insert({
            handle: proxyHandle,
            name: displayName,
            api_key_hash: randomPlaceholderKeyHash(),
            owner_id: parentOwnerId,
            metadata: {
                proxy: {
                    source: 'openai',
                    parent_agent_id: parent.id,
                    parent_handle: parent.handle,
                    user_id_hash: userIdHash,
                    provisioned_at: new Date().toISOString(),
                },
            },
        })
        .select('id, handle, name, owner_id, metadata')
        .single();

    if (error) {
        // Race: another concurrent first-post inserted the same handle.
        // Re-read and return.
        const { data: raced } = await supabase
            .from('agents')
            .select('id, handle, name, owner_id, metadata')
            .eq('handle', proxyHandle)
            .maybeSingle();
        if (raced) return raced as unknown as AuthenticatedAgent;
        console.error('proxy-identity: failed to provision and no race row found', error);
        return null;
    }

    return inserted as unknown as AuthenticatedAgent;
}
