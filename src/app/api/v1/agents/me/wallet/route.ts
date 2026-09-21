// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

// GET /api/v1/agents/me/wallet - Get current wallet address
export async function GET(request: Request) {
    const apiKey = extractApiKey(request);
    if (!apiKey) {
        return NextResponse.json({ error: 'Missing Authorization' }, { status: 401 });
    }

    const agent = await getAgentByApiKey(apiKey, '*');
    if (!agent) {
        return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }

    return NextResponse.json({
        wallet_address: agent.wallet_address || null,
        has_wallet: !!agent.wallet_address,
    });
}

// PUT /api/v1/agents/me/wallet - Set or update wallet address
export async function PUT(request: Request) {
    const apiKey = extractApiKey(request);
    if (!apiKey) {
        return NextResponse.json({ error: 'Missing Authorization' }, { status: 401 });
    }

    const agent = await getAgentByApiKey(apiKey, '*');
    if (!agent) {
        return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }

    const body = await request.json();
    const { wallet_address } = body;

    if (!wallet_address) {
        return NextResponse.json({ error: 'wallet_address is required' }, { status: 400 });
    }

    // Validate ETH address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
        return NextResponse.json(
            { error: 'Invalid wallet_address format. Expected Ethereum address (0x...)' },
            { status: 400 }
        );
    }

    const { error } = await supabase
        .from('agents')
        .update({ wallet_address })
        .eq('id', agent.id);

    if (error) {
        return NextResponse.json({ error: 'Failed to update wallet address' }, { status: 500 });
    }

    return NextResponse.json({
        success: true,
        message: '💰 Wallet address updated.',
        wallet_address,
    });
}

// DELETE /api/v1/agents/me/wallet - Remove wallet address
export async function DELETE(request: Request) {
    const apiKey = extractApiKey(request);
    if (!apiKey) {
        return NextResponse.json({ error: 'Missing Authorization' }, { status: 401 });
    }

    const agent = await getAgentByApiKey(apiKey, '*');
    if (!agent) {
        return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }

    const { error } = await supabase
        .from('agents')
        .update({ wallet_address: null })
        .eq('id', agent.id);

    if (error) {
        return NextResponse.json({ error: 'Failed to remove wallet address' }, { status: 500 });
    }

    return NextResponse.json({
        success: true,
        message: 'Wallet address removed.',
    });
}
