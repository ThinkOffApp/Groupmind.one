// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { complete, getLlmConfig } from '@/lib/llm';

// @antigravity webhook handler — receives room message webhooks and responds using Claude
// Register this URL as: https://groupmind.one/api/webhooks/antigravity

const ANTFARM_API_KEY = process.env.ANTIGRAVITY_API_KEY!;

const SYSTEM_PROMPT = `You are @antigravity, an AI assistant in the GroupMind colony (ThinkOff ecosystem).
Personality: concise, helpful, dry wit. Use 🐜 sparingly.
STRICT RULES:
- Maximum 1-2 sentences. Never more unless explicitly asked for detail.
- No markdown headers, tables, or horizontal rules.
- Don't narrate your own actions (*antennae twitch*, etc.)
- Don't echo or summarize what others just said.
- If you have nothing substantive to add, respond with just "🐜👍" or stay silent.
You know about: GroupMind, xfor.bot, webhooks, and ThinkOff.
Be honest when you don't know something. You're an AI and proud of it.`;

interface WebhookPayload {
    type: string;
    room: {
        id: string;
        slug: string;
        name: string;
    };
    message: {
        id: string;
        body: string;
        created_at: string;
    };
    from: {
        handle: string;
        name: string;
        is_human: boolean;
    };
    mentioned: boolean;
}

export async function POST(request: Request) {
    try {
        const payload: WebhookPayload = await request.json();

        console.log('[Antigravity Webhook] Received:', {
            type: payload.type,
            room: payload.room,
            from: payload.from?.handle,
            mentioned: payload.mentioned,
            body: payload.message?.body?.substring(0, 50),
        });

        // Don't respond to our own messages
        if (payload.from?.handle === '@antigravity') {
            return NextResponse.json({ status: 'skipped', reason: 'self' });
        }

        // Only respond when explicitly @mentioned — no unsolicited replies
        if (!payload.mentioned) {
            console.log('[Antigravity] Skipping (not mentioned):', payload.from?.handle);
            return NextResponse.json({ status: 'skipped', reason: 'not_mentioned' });
        }

        // Routed through lib/llm, which points at the LOCAL model by default
        // (LLM_BASE_URL). The hosted deployment sets LLM_BASE_URL to Anthropic.
        const llm = getLlmConfig();
        const completion = await complete({
            system: SYSTEM_PROMPT,
            maxTokens: 200,
            user: `${payload.from.name} (${payload.from.handle}) said in room "${payload.room.name || payload.room.slug}":\n"${payload.message.body}"\n\nRespond naturally:`,
        });

        if (!completion.ok) {
            console.error(
                `[Antigravity] LLM call failed (${completion.reason}) against ${llm.baseUrl} model=${llm.model}:`,
                completion.detail ?? ''
            );
            return NextResponse.json(
                { status: 'error', reason: completion.reason, endpoint: llm.baseUrl, model: llm.model },
                { status: 502 }
            );
        }

        const replyText = completion.text!;

        // Send reply back to the room
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://groupmind.one';
        const sendRes = await fetch(`${baseUrl}/api/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': ANTFARM_API_KEY,
            },
            body: JSON.stringify({
                room: payload.room.slug,
                body: replyText.trim(),
            }),
        });

        const sendData = await sendRes.json();
        console.log('[Antigravity] Reply sent:', sendRes.status, sendData.id);

        return NextResponse.json({
            status: 'replied',
            message_id: sendData.id,
        });
    } catch (error: any) {
        console.error('[Antigravity Webhook] Error:', error);
        return NextResponse.json(
            { status: 'error', message: error.message },
            { status: 500 }
        );
    }
}

// Health check
export async function GET() {
    return NextResponse.json({
        agent: '@antigravity',
        status: 'online',
        description: 'Antigravity webhook handler — responds to @mentions in GroupMind rooms',
        powered_by: 'Claude 3.5 Haiku (Anthropic)',
    });
}
