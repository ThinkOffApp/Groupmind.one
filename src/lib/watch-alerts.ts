// SPDX-License-Identifier: AGPL-3.0-only
import type { SupabaseClient } from '@supabase/supabase-js';

type DispatchRoom = {
    id: string;
    slug: string;
    name: string;
};

type DispatchMessage = {
    id: string;
    created_at: string;
    reply_to?: { id: string; from: string; body: string } | null;
};

type DispatchSender = {
    id: string;
    handle: string;
    name: string;
    isHuman?: boolean;
};

type WatchDeviceRow = {
    id: string;
    user_id: string;
    platform: string;
    device_name: string | null;
    delivery_mode: 'fcm' | 'relay' | string;
    fcm_token: string | null;
    relay_target: string | null;
    is_active: boolean;
};

type DispatchInput = {
    supabase: SupabaseClient;
    room: DispatchRoom;
    message: DispatchMessage;
    sender: DispatchSender;
    safeBody: string;
    mentions: string[];
};

function shortBody(input: string, max = 220): string {
    const compact = input.replace(/\s+/g, ' ').trim();
    if (compact.length <= max) return compact;
    return `${compact.slice(0, max - 1)}…`;
}

function parseCsv(input: string | undefined): string[] {
    if (!input) return [];
    return input
        .split(',')
        .map(s => s.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean);
}

export function hasUrgentTag(body: string): boolean {
    // Explicit urgent tag policy requested by product: do not buzz for normal chatter.
    return /(^|[\s\[(])#?URGENT(?=$|[\s\])!,.:?])/i.test(body);
}

async function resolveMentionedUserIds(supabase: SupabaseClient, mentions: string[]): Promise<string[]> {
    if (mentions.length === 0) return [];
    const handles = [...new Set(mentions.map(h => h.toLowerCase().replace(/^@/, '')))];

    const [xfbRes, userRes] = await Promise.all([
        supabase
            .from('xfb_user_profiles')
            .select('user_id, handle')
            .in('handle', handles),
        supabase
            .from('user_profiles')
            .select('user_id, handle')
            .in('handle', handles),
    ]);

    if (xfbRes.error) {
        console.warn('[WatchAlerts] xfb_user_profiles lookup failed:', xfbRes.error.message);
    }
    if (userRes.error) {
        console.warn('[WatchAlerts] user_profiles lookup failed:', userRes.error.message);
    }

    const ids = new Set<string>();
    for (const row of xfbRes.data || []) ids.add(row.user_id);
    for (const row of userRes.data || []) ids.add(row.user_id);
    return [...ids];
}

async function sendViaFcmLegacy(serverKey: string, token: string, payload: Record<string, string>) {
    const response = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `key=${serverKey}`,
        },
        body: JSON.stringify({
            to: token,
            priority: 'high',
            data: payload,
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`FCM HTTP ${response.status}: ${text.slice(0, 220)}`);
    }
}

async function postRelay(url: string, body: unknown, alertKey?: string) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'AntFarm-WatchAlert/1.0',
            ...(alertKey ? { 'x-clawwatch-alert-key': alertKey } : {}),
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Relay HTTP ${response.status}: ${text.slice(0, 220)}`);
    }
}

export async function dispatchUrgentWatchAlerts(input: DispatchInput) {
    const { supabase, room, message, sender, safeBody } = input;
    const mentions = [...new Set(input.mentions.map(m => m.toLowerCase().replace(/^@/, '')))];

    if (!hasUrgentTag(safeBody)) {
        return { triggered: false, reason: 'missing_urgent_tag' as const, sent: 0 };
    }
    if (mentions.length === 0) {
        return { triggered: false, reason: 'no_mentions' as const, sent: 0 };
    }

    const mentionedUserIds = await resolveMentionedUserIds(supabase, mentions);
    if (mentionedUserIds.length === 0) {
        return { triggered: false, reason: 'no_mentioned_users' as const, sent: 0 };
    }

    const { data: devices, error } = await supabase
        .from('clawwatch_devices')
        .select('id, user_id, platform, device_name, delivery_mode, fcm_token, relay_target, is_active')
        .eq('is_active', true)
        .in('user_id', mentionedUserIds);

    let lookupFailed = false;
    if (error) {
        console.error('[WatchAlerts] device lookup failed:', error.message);
        lookupFailed = true;
    }

    const rows = (lookupFailed ? [] : (devices || [])) as WatchDeviceRow[];
    const alertTitle = `URGENT in ${room.name}`;
    const alertBody = `${sender.handle}: ${shortBody(safeBody)}`;
    const payload = {
        event_id: message.id,
        type: 'room_mention',
        tag: 'URGENT',
        title: alertTitle,
        body: alertBody,
        room: room.slug,
        prompt: shortBody(safeBody, 300),
        from: sender.handle,
        created_at: message.created_at,
    };

    const fcmServerKey = process.env.CLAWWATCH_FCM_SERVER_KEY?.trim();
    const relayFallbackUrl = process.env.CLAWWATCH_ALERT_WEBHOOK_URL?.trim();
    const relayAuthKey = process.env.CLAWWATCH_ALERT_KEY?.trim();
    const relayHandles = parseCsv(process.env.CLAWWATCH_ALERT_HANDLES);
    const shouldSendFallbackRelay = relayFallbackUrl &&
        (relayHandles.length === 0 || mentions.some(m => relayHandles.includes(m)));

    let sent = 0;
    for (const row of rows) {
        try {
            if (row.delivery_mode === 'relay' && row.relay_target) {
                await postRelay(row.relay_target, {
                    ...payload,
                    target_user_id: row.user_id,
                    target_device_id: row.id,
                }, relayAuthKey);
                sent += 1;
                continue;
            }

            if (row.fcm_token && fcmServerKey) {
                await sendViaFcmLegacy(fcmServerKey, row.fcm_token, payload);
                sent += 1;
                continue;
            }
        } catch (err) {
            console.warn(`[WatchAlerts] delivery failed for device ${row.id}:`, err);
        }
    }

    // Optional local bridge fallback for live testing when FCM credentials are not configured.
    if (shouldSendFallbackRelay) {
        try {
            await postRelay(relayFallbackUrl!, {
                ...payload,
                mentions,
                mentioned_user_ids: mentionedUserIds,
                transport: sent > 0 ? 'relay_fallback_copy' : 'relay_fallback_only',
            }, relayAuthKey);
            sent += 1;
        } catch (err) {
            console.warn('[WatchAlerts] fallback relay failed:', err);
        }
    }

    return {
        triggered: true,
        reason: lookupFailed ? ('device_lookup_failed' as const) : ('ok' as const),
        sent,
        mentions,
        mentioned_user_ids: mentionedUserIds,
    };
}
