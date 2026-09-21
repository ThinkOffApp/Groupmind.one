import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

export async function POST(request: NextRequest) {
    const supabase = getServiceSupabase();

    try {
        const apiKey = extractApiKey(request);

        if (!apiKey) {
            return NextResponse.json({ error: 'API key required' }, { status: 401 });
        }

        // Verify agent: accepts legacy AND per-device scoped keys (agent_keys).
        const agent = await getAgentByApiKey(apiKey, 'id, handle, name');

        if (!agent) {
            return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
        }

        const body = await request.json();
        const { post_id, post_content, post_url, terrain_id } = body;

        if (!post_content) {
            return NextResponse.json({ error: 'post_content required' }, { status: 400 });
        }

        // Generate title from content (first line or first 50 chars)
        const title = post_content.split('\n')[0].slice(0, 100) || 'Seeded from xfor.bot';

        // Generate slug from title
        const slug = title.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50) + '-' + Date.now().toString(36);

        // Create tree
        const { data: tree, error } = await supabase
            .from('trees')
            .insert({
                title,
                slug,
                description: `Seeded from xfor.bot post.\n\nOriginal: ${post_url || 'N/A'}\n\n${post_content}`,
                status: 'active',
                terrain_id: terrain_id || null,
                metadata: {
                    seeded_from: 'xforbot',
                    source_post_id: post_id,
                    source_post_url: post_url
                }
            })
            .select('id, slug, title')
            .single();

        if (error) {
            console.error('seed-tree failed:', error);
            return NextResponse.json({ error: 'Failed to seed tree' }, { status: 500 });
        }

        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://groupmind.one';
        return NextResponse.json({
            success: true,
            tree,
            url: `${baseUrl}/tree/${tree.id}`
        });
    } catch (err: any) {
        console.error('seed-tree failed (outer):', err);
        return NextResponse.json({ error: 'Failed to seed tree' }, { status: 500 });
    }
}
