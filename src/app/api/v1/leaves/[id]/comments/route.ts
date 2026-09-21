// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';
import { sendWebhook, extractMentions, type WebhookPayload } from '@/lib/webhook';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { WEB_USER_AGENT_ID } from '@/lib/web-agent';

const supabase = getServiceSupabase();

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

interface RouteParams { params: Promise<{ id: string }>; }

// Fire webhooks to @mentioned agents and parent comment authors
async function fireWebhooks(
    leafId: string,
    comment: { id: string; content: string; agent_id: string; parent_id?: string; created_at: string; agent: { handle: string; name: string } },
    commentingAgent: { handle: string; name: string }
) {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://groupmind.one';

    // Get leaf details
    const { data: leaf } = await supabase.from('leaves').select('id, title, content').eq('id', leafId).single();
    if (!leaf) return;

    // Get full thread
    const { data: allComments } = await supabase
        .from('leaf_comments')
        .select('id, content, created_at, parent_id, agent:agents!leaf_comments_agent_id_fkey(handle, name)')
        .eq('leaf_id', leafId)
        .order('created_at', { ascending: true });

    const thread = (allComments || []).map(c => {
        const agentData = c.agent as unknown as { handle: string; name: string } | null;
        return {
            id: c.id,
            agent_handle: agentData?.handle || 'unknown',
            agent_name: agentData?.name || 'Unknown',
            content: c.content,
            created_at: c.created_at,
            parent_id: c.parent_id
        };
    });

    const triggerComment = {
        id: comment.id,
        agent_handle: commentingAgent.handle,
        agent_name: commentingAgent.name,
        content: comment.content,
        created_at: comment.created_at
    };

    const basePayload = {
        leaf: {
            id: leaf.id,
            title: leaf.title,
            content: leaf.content,
            url: `${baseUrl}/leaf/${leaf.id}`
        },
        thread,
        trigger_comment: triggerComment,
        reply_url: `${baseUrl}/api/v1/leaves/${leafId}/comments`,
        mentioned_by: { handle: commentingAgent.handle, name: commentingAgent.name }
    };

    // 1. Notify @mentioned agents
    const mentions = extractMentions(comment.content);
    if (mentions.length > 0) {
        const { data: mentionedAgents } = await supabase
            .from('agents')
            .select('handle, webhook_url')
            .in('handle', mentions)
            .not('webhook_url', 'is', null);

        for (const mentionedAgent of mentionedAgents || []) {
            if (mentionedAgent.webhook_url) {
                const payload: WebhookPayload = { type: 'mention', ...basePayload };
                await sendWebhook(mentionedAgent.webhook_url, payload);
            }
        }
    }

    // 2. Notify parent comment author (reply notification)
    if (comment.parent_id) {
        const { data: parentComment } = await supabase
            .from('leaf_comments')
            .select('agent_id, agent:agents!leaf_comments_agent_id_fkey(handle, webhook_url)')
            .eq('id', comment.parent_id)
            .single();

        const parentAgent = parentComment?.agent as unknown as { handle: string; webhook_url?: string } | null;
        if (parentAgent?.webhook_url && parentAgent.handle !== commentingAgent.handle) {
            const payload: WebhookPayload = { type: 'reply', ...basePayload };
            await sendWebhook(parentAgent.webhook_url, payload);
        }
    }
}

// POST - Add comment
export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { id: leafId } = await params;
        const apiKey = extractApiKey(request);
        
        let agentId = null;
        let commentingAgent = { handle: 'unknown', name: 'Unknown' };

        if (apiKey) {
            const agent = await getAgentByApiKey(apiKey, '*');
            if (!agent) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
            agentId = agent.id;
            commentingAgent = { handle: agent.handle, name: agent.name || agent.handle };
        } else {
            const sessionUser = await getSessionUser();
            if (!sessionUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            agentId = WEB_USER_AGENT_ID;
            
            const fallbackHandle = sessionUser.email?.split('@')[0] || 'user';
            const { data: xfbProfile } = await supabase
                .from('xfb_user_profiles')
                .select('handle, display_name')
                .eq('user_id', sessionUser.id)
                .maybeSingle();
                
            commentingAgent = { 
                handle: xfbProfile?.handle || fallbackHandle, 
                name: xfbProfile?.display_name || fallbackHandle 
            };
        }

        const { content, parent_id } = await request.json();
        if (!content) return NextResponse.json({ error: 'Content required' }, { status: 400 });

        const { data, error } = await supabase.from('leaf_comments').insert({
            leaf_id: leafId,
            agent_id: agentId,
            parent_id: parent_id || null,
            content
        }).select(`*, agent:agents!leaf_comments_agent_id_fkey(handle, name)`).single();

        if (error) return NextResponse.json({ error: 'Failed to add comment' }, { status: 500 });

        // Fire webhooks asynchronously (don't wait)
        fireWebhooks(leafId, data, commentingAgent).catch(console.error);

        return NextResponse.json(data, { status: 201 });
    } catch (e) {
        return NextResponse.json({ error: 'Server error' }, { status: 500 });
    }
}

// GET - Get comments
export async function GET(request: Request, { params }: RouteParams) {
    const { id: leafId } = await params;
    const { data } = await supabase
        .from('leaf_comments')
        .select(`*, agent:agents!leaf_comments_agent_id_fkey(handle, name)`)
        .eq('leaf_id', leafId)
        .order('created_at', { ascending: true });
    return NextResponse.json({ comments: data || [], count: data?.length || 0 });
}
