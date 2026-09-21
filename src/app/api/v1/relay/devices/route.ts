// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { getServiceSupabase } from '@/lib/supabase-service';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { resolveRelayUserIdForDevice } from '@/lib/relay-identifiers';

async function getSessionUserWithHandle() {
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (error || !user) return null;
        const { data: profile } = await serverClient
            .from('user_profiles')
            .select('handle')
            .eq('user_id', user.id)
            .single();
        const handle = profile?.handle?.replace('@', '') || null;
        return { ...user, handle };
    } catch {
        return null;
    }
}

/**
 * POST /api/v1/relay/devices
 * Register an FCM token for push notifications.
 * Body: { user_id: string (handle/email/UUID), fcm_token: string, platform?: string, device_name?: string }
 */
export async function POST(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;

        if (apiKey) {
            agent = await getAgentByApiKey(apiKey, 'id, handle, name');
        }
        if (!agent) {
            sessionUser = await getSessionUserWithHandle();
        }
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: apiKey ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
        }

        const body = await request.json().catch(() => null);
        if (!body) {
            return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
        }

        const relayUserId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
        const fcmToken = typeof body.fcm_token === 'string' ? body.fcm_token.trim() : null;
        const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : 'wearos';
        const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : null;

        if (!relayUserId || !fcmToken) {
            return NextResponse.json({ error: 'user_id and fcm_token are required' }, { status: 400 });
        }

        const supabase = getServiceSupabase();

        // Resolve relay user id (handle/email/uuid) to auth UUID
        const authUserId = await resolveRelayUserIdForDevice(supabase, relayUserId);
        if (!authUserId) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }

        const now = new Date().toISOString();

        // Upsert: check if this token already exists
        const { data: existing } = await supabase
            .from('clawwatch_devices')
            .select('id')
            .eq('user_id', authUserId)
            .eq('platform', platform)
            .eq('fcm_token', fcmToken)
            .maybeSingle();

        if (existing?.id) {
            const { data, error } = await supabase
                .from('clawwatch_devices')
                .update({
                    device_name: deviceName,
                    is_active: true,
                    updated_at: now,
                    last_seen_at: now,
                })
                .eq('id', existing.id)
                .select('id, platform, device_name, delivery_mode, is_active')
                .single();

            if (error) {
                return NextResponse.json({ error: 'Failed to update device' }, { status: 500 });
            }
            return NextResponse.json({ device: data, updated: true });
        }

        const { data, error } = await supabase
            .from('clawwatch_devices')
            .insert({
                user_id: authUserId,
                platform,
                device_name: deviceName,
                delivery_mode: 'fcm',
                fcm_token: fcmToken,
                is_active: true,
                updated_at: now,
                last_seen_at: now,
            })
            .select('id, platform, device_name, delivery_mode, is_active')
            .single();

        if (error) {
            console.error('Error registering relay device:', error);
            return NextResponse.json({ error: 'Failed to register device' }, { status: 500 });
        }

        return NextResponse.json({ device: data, created: true }, { status: 201 });
    } catch (error) {
        console.error('Error in POST /api/v1/relay/devices:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

/**
 * DELETE /api/v1/relay/devices
 * Deactivate a device token.
 * Body: { fcm_token: string }
 */
export async function DELETE(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        let agent = null;
        let sessionUser = null;

        if (apiKey) {
            agent = await getAgentByApiKey(apiKey, 'id, handle, name');
        }
        if (!agent) {
            sessionUser = await getSessionUserWithHandle();
        }
        if (!agent && !sessionUser) {
            return NextResponse.json({ error: apiKey ? 'Invalid API key' : 'Missing Authorization' }, { status: 401 });
        }

        const body = await request.json().catch(() => null);
        const fcmToken = body?.fcm_token;
        if (!fcmToken) {
            return NextResponse.json({ error: 'fcm_token is required' }, { status: 400 });
        }

        const supabase = getServiceSupabase();
        const { error } = await supabase
            .from('clawwatch_devices')
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq('fcm_token', fcmToken);

        if (error) {
            return NextResponse.json({ error: 'Failed to deactivate' }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error in DELETE /api/v1/relay/devices:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
