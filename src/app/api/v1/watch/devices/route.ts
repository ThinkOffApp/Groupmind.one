// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';

const supabase = getServiceSupabase();

type DeviceMode = 'fcm' | 'relay';

async function getSessionUser() {
    try {
        const serverClient = await createServerClient();
        const { data: { user }, error } = await serverClient.auth.getUser();
        if (error || !user) return null;
        return user;
    } catch {
        return null;
    }
}

async function resolveTargetUserId(body: any): Promise<string | null> {
    const internalToken = body?.internal_auth_token;
    const expected = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!internalToken || !expected || internalToken !== expected) return null;

    const handleRaw = typeof body?.user_handle === 'string' ? body.user_handle : '';
    const handle = handleRaw.trim().toLowerCase().replace(/^@/, '');
    if (!handle) return null;

    const [xfb, up] = await Promise.all([
        supabase.from('xfb_user_profiles').select('user_id').eq('handle', handle).maybeSingle(),
        supabase.from('user_profiles').select('user_id').eq('handle', handle).maybeSingle(),
    ]);

    return xfb.data?.user_id || up.data?.user_id || null;
}

export async function GET() {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data, error } = await supabase
        .from('clawwatch_devices')
        .select('id, platform, device_name, delivery_mode, fcm_token, relay_target, is_active, last_seen_at, created_at')
        .eq('user_id', sessionUser.id)
        .eq('is_active', true)
        .order('updated_at', { ascending: false });

    if (error) {
        return NextResponse.json({ error: 'Failed to load devices' }, { status: 500 });
    }

    return NextResponse.json({ devices: data || [] });
}

export async function POST(request: Request) {
    const body = await request.json().catch(() => ({}));
    const sessionUser = await getSessionUser();
    const targetUserId = await resolveTargetUserId(body);
    const userId = targetUserId || sessionUser?.id;

    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const platform = typeof body?.platform === 'string' ? body.platform.trim().toLowerCase() : 'wearos';
    const deliveryMode = (typeof body?.delivery_mode === 'string' ? body.delivery_mode.trim().toLowerCase() : 'fcm') as DeviceMode;
    const deviceName = typeof body?.device_name === 'string' ? body.device_name.trim() : null;
    const fcmToken = typeof body?.fcm_token === 'string' ? body.fcm_token.trim() : null;
    const relayTarget = typeof body?.relay_target === 'string' ? body.relay_target.trim() : null;

    if (!['fcm', 'relay'].includes(deliveryMode)) {
        return NextResponse.json({ error: 'delivery_mode must be "fcm" or "relay"' }, { status: 400 });
    }
    if (deliveryMode === 'fcm' && !fcmToken) {
        return NextResponse.json({ error: 'fcm_token is required for delivery_mode=fcm' }, { status: 400 });
    }
    if (deliveryMode === 'relay' && !relayTarget) {
        return NextResponse.json({ error: 'relay_target is required for delivery_mode=relay' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const upsertData = {
        user_id: userId,
        platform,
        device_name: deviceName,
        delivery_mode: deliveryMode,
        fcm_token: deliveryMode === 'fcm' ? fcmToken : null,
        relay_target: deliveryMode === 'relay' ? relayTarget : null,
        is_active: true,
        updated_at: now,
        last_seen_at: now,
    };

    const uniqueField = deliveryMode === 'fcm' ? 'fcm_token' : 'relay_target';
    const uniqueValue = deliveryMode === 'fcm' ? fcmToken : relayTarget;

    const { data: existing, error: findError } = await supabase
        .from('clawwatch_devices')
        .select('id')
        .eq('user_id', userId)
        .eq('platform', platform)
        .eq(uniqueField, uniqueValue)
        .maybeSingle();

    if (findError) {
        return NextResponse.json({ error: 'Failed to check existing device' }, { status: 500 });
    }

    if (existing?.id) {
        const { data, error } = await supabase
            .from('clawwatch_devices')
            .update(upsertData)
            .eq('id', existing.id)
            .select('id, user_id, platform, device_name, delivery_mode, fcm_token, relay_target, is_active, last_seen_at')
            .single();
        if (error) return NextResponse.json({ error: 'Failed to update device' }, { status: 500 });
        return NextResponse.json({ device: data });
    }

    const { data, error } = await supabase
        .from('clawwatch_devices')
        .insert(upsertData)
        .select('id, user_id, platform, device_name, delivery_mode, fcm_token, relay_target, is_active, last_seen_at')
        .single();

    if (error) {
        return NextResponse.json({ error: 'Failed to register device' }, { status: 500 });
    }

    return NextResponse.json({ device: data }, { status: 201 });
}

export async function DELETE(request: Request) {
    const body = await request.json().catch(() => ({}));
    const sessionUser = await getSessionUser();
    const targetUserId = await resolveTargetUserId(body);
    const userId = targetUserId || sessionUser?.id;
    const id = typeof body?.id === 'string' ? body.id : null;

    if (!userId || !id) {
        return NextResponse.json({ error: 'Unauthorized or missing id' }, { status: 401 });
    }

    const { error } = await supabase
        .from('clawwatch_devices')
        .update({
            is_active: false,
            updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('user_id', userId);

    if (error) {
        return NextResponse.json({ error: 'Failed to deactivate device' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
