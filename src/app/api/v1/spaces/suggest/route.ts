// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';

// POST /api/v1/spaces/suggest - Suggest a new terrain (goes to pending status)
// Private terrains are created directly (premium only, 1 per user)
export async function POST(request: NextRequest) {
    const supabase = getServiceSupabase();
    try {
        const body = await request.json();
        const { name, description, parent_id, is_public } = body;

        if (!name || !description) {
            return NextResponse.json(
                { error: 'Name and description are required' },
                { status: 400 }
            );
        }

        const wantsPrivate = is_public === false;

        // Private terrain: require auth + premium + limit 1
        let sessionUserId: string | null = null;
        if (wantsPrivate) {
            try {
                const serverClient = await createServerClient();
                const { data: { user } } = await serverClient.auth.getUser();
                if (!user) {
                    return NextResponse.json({ error: 'Sign in required for private terrains' }, { status: 401 });
                }
                sessionUserId = user.id;

                // Check premium
                const { data: profile } = await supabase
                    .from('xfb_user_profiles')
                    .select('is_premium')
                    .eq('id', user.id)
                    .single();

                if (!profile?.is_premium) {
                    return NextResponse.json(
                        { error: 'Private terrains are a Premium feature.' },
                        { status: 403 }
                    );
                }

                // Limit: 1 private terrain per user
                const { data: existing } = await supabase
                    .from('terrains')
                    .select('id')
                    .eq('is_public', false)
                    .eq('created_by', user.id);

                if ((existing || []).length >= 1) {
                    return NextResponse.json(
                        { error: 'Premium users can create 1 private terrain. You already have one.' },
                        { status: 403 }
                    );
                }
            } catch {
                return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
            }
        }

        // Generate slug from name
        const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        // Check if slug already exists
        const { data: existing } = await supabase
            .from('terrains')
            .select('id')
            .eq('slug', slug)
            .single();

        if (existing) {
            return NextResponse.json(
                { error: 'A terrain with this name already exists' },
                { status: 409 }
            );
        }

        // Insert terrain
        // Private terrains are created directly (active), public ones need review (pending)
        const { data, error } = await supabase
            .from('terrains')
            .insert({
                name,
                slug,
                description,
                parent_id: parent_id || null,
                status: wantsPrivate ? 'active' : 'pending',
                is_public: !wantsPrivate,
                ...(sessionUserId ? { created_by: sessionUserId } : {}),
            })
            .select()
            .single();

        if (error) {
            console.error('Error creating terrain suggestion:', error);
            return NextResponse.json(
                { error: 'Failed to submit suggestion' },
                { status: 500 }
            );
        }

        return NextResponse.json({
            message: wantsPrivate
                ? 'Private terrain created! Your data will be encrypted.'
                : 'Terrain suggestion submitted for review',
            terrain: data
        }, { status: 201 });

    } catch (error) {
        console.error('Error in terrain suggestion:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}

// GET /api/v1/spaces/suggest - Get pending terrain suggestions (admin only)
export async function GET(request: NextRequest) {
    const supabase = getServiceSupabase();
    try {
        const serverClient = await createServerClient();
        const { data: { user } } = await serverClient.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Check if user is admin
        const { data: profile } = await supabase
            .from('user_profiles')
            .select('role')
            .eq('user_id', user.id)
            .single();

        if (profile?.role !== 'admin') {
            return NextResponse.json({ error: 'Forbidden. Admin access required.' }, { status: 403 });
        }

        const { data, error } = await supabase
            .from('terrains')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });

        if (error) {
            return NextResponse.json(
                { error: 'Failed to fetch suggestions' },
                { status: 500 }
            );
        }

        return NextResponse.json({ suggestions: data });

    } catch (error) {
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
