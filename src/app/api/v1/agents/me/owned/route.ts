import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getServiceSupabase } from '@/lib/supabase-service';
import { hashApiKey } from '@/lib/auth';
import {
    AGENT_COLUMNS,
    listOwnedAgentsWithLiveness,
    resolveOwnerId,
    shapeAgent,
} from '@/lib/owned-agents';

const supabase = getServiceSupabase();

// DETECT kinds are auto-detected by the CodeWatch Mac helper and are
// MACHINE-scoped (one per machine, dedup on machine). NAMED kinds are user-named
// agents added from the app's "Add an agent" screen and are NAME-scoped (each
// name is its own identity, dedup on name — even if the client also sends
// machine metadata). The scoping is decided by the KIND FAMILY, never by whether
// machine metadata happens to be present, so two named agents on the same
// machine stay distinct.
const DETECT_KINDS = new Set(['claude_code', 'codex', 'gemini']);
const NAMED_KINDS = new Set(['openclaw', 'hermes', 'custom']);
const KNOWN_KINDS = new Set([...DETECT_KINDS, ...NAMED_KINDS]);

// GET /api/v1/agents/me/owned
//
// List every agent owned by the authenticated user. Powers the CodeWatch
// "Your agents" surface: a signed-in user sees THEIR own agents (the ones a
// Mac helper / desktop setup registered to their account), not the global
// directory. Listing + liveness decoration live in @/lib/owned-agents,
// shared with /agents/me/control-status.
export async function GET(request: Request) {
    const ownerId = await resolveOwnerId(request);

    if (!ownerId) {
        return NextResponse.json(
            { error: 'Unauthenticated. Provide X-API-Key / Authorization: Bearer, or a web session.' },
            { status: 401 }
        );
    }

    const result = await listOwnedAgentsWithLiveness(ownerId);
    if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json({ agents: result.agents, total: result.agents.length });
}

// Sanitize a candidate handle into @lowercase-with-dashes, length-trimmed.
function sanitizeHandle(raw: string): string {
    const slug = raw
        .toLowerCase()
        .replace(/^@/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40)
        .replace(/-$/, '');
    return `@${slug || 'agent'}`;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

// POST /api/v1/agents/me/owned
//
// Register (or upsert) ONE agent as owned by the authenticated user. Two flows:
//
//   (a) Mac-helper detect flow (claude_code / codex / gemini): machine-scoped,
//       the helper passes machine_name (+ host_fingerprint). Original behaviour.
//   (b) Named-agent flow (openclaw / hermes / custom, or any kind with a name):
//       user-scoped, added from the app's "Add an agent" screen. No machine
//       required — the agent's own name is the identity. This is what gives each
//       agent its OWN handle + scoped key instead of sharing the relay identity.
//
// Unlike the public /agents/register (UNowned + claim-token), this always sets
// owner_id = the signed-in user, so the agent shows in "Your agents" (GET above).
//
// Idempotent upsert. Conceptual key: owner_id + agent_kind +
// (host_fingerprint || machine_name || identity_name). Re-running with the same
// identity updates the same row instead of piling up duplicates. Done in
// application code (no DB-level unique constraint on those metadata fields).
//
// Body (field aliases accepted both ways):
//   kind | agent_kind          (required: claude_code|codex|gemini|openclaw|hermes|custom)
//   machine_name | host_name   (required for the detect flow; omit for named agents)
//   name | display_name        (required for named agents; optional for detect flow)
//   host_fingerprint           (optional, recommended for detect flow - stable per Mac)
//   handle                     (optional SUGGESTION only; server sanitizes + dedupes)
//   detected_cli               (optional, folded into metadata)
//   metadata                   (optional extra fields)
// Detect kinds (claude_code/codex/gemini) require machine_name; named kinds
// (openclaw/hermes/custom) require name.
//
// Returns { agent, created }. api_key is included ONLY when a new agent is
// created (minted once, never re-shown) - the caller persists it.
export async function POST(request: Request) {
    const ownerId = await resolveOwnerId(request);
    if (!ownerId) {
        return NextResponse.json(
            { error: 'Unauthenticated. Provide X-API-Key / Authorization: Bearer, or a web session.' },
            { status: 401 }
        );
    }

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const kind = str(body.kind ?? body.agent_kind).toLowerCase();
    const machineName = str(body.machine_name ?? body.host_name);
    const hostFingerprint = str(body.host_fingerprint);
    const providedHandle = str(body.handle);
    const detectedCli = str(body.detected_cli);
    const extraMeta = (body.metadata && typeof body.metadata === 'object')
        ? (body.metadata as Record<string, unknown>)
        : {};

    if (!kind) {
        return NextResponse.json({ error: 'Missing required field: kind (or agent_kind)' }, { status: 400 });
    }
    if (!KNOWN_KINDS.has(kind)) {
        return NextResponse.json(
            { error: `Unknown kind '${kind}'. Expected one of: ${[...KNOWN_KINDS].join(', ')}` },
            { status: 400 }
        );
    }

    const providedName = str(body.name ?? body.display_name);
    // Scoping is decided by the kind FAMILY, not by which fields the client sent.
    const isDetectKind = DETECT_KINDS.has(kind);
    if (isDetectKind && !machineName) {
        return NextResponse.json(
            { error: `machine_name (or host_name) is required for detect-flow kind '${kind}'` },
            { status: 400 }
        );
    }
    if (!isDetectKind && !providedName) {
        return NextResponse.json(
            { error: `name is required for named-agent kind '${kind}'` },
            { status: 400 }
        );
    }

    const name = providedName || `${kind} on ${machineName}`;
    // identity_name is the dedup key for NAMED kinds. Computed from the name (not
    // presence/absence of machine metadata), so a named agent that also carries a
    // machine still dedups on its name — two names on one machine stay distinct.
    const identityName = !isDetectKind ? sanitizeHandle(providedName).replace(/^@/, '') : '';

    // Durable identity lives in metadata (no dedicated columns for these).
    // For named kinds, machine metadata is stored (informational) but NOT used
    // as the dedup key.
    const identityMeta = {
        ...extraMeta,
        source: isDetectKind ? 'codewatch_helper' : 'codewatch_named',
        agent_kind: kind,
        ...(machineName ? { machine_name: machineName } : {}),
        ...(identityName ? { identity_name: identityName } : {}),
        ...(hostFingerprint ? { host_fingerprint: hostFingerprint } : {}),
        ...(detectedCli ? { detected_cli: detectedCli } : {}),
        status: 'active',
    };

    // --- Upsert lookup ---
    // Detect kinds: owner + agent_kind + (host_fingerprint || machine_name).
    // Named kinds:  owner + agent_kind + identity_name.
    let existingQuery = supabase
        .from('agents')
        .select(AGENT_COLUMNS)
        .eq('owner_id', ownerId)
        .eq('metadata->>agent_kind', kind);
    if (isDetectKind) {
        existingQuery = hostFingerprint
            ? existingQuery.eq('metadata->>host_fingerprint', hostFingerprint)
            : existingQuery.eq('metadata->>machine_name', machineName);
    } else {
        existingQuery = existingQuery.eq('metadata->>identity_name', identityName);
    }

    const { data: existing, error: lookupError } = await existingQuery.maybeSingle();
    if (lookupError && lookupError.code !== 'PGRST116') {
        console.error('owned-agent lookup error:', lookupError);
        return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
    }

    // --- Update path: agent already registered for this Mac+kind ---
    if (existing) {
        const mergedMeta = {
            ...((existing as { metadata?: Record<string, unknown> }).metadata ?? {}),
            ...identityMeta,
        };
        const { data: updated, error: updateError } = await supabase
            .from('agents')
            .update({ name, metadata: mergedMeta, user_visible: true })
            .eq('id', (existing as { id: string }).id)
            .select(AGENT_COLUMNS)
            .single();
        if (updateError) {
            console.error('owned-agent update error:', updateError);
            return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
        }
        return NextResponse.json({ agent: shapeAgent(updated), created: false });
    }

    // --- Create path: mint a key once, insert with a unique handle ---
    // Server generates the handle; client `handle` is only a suggestion.
    // Prefer explicit handle, then the agent's name (named flow), then
    // machine-kind (detect flow).
    const baseHandle = sanitizeHandle(providedHandle || providedName || `${machineName}-${kind}`);
    const apiKey = `antfarm_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = hashApiKey(apiKey);

    // Retry on handle collision (23505) by appending a short hash suffix.
    let lastError: { code?: string; message?: string } | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const handle = attempt === 0
            ? baseHandle
            : sanitizeHandle(`${baseHandle}-${crypto.randomBytes(2).toString('hex')}`);

        const { data: inserted, error: insertError } = await supabase
            .from('agents')
            .insert({
                id: crypto.randomUUID(),
                handle,
                name,
                api_key_hash: apiKeyHash,
                owner_id: ownerId,
                user_visible: true,
                credibility: 0.5,
                metadata: identityMeta,
            })
            .select(AGENT_COLUMNS)
            .single();

        if (!insertError && inserted) {
            return NextResponse.json(
                {
                    agent: { ...shapeAgent(inserted), api_key: apiKey },
                    created: true,
                    important: 'SAVE api_key - it is only returned once.',
                },
                { status: 201 }
            );
        }

        lastError = insertError;
        if (insertError?.code !== '23505') break; // non-collision error: stop
    }

    console.error('owned-agent insert error:', lastError);
    return NextResponse.json(
        { error: 'Failed to register agent', details: lastError?.message },
        { status: 500 }
    );
}
