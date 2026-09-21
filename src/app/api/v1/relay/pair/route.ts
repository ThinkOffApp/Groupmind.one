import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

// Authenticated web user.
// 1) SSR cookie session (desktop web). 2) Authorization: Bearer <access_token>
// from the client session. Ported from the rooms/[room]/join route, which hit
// this first: some mobile browsers (notably Android Chrome, which is what an
// Onyx BOOX runs) don't reliably round-trip the ~5KB chunked SSR auth cookie,
// so cookie-only auth 401s. The bearer token is validated with the service
// client and is cookie-independent. A Supabase user JWT is never an xfb_ agent
// key, so those are skipped rather than mistaken for one.
async function getSessionUser(request?: Request) {
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (!error && user) return user;
    } catch {
        // fall through to bearer-token auth
    }
    try {
        const authz = request?.headers.get('authorization') || '';
        const token = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, '').trim() : '';
        if (token && !token.startsWith('xfb_')) {
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (!error && user) return user;
        }
    } catch {
        // ignore
    }
    return null;
}

/**
 * Owner of a signed-in DEVICE, resolved from its agent API key.
 *
 * A user reported: "Codewatch app does not show pairing code". It could
 * not: this route accepted only a web session, so the phone - which holds an
 * xfb_ agent key, never a Supabase session - got 401 every time and the app
 * showed nothing. A device that is already signed in is exactly who should
 * be able to invite the next device, so an agent key now authenticates the
 * mint, and the code still binds to the OWNER's relay identity (never to the
 * calling agent), which is what antfarm#80 established.
 */
async function getOwnerFromDeviceKey(request: Request): Promise<{ id: string } | null> {
    const apiKey = extractApiKey(request);
    if (!apiKey) return null;
    const agent = await getAgentByApiKey(apiKey, 'id, owner_id');
    const ownerId = (agent as { owner_id?: string } | null)?.owner_id;
    return ownerId ? { id: ownerId } : null;
}

// Unambiguous alphabet (no 0/O/1/I) for a short, human-safe pairing code.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode(len = 8): string {
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
}
function sha256(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * POST /api/v1/relay/pair
 * Mint a SHORT-LIVED, one-time pairing code for the signed-in web user's relay
 * agent. The QR encodes only this code, never the raw api key. A second device
 * redeems it at /api/v1/relay/pair/redeem to receive a freshly-minted scoped key.
 * Code hash + expiry are stored on the agent's metadata (no migration needed).
 */
export async function POST(request: Request) {
    // Web session (groupmind.one) OR a signed-in device's agent key (the
    // CodeWatch app). Either proves the same thing: this human is signed in
    // and may invite another of their devices.
    const user = (await getSessionUser(request)) ?? (await getOwnerFromDeviceKey(request));
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Which agent may a pairing code bind to? THE RELAY AGENT ONLY - the one
    // relay-auth creates to represent the user (metadata.created_via ===
    // 'relay-auth'), the same deterministic pick the Google sign-in path
    // makes. The previous fallback took the user's OLDEST owned agent, and on
    // Aug 5 2026 that paired a user's tablet as @claudeMB, their oldest agent:
    // they spent ten minutes posting to the room AS their own coding agent, and a
    // key for that agent's identity landed on a tablet. A user's owned agents
    // are their WORKERS, not their identities; if no relay agent exists yet,
    // refuse with instructions rather than grabbing whichever agent is
    // handy. (maybeSingle() stays avoided: several relay-auth agents would
    // error; ordered limit(1) keeps the pick stable - see antfarm#77.)
    const { data: ownedAgents, error: lookupError } = await supabase
        .from('agents')
        .select('id, handle, metadata, created_at')
        .eq('owner_id', user.id)
        .order('created_at', { ascending: true });

    if (lookupError) {
        console.error('pair agent lookup error:', lookupError);
        return NextResponse.json({ error: 'Failed to look up relay agent' }, { status: 500 });
    }

    const agent = (ownedAgents || []).find(
        (a) => (a.metadata as { created_via?: string } | null)?.created_via === 'relay-auth'
    );
    if (!agent) {
        return NextResponse.json(
            {
                error: 'No relay identity for this account yet. Sign in to CodeWatch ' +
                    'on your phone once (Google sign-in) to create it, then pair.',
            },
            { status: 404 }
        );
    }

    const code = genCode(8);
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    const metadata = {
        ...((agent.metadata as Record<string, unknown>) || {}),
        pairing_code_hash: sha256(code),
        pairing_expires_at: expiresAt,
    };

    const { error } = await supabase.from('agents').update({ metadata }).eq('id', agent.id);
    if (error) {
        console.error('pair mint error:', error);
        return NextResponse.json({ error: 'Failed to create pairing code' }, { status: 500 });
    }

    return NextResponse.json({ code, expires_at: expiresAt, ttl_seconds: TTL_MS / 1000 });
}
