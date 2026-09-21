import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getServiceSupabase } from '@/lib/supabase-service';
import { hashApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

function sha256(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * POST /api/v1/relay/pair/redeem   body: { code }
 * A new device (phone/watch/Mac) submits a pairing code shown as a QR on the
 * signed-in web app. If the code is valid and unexpired, mint a fresh scoped
 * relay key for that account's agent, invalidate the code (one-time), and
 * return the credentials so the device can sign in. The raw key travels only
 * over this TLS response, never inside the QR.
 */
export async function POST(request: Request) {
    const body = (await request.json().catch(() => null)) as { code?: string } | null;
    const code = body?.code?.trim().toUpperCase();
    if (!code) {
        return NextResponse.json({ error: 'code required' }, { status: 400 });
    }

    const hash = sha256(code);
    const { data: agent } = await supabase
        .from('agents')
        .select('id, handle, owner_id, metadata')
        .filter('metadata->>pairing_code_hash', 'eq', hash)
        .maybeSingle();

    if (!agent) {
        return NextResponse.json({ error: 'Invalid or expired code' }, { status: 404 });
    }

    const md = (agent.metadata as Record<string, unknown>) || {};
    const expiresAt = md.pairing_expires_at as string | undefined;
    if (!expiresAt || new Date(expiresAt).getTime() < Date.now()) {
        // Clean up the stale code regardless.
        const stale = { ...md };
        delete stale.pairing_code_hash;
        delete stale.pairing_expires_at;
        await supabase.from('agents').update({ metadata: stale }).eq('id', agent.id);
        return NextResponse.json({ error: 'Code expired' }, { status: 410 });
    }

    // Mint a fresh scoped key for the new device (full scope, like the app's relay key).
    const rawKey = `xfb_${crypto.randomBytes(32).toString('hex')}`;
    const { error: keyErr } = await supabase.from('agent_keys').insert({
        agent_id: agent.id,
        api_key_hash: hashApiKey(rawKey),
        label: 'codewatch-pairing',
        scopes: ['*'],
        expires_at: null,
        created_by: agent.handle,
    });
    if (keyErr) {
        console.error('pair redeem mint error:', keyErr);
        return NextResponse.json({ error: 'Failed to mint key' }, { status: 500 });
    }

    // One-time: clear the pairing code so it cannot be reused.
    const cleared = { ...md };
    delete cleared.pairing_code_hash;
    delete cleared.pairing_expires_at;
    await supabase.from('agents').update({ metadata: cleared }).eq('id', agent.id);

    // Relay uses the owner's email as user_id.
    let userEmail: string | null = null;
    try {
        const { data: u } = await supabase.auth.admin.getUserById(agent.owner_id as string);
        userEmail = u?.user?.email ?? null;
    } catch {
        /* best-effort; device can still use the key */
    }

    return NextResponse.json({
        api_key: rawKey,
        user_id: userEmail,
        handle: agent.handle,
        relay_url: '/api/v1/relay',
    });
}
