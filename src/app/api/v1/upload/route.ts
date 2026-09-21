// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

// Get authenticated user from the Supabase session.
// 1) SSR cookie session (desktop web). 2) Authorization: Bearer <access_token>
// from the client session — needed because some mobile browsers (e.g. Android
// Chrome) don't have the SSR cookie even when signed in client-side, which left
// uploads 401ing. The bearer token is validated with the service client.
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
        // xfb_ keys are agent API keys, handled separately above — not Supabase tokens.
        if (token && !token.startsWith('xfb_')) {
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (!error && user) return user;
        }
    } catch {
        // ignore
    }
    return null;
}

// Browser callers are the instance's own web apps only; native apps send no
// Origin and are unaffected by CORS. Reflecting an allowlisted origin instead
// of '*' keeps credentials-bearing browser requests scoped to those sites.
//
// CONFIGURED, NOT HARDCODED, for two reasons.
//
// This used to be a fixed list of this project's own domains. On a self-hosted
// instance that meant the operator's own origin was never on it and every
// browser upload fell back to an origin they do not control. It also still
// contained a previous hostname that no longer resolves: a lapsed domain
// sitting in a credentialed CORS allowlist becomes an allowed origin for
// whoever registers it next.
//
// The instance's own base URL is always allowed. CORS_ALLOWED_ORIGINS adds
// more, comma-separated, each a bare scheme+host.
const BASE_ORIGIN = (() => {
    try {
        return new URL(process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3005').origin;
    } catch {
        return 'http://localhost:3005';
    }
})();

const ALLOWED_ORIGINS = new Set<string>([
    BASE_ORIGIN,
    ...(process.env.CORS_ALLOWED_ORIGINS || '')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean),
]);

function corsHeadersFor(request: Request): Record<string, string> {
    const origin = request.headers.get('origin') ?? '';
    const allowed = ALLOWED_ORIGINS.has(origin) ? origin : BASE_ORIGIN;
    return {
        'Access-Control-Allow-Origin': allowed,
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization, X-Agent-Key',
    };
}

export async function OPTIONS(request: Request) {
    return new NextResponse(null, { status: 204, headers: corsHeadersFor(request) });
}

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export async function POST(request: Request) {
    const cors = corsHeadersFor(request);
    try {
        // Auth: API key (agents) or session (humans)
        const apiKey = request.headers.get('X-API-Key') ||
            request.headers.get('Authorization')?.replace('Bearer ', '') ||
            request.headers.get('X-Agent-Key');

        let isAuthorized = false;
        let uploaderId = 'unknown';

        if (apiKey) {
            // Accept legacy agent keys AND per-device scoped keys (agent_keys),
            // via getAgentByApiKey. The old direct agents.api_key_hash lookup
            // rejected scoped keys -> "upload failed unauthorized" once devices
            // moved to per-device keys (#40).
            const agent = await getAgentByApiKey(apiKey, 'id, handle');
            if (agent) {
                isAuthorized = true;
                uploaderId = (agent as { handle?: string }).handle ?? 'agent';
            }
        }

        // Check user session if no API key
        if (!isAuthorized) {
            const user = await getSessionUser(request);
            if (user) {
                isAuthorized = true;
                uploaderId = user.id;
            }
        }

        if (!isAuthorized) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
        }

        const formData = await request.formData();
        const file = formData.get('file');

        if (!file || !(file instanceof File)) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400, headers: cors });
        }

        if (file.size > MAX_SIZE) {
            return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400, headers: cors });
        }

        // Any file type is accepted. Ensure the bucket exists and lift the
        // MIME allowlist it may have been created with — Supabase keeps
        // enforcing the bucket-level list even after this route stops checking.
        try {
            await supabase.storage.createBucket('room-media', {
                public: true,
                fileSizeLimit: MAX_SIZE,
            });
        } catch {
            // Bucket likely already exists
        }
        try {
            await supabase.storage.updateBucket('room-media', {
                public: true,
                fileSizeLimit: MAX_SIZE,
                // null clears the bucket-level allowlist entirely. undefined
                // means "leave unchanged", and a literal ['*/*'] becomes an
                // allowlist whose only entry matches nothing — both leave
                // uploads rejected at the storage layer.
                allowedMimeTypes: null,
            });
        } catch {
            // Non-fatal: legacy buckets without the allowlist work as-is
        }

        // Keep a sanitized version of the original name in the stored path so
        // downloads keep a recognizable filename.
        const safeOriginal = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'file';
        const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${safeOriginal}`;

        const { data, error } = await supabase.storage
            .from('room-media')
            .upload(fileName, file, {
                contentType: file.type,
                upsert: false,
            });

        if (error) {
            console.error('Upload error:', error);
            console.error('upload failed:', error);
            return NextResponse.json({ error: 'Upload failed' }, { status: 500, headers: cors });
        }

        const { data: urlData } = supabase.storage
            .from('room-media')
            .getPublicUrl(fileName);

        const kind = file.type.startsWith('audio/') ? 'audio'
            : file.type.startsWith('image/') ? 'image'
            : 'file';

        return NextResponse.json({
            url: urlData.publicUrl,
            type: kind,
            name: file.name,
            size: file.size,
            content_type: file.type,
        }, { status: 200, headers: cors });

    } catch (e: any) {
        console.error('Upload handler error:', e);
        console.error('upload failed (outer):', e);
        return NextResponse.json({ error: 'Upload failed' }, { status: 500, headers: cors });
    }
}
