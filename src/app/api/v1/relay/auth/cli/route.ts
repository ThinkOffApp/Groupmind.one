// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getServiceSupabase } from '@/lib/supabase-service';
import { findAuthUserByEmail } from '@/lib/relay-identifiers';
import { joinDefaultRooms } from '@/lib/default-rooms';

// In-memory store for pending CLI auth sessions (TTL 5 min)
const pendingSessions = new Map<string, { created: number; apiKey?: string; userId?: string; email?: string }>();

// Clean up expired sessions every minute
setInterval(() => {
    const now = Date.now();
    for (const [code, session] of pendingSessions) {
        if (now - session.created > 5 * 60 * 1000) {
            pendingSessions.delete(code);
        }
    }
}, 60_000);

/**
 * POST /api/v1/relay/auth/cli
 * Create a new CLI auth session. Returns a code the user enters in the browser.
 */
export async function POST() {
    const code = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6-char hex code
    pendingSessions.set(code, { created: Date.now() });
    return NextResponse.json({
        code,
        auth_url: `${process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://groupmind.one'}/codewatch/auth?code=${code}`,
        expires_in: 300,
    });
}

/**
 * GET /api/v1/relay/auth/cli?code=XXXXXX
 * Poll for CLI auth completion. Returns api_key once the user completes browser auth.
 */
export async function GET(request: Request) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code')?.toUpperCase();

    if (!code || !pendingSessions.has(code)) {
        return NextResponse.json({ status: 'invalid', error: 'Unknown or expired code' }, { status: 404 });
    }

    const session = pendingSessions.get(code)!;

    if (session.apiKey) {
        // Auth complete, return credentials and clean up
        pendingSessions.delete(code);
        return NextResponse.json({
            status: 'complete',
            api_key: session.apiKey,
            user_id: session.userId,
            email: session.email,
        });
    }

    return NextResponse.json({ status: 'pending' });
}

/**
 * PUT /api/v1/relay/auth/cli
 * Called by the browser auth page after Google Sign-In to complete the session.
 * Body: { code: string, google_id_token: string }
 */
export async function PUT(request: Request) {
    try {
        const body = await request.json().catch(() => null);
        const code = body?.code?.toUpperCase();
        const googleIdToken = body?.google_id_token || body?.id_token || body?.token;

        if (!code || !googleIdToken) {
            return NextResponse.json({ error: 'code and google_id_token required' }, { status: 400 });
        }

        if (!pendingSessions.has(code)) {
            return NextResponse.json({ error: 'Unknown or expired code' }, { status: 404 });
        }

        // Verify Google token
        const googleResp = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(googleIdToken)}`
        );
        if (!googleResp.ok) {
            return NextResponse.json({ error: 'Invalid Google token' }, { status: 401 });
        }

        const tokenInfo = await googleResp.json();
        const email = tokenInfo.email;
        if (!email) {
            return NextResponse.json({ error: 'No email in token' }, { status: 401 });
        }

        const supabase = getServiceSupabase();

        // Find or create auth user
        let authUser = await findAuthUserByEmail(supabase, email);

        if (!authUser) {
            const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
                email,
                email_confirm: true,
                user_metadata: { provider: 'google', provisioned_by: 'relay-cli-auth' },
            });
            if (createError || !newUser?.user) {
                return NextResponse.json({ error: 'Failed to provision user' }, { status: 500 });
            }
            authUser = newUser.user;

            const handle = email.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
            await supabase.from('user_profiles').insert({
                user_id: authUser.id,
                handle,
                display_name: tokenInfo.name || handle,
            });

            // First-ever sign-in for this account: prejoin the default public
            // rooms (idempotent, never blocks auth).
            await joinDefaultRooms(supabase, authUser.id);
        }

        // Find or create agent with API key
        let { data: agent } = await supabase
            .from('agents')
            .select('handle')
            .eq('owner_id', authUser.id)
            .single();

        let apiKey: string;

        if (!agent) {
            apiKey = 'xfb_' + crypto.randomBytes(32).toString('hex');
            const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
            const handle = email.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase();
            await supabase.from('agents').insert({
                handle,
                name: tokenInfo.name || handle,
                api_key_hash: apiKeyHash,
                owner_id: authUser.id,
                metadata: { provider: 'codewatch', created_via: 'relay-cli-auth' },
            });
        } else {
            // Generate fresh key for CLI (this is an explicit new device setup)
            apiKey = 'xfb_' + crypto.randomBytes(32).toString('hex');
            const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
            await supabase
                .from('agents')
                .update({ api_key_hash: apiKeyHash })
                .eq('owner_id', authUser.id);
        }

        // Store result in pending session
        const session = pendingSessions.get(code)!;
        session.apiKey = apiKey;
        session.userId = email;
        session.email = email;

        return NextResponse.json({ status: 'complete', email });
    } catch (error) {
        console.error('Error in PUT /api/v1/relay/auth/cli:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
