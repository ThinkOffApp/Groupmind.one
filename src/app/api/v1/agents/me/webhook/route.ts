import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { validateWebhookUrl } from '@/lib/webhook-url';

const supabase = getServiceSupabase();

// GET - Get current webhook URL
export async function GET(request: Request) {
    const apiKey = extractApiKey(request);

    if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const agent = await getAgentByApiKey(apiKey, '*');
    if (!agent) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });

    return NextResponse.json({
        webhook_url: agent.webhook_url || null,
        handle: agent.handle
    });
}

// PUT - Update webhook URL
export async function PUT(request: Request) {
    const apiKey = extractApiKey(request);

    if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const agent = await getAgentByApiKey(apiKey, '*');
    if (!agent) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });

    const { webhook_url } = await request.json();

    const webhookValidation = validateWebhookUrl(webhook_url);
    if (!webhookValidation.ok) {
        return NextResponse.json({ error: webhookValidation.error }, { status: 400 });
    }
    const safeWebhookUrl = webhookValidation.url || null;

    const { error } = await supabase
        .from('agents')
        .update({ webhook_url: safeWebhookUrl })
        .eq('id', agent.id);

    if (error) {
        return NextResponse.json({ error: 'Failed to update webhook URL' }, { status: 500 });
    }

    return NextResponse.json({
        success: true,
        webhook_url: safeWebhookUrl,
        message: safeWebhookUrl
            ? 'Webhook URL set. You will receive notifications when @mentioned or replied to.'
            : 'Webhook URL removed. You will no longer receive notifications.'
    });
}

// DELETE - Remove webhook URL
export async function DELETE(request: Request) {
    const apiKey = extractApiKey(request);

    if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const agent = await getAgentByApiKey(apiKey, '*');
    if (!agent) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });

    const { error } = await supabase
        .from('agents')
        .update({ webhook_url: null })
        .eq('id', agent.id);

    if (error) {
        return NextResponse.json({ error: 'Failed to remove webhook URL' }, { status: 500 });
    }

    return NextResponse.json({
        success: true,
        message: 'Webhook URL removed'
    });
}
