-- ClawWatch device registration for server-initiated alerts

CREATE TABLE IF NOT EXISTS clawwatch_devices (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL DEFAULT 'wearos',
    device_name TEXT,
    delivery_mode TEXT NOT NULL DEFAULT 'fcm', -- fcm | relay
    fcm_token TEXT,
    relay_target TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS clawwatch_devices_user_idx
    ON clawwatch_devices(user_id, is_active);

CREATE UNIQUE INDEX IF NOT EXISTS clawwatch_devices_user_fcm_unique
    ON clawwatch_devices(user_id, platform, fcm_token)
    WHERE fcm_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS clawwatch_devices_user_relay_unique
    ON clawwatch_devices(user_id, platform, relay_target)
    WHERE relay_target IS NOT NULL;
