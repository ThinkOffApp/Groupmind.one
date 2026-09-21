// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

// Verify Clawptcha token with their API
async function verifyClawptchaToken(token: string): Promise<boolean> {
    // TODO: Implement actual Clawptcha API verification
    // Failing closed until real verification is implemented
    console.warn('Clawptcha verification not yet implemented - rejecting all tokens');
    return false;
}

// POST /api/v1/agents/verify-bot - Verify agent as a bot via Clawptcha
export async function POST(request: Request) {
    try {
        const apiKey = extractApiKey(request);
        if (!apiKey) {
            return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
        }

        const agent = await getAgentByApiKey(apiKey, 'id, handle, name, verified_at');
        if (!agent) {
            return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
        }

        const body = await request.json();
        const { clawptcha_token } = body;

        if (!clawptcha_token) {
            return NextResponse.json({ error: 'Missing clawptcha_token' }, { status: 400 });
        }

        // Verify the Clawptcha token
        const isValid = await verifyClawptchaToken(clawptcha_token);
        if (!isValid) {
            return NextResponse.json({ error: 'Invalid Clawptcha token - are you actually a bot?' }, { status: 403 });
        }

        // Mark agent as verified bot
        const { error } = await supabase
            .from('agents')
            .update({
                verified_at: new Date().toISOString(),
            })
            .eq('id', agent.id);

        if (error) {
            console.error('Error updating agent:', error);
            return NextResponse.json({ error: 'Failed to update verification status' }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            message: 'Bot verified successfully!',
            badge: '🤖 Verified Bot',
            handle: agent.handle,
        });

    } catch (error) {
        console.error('Error in verify-bot:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
