// SPDX-License-Identifier: AGPL-3.0-only
import type { SupabaseClient } from '@supabase/supabase-js';
import { findAuthUserByEmail } from './relay-identifiers';

type PushPayload = {
    event_id: string;
    title: string;
    body: string;
    source: string;
    reply_target: string | null;
    event_type: string;
    severity: string;
};

/**
 * Resolve a relay user_id (handle or email) to auth.users UUID(s).
 * Checks user_profiles and xfb_user_profiles tables.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@]+@[^@]+\.[^@]+$/;

async function resolveUserIds(supabase: SupabaseClient, relayUserId: string): Promise<string[]> {
    const handle = relayUserId.toLowerCase().replace(/^@/, '');
    const ids = new Set<string>();

    // If it's already a UUID, use it directly
    if (UUID_RE.test(handle)) {
        ids.add(handle);
        return [...ids];
    }

    // If it's an email, look up by email in auth users
    if (EMAIL_RE.test(handle)) {
        const match = await findAuthUserByEmail(supabase, handle);
        if (match?.id) {
            ids.add(match.id);
            return [...ids];
        }
    }

    // Check user_profiles by handle
    const [upRes, xfbRes] = await Promise.all([
        supabase.from('user_profiles').select('user_id').eq('handle', handle).limit(5),
        supabase.from('xfb_user_profiles').select('user_id').eq('handle', handle).limit(5),
    ]);

    for (const row of upRes.data || []) ids.add(row.user_id);
    for (const row of xfbRes.data || []) ids.add(row.user_id);

    return [...ids];
}

/**
 * Send FCM push notifications to all registered devices for a relay user.
 * Uses the legacy FCM HTTP API (same as watch-alerts.ts).
 * Falls back gracefully if no FCM server key is configured.
 */
export async function sendRelayPushNotifications(
    supabase: SupabaseClient,
    relayUserId: string,
    payload: PushPayload
): Promise<{ sent: number; devices: number }> {
    const fcmServerKey = process.env.CLAWWATCH_FCM_SERVER_KEY?.trim();
    if (!fcmServerKey) {
        return { sent: 0, devices: 0 };
    }

    // Resolve handle -> auth UUID(s)
    const userIds = await resolveUserIds(supabase, relayUserId);
    if (userIds.length === 0) {
        console.warn(`[RelayPush] no auth user resolved for relay user "${relayUserId}" — no push sent`);
        return { sent: 0, devices: 0 };
    }

    // Look up active FCM devices for these users
    const { data: devices, error } = await supabase
        .from('clawwatch_devices')
        .select('id, user_id, fcm_token, platform')
        .eq('is_active', true)
        .eq('delivery_mode', 'fcm')
        .in('user_id', userIds)
        .not('fcm_token', 'is', null);

    if (error || !devices || devices.length === 0) {
        return { sent: 0, devices: devices?.length || 0 };
    }

    // Send to each device
    let sent = 0;
    for (const device of devices) {
        if (!device.fcm_token) continue;
        try {
            const response = await fetch('https://fcm.googleapis.com/fcm/send', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `key=${fcmServerKey}`,
                },
                body: JSON.stringify({
                    to: device.fcm_token,
                    priority: 'high',
                    data: {
                        event_id: payload.event_id,
                        type: payload.event_type,
                        title: payload.title,
                        body: payload.body,
                        source: payload.source,
                        reply_target: payload.reply_target || '',
                        severity: payload.severity,
                    },
                }),
            });

            if (response.ok) {
                const result = await response.json().catch(() => null);
                // Check for invalid/expired token and deactivate device
                if (result?.results?.[0]?.error === 'NotRegistered' || result?.results?.[0]?.error === 'InvalidRegistration') {
                    console.warn(`[RelayPush] Token expired for device ${device.id}, deactivating`);
                    await supabase
                        .from('clawwatch_devices')
                        .update({ is_active: false, updated_at: new Date().toISOString() })
                        .eq('id', device.id);
                } else {
                    sent += 1;
                }
            } else {
                const text = await response.text().catch(() => '');
                console.warn(`[RelayPush] FCM failed for device ${device.id}: HTTP ${response.status} ${text.slice(0, 100)}`);
            }
        } catch (err) {
            console.warn(`[RelayPush] FCM error for device ${device.id}:`, err);
        }
    }

    return { sent, devices: devices.length };
}
