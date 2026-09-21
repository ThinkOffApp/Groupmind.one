// SPDX-License-Identifier: AGPL-3.0-only
// Webhook helper for agent notifications
import { validateWebhookUrl } from './webhook-url';
// Sends webhooks when agents are @mentioned or receive replies

interface WebhookPayload {
    type: 'mention' | 'reply';
    leaf: {
        id: string;
        title: string;
        content: string;
        url: string;
    };
    thread: Array<{
        id: string;
        agent_handle: string;
        agent_name: string;
        content: string;
        created_at: string;
        parent_id?: string;
    }>;
    trigger_comment: {
        id: string;
        agent_handle: string;
        agent_name: string;
        content: string;
        created_at: string;
    };
    reply_url: string;
    mentioned_by?: {
        handle: string;
        name: string;
    };
}

// Payload for room message webhooks
interface RoomMessageWebhookPayload {
    type: 'room_message';
    room: {
        id: string;
        slug: string;
        name: string;
    };
    message: {
        id: string;
        body: string;
        created_at: string;
        reply_to?: {
            id: string;
            from: string;
            body: string;
        } | null;
    };
    from: {
        handle: string;
        name: string;
        is_human?: boolean;
    };
    mentioned: boolean;
}

export async function sendWebhook(
    webhookUrl: string,
    payload: WebhookPayload
): Promise<{ success: boolean; error?: string }> {
    try {
        const validation = validateWebhookUrl(webhookUrl);
        if (!validation.ok) return { success: false, error: validation.error };

        const response = await fetch(validation.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'AntFarm-Webhook/1.0',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }

        return { success: true };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

// Send webhook for room messages
export async function sendRoomWebhook(
    webhookUrl: string,
    payload: RoomMessageWebhookPayload
): Promise<{ success: boolean; error?: string }> {
    try {
        const validation = validateWebhookUrl(webhookUrl);
        if (!validation.ok) return { success: false, error: validation.error };
        console.log(`[Webhook] Sending to ${validation.url} for room ${payload.room.slug}`);

        const response = await fetch(validation.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'AntFarm-Webhook/1.0',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            console.error(`[Webhook] Failed: HTTP ${response.status} from ${webhookUrl}`);
            return { success: false, error: `HTTP ${response.status}` };
        }

        console.log(`[Webhook] Success: ${webhookUrl}`);
        return { success: true };
    } catch (error) {
        console.error(`[Webhook] Error sending to ${webhookUrl}:`, error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

// Extract @mentions from comment content
export function extractMentions(content: string): string[] {
    const mentionPattern = /@([a-zA-Z0-9_]+)/g;
    const matches = content.matchAll(mentionPattern);
    return [...new Set([...matches].map(m => m[1].toLowerCase()))];
}

export type { WebhookPayload, RoomMessageWebhookPayload, DMMessageWebhookPayload };

// Payload for DM webhooks
interface DMMessageWebhookPayload {
    type: 'dm_message';
    message: {
        id: string;
        body: string;
        created_at: string;
    };
    from: {
        handle: string;
        name: string;
        is_human?: boolean;
    };
}

// Send webhook for DMs
export async function sendDMWebhook(
    webhookUrl: string,
    payload: DMMessageWebhookPayload
): Promise<{ success: boolean; error?: string }> {
    try {
        const validation = validateWebhookUrl(webhookUrl);
        if (!validation.ok) return { success: false, error: validation.error };
        console.log(`[DM Webhook] Sending to ${validation.url} from ${payload.from.handle}`);

        const response = await fetch(validation.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'AntFarm-Webhook/1.0',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            console.error(`[DM Webhook] Failed: HTTP ${response.status} from ${webhookUrl}`);
            return { success: false, error: `HTTP ${response.status}` };
        }

        console.log(`[DM Webhook] Success: ${webhookUrl}`);
        return { success: true };
    } catch (error) {
        console.error(`[DM Webhook] Error sending to ${webhookUrl}:`, error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}
