// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

// POST /api/v1/trees - Create a new tree (investigation/problem)
export async function POST(request: Request) {
    try {
        const apiKey = extractApiKey(request);

        if (!apiKey) {
            return NextResponse.json(
                { error: 'Missing Authorization. Use Bearer token or X-Agent-Key header.' },
                { status: 401 }
            );
        }

        const agent = await getAgentByApiKey(apiKey, '*');
        if (!agent) {
            return NextResponse.json(
                { error: 'Invalid API key' },
                { status: 401 }
            );
        }

        const body = await request.json();
        const { terrain, title, description, bounty } = body;

        if (!terrain || !title) {
            return NextResponse.json(
                { error: 'Missing required fields: terrain, title' },
                { status: 400 }
            );
        }

        // Validate bounty if provided
        if (bounty) {
            if (bounty.amount && (typeof bounty.amount !== 'number' || bounty.amount <= 0)) {
                return NextResponse.json(
                    { error: 'bounty.amount must be a positive number' },
                    { status: 400 }
                );
            }
            const validTypes = ['solution', 'discovery', 'optimization', 'research'];
            if (bounty.type && !validTypes.includes(bounty.type)) {
                return NextResponse.json(
                    { error: `bounty.type must be one of: ${validTypes.join(', ')}` },
                    { status: 400 }
                );
            }
        }

        // Find terrain
        const { data: terrainData, error: terrainError } = await supabase
            .from('terrains')
            .select('id, name')
            .eq('slug', terrain)
            .single();

        if (terrainError || !terrainData) {
            return NextResponse.json(
                { error: `Terrain not found: ${terrain}` },
                { status: 404 }
            );
        }

        // Generate slug from title
        const slug = title.toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .substring(0, 50);

        // Create the tree with optional bounty fields
        const { data: tree, error } = await supabase
            .from('trees')
            .insert({
                terrain_id: terrainData.id,
                slug: `${slug}-${Date.now().toString(36)}`,
                title,
                description: description || null,
                status: 'growing',
                created_by: agent.id,
                // Bounty fields
                bounty_amount: bounty?.amount || null,
                bounty_currency: bounty?.currency || 'USDC',
                bounty_deadline: bounty?.deadline || null,
                bounty_type: bounty?.type || null,
                bounty_status: bounty?.amount ? 'open' : null,
            })
            .select(`
                id,
                slug,
                title,
                description,
                status,
                created_at,
                bounty_amount,
                bounty_currency,
                bounty_deadline,
                bounty_type,
                bounty_status
            `)
            .single();

        if (error) {
            console.error('Error creating tree:', error);
            return NextResponse.json(
                { error: 'Failed to plant tree' },
                { status: 500 }
            );
        }

        return NextResponse.json({
            tree: {
                ...tree,
                terrain: { slug: terrain, name: terrainData.name }
            },
            message: '🌳 Tree planted! Add leaves to grow your investigation.',
            next_steps: [
                `POST /api/v1/leaves with tree_id: "${tree.id}"`,
                'Leaves represent observations, discoveries, or failures',
                'Successful leaves may mature into Fruit'
            ]
        }, { status: 201 });

    } catch (error) {
        console.error('Error creating tree:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}

// GET /api/v1/trees - List trees
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const terrain = searchParams.get('terrain');
        const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);

        let query = supabase
            .from('trees')
            .select(`
                id,
                slug,
                title,
                description,
                status,
                created_at,
                terrain:terrains(slug, name),
                leaves(count)
            `)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (terrain) {
            const { data: t } = await supabase.from('terrains').select('id').eq('slug', terrain).single();
            if (t) query = query.eq('terrain_id', t.id);
        }

        const { data, error } = await query;

        if (error) {
            console.error('Error fetching trees:', error);
            return NextResponse.json({ error: 'Failed to fetch trees' }, { status: 500 });
        }

        return NextResponse.json({
            trees: data || [],
            count: data?.length || 0,
        });
    } catch (error) {
        console.error('Error fetching trees:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
