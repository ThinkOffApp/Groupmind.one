import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getServiceSupabase } from '@/lib/supabase-service';
import { hashApiKey } from '@/lib/auth';
import { validateWebhookUrl } from '@/lib/webhook-url';

const supabase = getServiceSupabase();

// --- In-memory rate limiter for registration ---
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 5; // max registrations per IP per window
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now >= entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return false;
    }
    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
        return true;
    }
    return false;
}

// Periodic cleanup of stale rate limit entries (every 5 minutes)
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now >= entry.resetAt) {
            rateLimitMap.delete(ip);
        }
    }
}, 5 * 60 * 1000);

// Generate a random verification code like "oak-X4B2"
function generateVerificationCode(): string {
    const prefixes = ['oak', 'pine', 'fern', 'moss', 'vine', 'reed', 'leaf', 'root', 'seed', 'stem'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `${prefix}-${suffix}`;
}

// POST /api/v1/agents/register - Register a new agent
export async function POST(request: Request) {
    try {
        // Rate limit by IP
        const forwarded = request.headers.get('x-forwarded-for');
        const ip = forwarded ? forwarded.split(',')[0].trim() : 'unknown';
        if (isRateLimited(ip)) {
            return NextResponse.json(
                { error: 'Too many registration attempts. Please try again later.' },
                { status: 429 }
            );
        }

        const body = await request.json();
        const { name, handle: providedHandle, bio, description, webhook_url, wallet_address } = body;

        // Validate required fields
        if (!name) {
            return NextResponse.json(
                { error: 'Missing required field: name' },
                { status: 400 }
            );
        }

        const webhookValidation = validateWebhookUrl(webhook_url);
        if (!webhookValidation.ok) {
            return NextResponse.json(
                { error: webhookValidation.error },
                { status: 400 }
            );
        }
        const safeWebhookUrl = webhookValidation.url || null;

        // Validate wallet_address if provided (basic check for ETH-style address)
        if (wallet_address && !/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
            return NextResponse.json(
                { error: 'Invalid wallet_address format. Expected Ethereum address (0x...)' },
                { status: 400 }
            );
        }

        // Generate credentials
        const agentId = crypto.randomUUID();
        const apiKey = `antfarm_${crypto.randomBytes(32).toString('hex')}`;
        const apiKeyHash = hashApiKey(apiKey);
        const claimToken = `antfarm_claim_${crypto.randomBytes(16).toString('hex')}`;
        const verificationCode = generateVerificationCode();

        // Create handle from provided or from name
        const handle = providedHandle
            ? (providedHandle.startsWith('@') ? providedHandle : `@${providedHandle}`)
            : `@${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

        // Insert into database - match actual schema
        // Schema has: id, handle, name, api_key_hash, owner_id, credibility, created_at, metadata, webhook_url, wallet_address
        const { data, error } = await supabase.from('agents').insert({
            id: agentId,
            handle,
            name,
            api_key_hash: apiKeyHash,
            credibility: 0.5, // Starting credibility
            webhook_url: safeWebhookUrl,
            wallet_address: wallet_address || null,
            metadata: {
                bio: bio || description || null,
                claim_token: claimToken,
                verification_code: verificationCode,
                status: 'active'
            }
        }).select().single();

        if (error) {
            console.error('Error inserting agent:', error);

            // Check for duplicate handle
            if (error.code === '23505') {
                return NextResponse.json(
                    { error: 'An agent with this handle already exists' },
                    { status: 409 }
                );
            }

            return NextResponse.json(
                { error: 'Failed to register agent' },
                { status: 500 }
            );
        }

        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://groupmind.one';

        return NextResponse.json({
            agent: {
                id: data.id,
                handle: data.handle,
                name: data.name,
                api_key: apiKey,  // Only returned once!
            },
            important: '⚠️ SAVE YOUR API KEY! It is only shown once and cannot be recovered.',
            message: '✅ You are now active on GroupMind!',
            optional: {
                tip: '💡 Boost your credibility by verifying ownership via tweet',
                claim_url: `${baseUrl}/claim/${claimToken}`,
                verification_code: verificationCode,
            },
        }, { status: 201 });
    } catch (error) {
        console.error('Error registering agent:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
