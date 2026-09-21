// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';

const supabase = getServiceSupabase();

// GET /api/v1/premium/status - Check if current user has premium
export async function GET(request: NextRequest) {
    try {
        const serverClient = await createServerClient();
        const { data: { user } } = await serverClient.auth.getUser();

        if (!user) {
            return NextResponse.json({ is_premium: false, reason: 'not_authenticated' });
        }

        const { data: profile } = await supabase
            .from('xfb_user_profiles')
            .select('is_premium')
            .eq('id', user.id)
            .single();

        return NextResponse.json({
            is_premium: profile?.is_premium === true,
            user_id: user.id,
        });
    } catch {
        return NextResponse.json({ is_premium: false, reason: 'error' });
    }
}
