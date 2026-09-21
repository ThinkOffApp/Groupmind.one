// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase-server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { joinDefaultRooms } from '@/lib/default-rooms';

const service = getServiceSupabase();

interface UnifiedProfile {
    id: string;
    user_id: string;
    handle: string;
    display_name: string | null;
    bio: string | null;
    location: string | null;
    website: string | null;
    avatar_url: string | null;
    banner_url: string | null;
    verified: boolean;
    followers_count: number;
    following_count: number;
    posts_count: number;
    created_at: string;
}

// Get authenticated user and Supabase client.
// 1) SSR cookie session (desktop web). 2) Authorization: Bearer <access_token>
// from the client session — some mobile browsers (notably Android Chrome) don't
// reliably round-trip the ~5KB chunked SSR auth cookie to the server, so cookie-only
// auth 401'd. The bearer token is validated with the service client and is
// cookie-independent. (A Supabase user JWT is not an xfb_ agent key, so this path
// only handles real user tokens.) When auth resolves via the bearer token there's
// no cookie-scoped client, so we return the service client; every query below is
// explicitly scoped by `.eq('user_id', user.id)` to the authenticated user's own rows.
async function getAuthenticatedClient(request?: Request) {
    try {
        const supabase = await createServerClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        if (!error && user) return { supabase, user };
    } catch {
        // fall through to bearer-token auth
    }
    try {
        const authz = request?.headers.get('authorization') || '';
        const token = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, '').trim() : '';
        if (token && !token.startsWith('xfb_')) {
            const { data: { user }, error } = await service.auth.getUser(token);
            if (!error && user) return { supabase: service, user };
        }
    } catch {
        // ignore
    }
    return { supabase: null, user: null };
}

// GET /api/v1/profile - Get current user's unified profile
export async function GET(request: Request) {
    try {
        const { supabase, user } = await getAuthenticatedClient(request);
        if (!supabase || !user) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Primary: Fetch from xfb_user_profiles (shared with xfor.bot)
        const { data: xfbProfile, error: xfbError } = await (supabase as any)
            .from('xfb_user_profiles')
            .select('*')
            .eq('user_id', user.id)
            .single();

        if (xfbProfile) {
            // Also sync to user_profiles for GroupMind messaging display
            await (supabase as any)
                .from('user_profiles')
                .upsert({
                    user_id: user.id,
                    display_name: xfbProfile.display_name,
                    handle: xfbProfile.handle,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'user_id' });

            return NextResponse.json({
                ...xfbProfile,
                email: user.email,
                source: 'xfb_user_profiles',
            });
        }

        // Fallback: Check user_profiles (GroupMind only users)
        const { data: profile, error: profileError } = await (supabase as any)
            .from('user_profiles')
            .select('*')
            .eq('user_id', user.id)
            .single();

        if (profile) {
            // Auto-create xfb_user_profiles for full profile functionality
            const { data: newXfb, error: xfbCreateError } = await (supabase as any)
                .from('xfb_user_profiles')
                .insert({
                    user_id: user.id,
                    handle: profile.handle || user.email?.split('@')[0]?.replace(/[^a-zA-Z0-9_]/g, '') || `user_${Date.now()}`,
                    display_name: profile.display_name || user.user_metadata?.full_name || null,
                    avatar_url: user.user_metadata?.avatar_url || null,
                })
                .select()
                .single();

            if (newXfb) {
                return NextResponse.json({
                    ...newXfb,
                    email: user.email,
                    source: 'auto_created_xfb',
                });
            }

            // If xfb creation failed (e.g. handle conflict), return user_profiles data
            return NextResponse.json({
                id: profile.id,
                user_id: profile.user_id,
                handle: profile.handle,
                display_name: profile.display_name,
                bio: null,
                location: null,
                website: null,
                avatar_url: user.user_metadata?.avatar_url || null,
                banner_url: null,
                verified: false,
                followers_count: 0,
                following_count: 0,
                posts_count: 0,
                created_at: profile.created_at,
                email: user.email,
                source: 'user_profiles',
            });
        }

        // No profile exists - create in both tables
        const defaultHandle = user.email?.split('@')[0]?.replace(/[^a-zA-Z0-9_]/g, '') || `user_${Date.now()}`;
        const defaultName = user.user_metadata?.full_name || null;

        // Create in user_profiles (GroupMind)
        const { error: createProfileError } = await (supabase as any)
            .from('user_profiles')
            .insert({
                user_id: user.id,
                display_name: defaultName,
                handle: defaultHandle,
            });

        // First provisioning for this account (web-only users hit ONLY this
        // path, never the relay routes): prejoin the default public rooms.
        // Gated on the insert succeeding — user_profiles.user_id is UNIQUE, so
        // concurrent first requests collapse to one prejoin. Uses the service
        // client because room_members writes are server-side (RLS-bypassing)
        // everywhere else too. Idempotent, never blocks the response.
        if (!createProfileError) {
            await joinDefaultRooms(service, user.id);
        }

        return NextResponse.json({
            user_id: user.id,
            handle: defaultHandle,
            display_name: defaultName,
            bio: null,
            location: null,
            website: null,
            avatar_url: user.user_metadata?.avatar_url || null,
            banner_url: null,
            verified: false,
            followers_count: 0,
            following_count: 0,
            posts_count: 0,
            email: user.email,
            source: 'new',
        });

    } catch (error) {
        console.error('Error in GET /profile:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// PUT /api/v1/profile - Update profile (syncs to both tables)
export async function PUT(request: Request) {
    try {
        const { supabase, user } = await getAuthenticatedClient(request);
        if (!supabase || !user) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const body = await request.json();
        const { display_name, handle, bio, location, website, avatar_url, banner_url } = body;

        // Validate handle if provided
        if (handle && !/^[a-zA-Z0-9_]+$/.test(handle)) {
            return NextResponse.json({ error: 'Handle can only contain letters, numbers, and underscores' }, { status: 400 });
        }

        // Check if xfb profile exists
        const { data: xfbExists } = await (supabase as any)
            .from('xfb_user_profiles')
            .select('id')
            .eq('user_id', user.id)
            .single();

        let updatedProfile = null;

        if (xfbExists) {
            // Update xfb_user_profiles
            const { data, error } = await (supabase as any)
                .from('xfb_user_profiles')
                .update({
                    display_name: display_name ?? undefined,
                    handle: handle ?? undefined,
                    bio: bio ?? undefined,
                    location: location ?? undefined,
                    website: website ?? undefined,
                    avatar_url: avatar_url ?? undefined,
                    banner_url: banner_url ?? undefined,
                })
                .eq('user_id', user.id)
                .select()
                .single();

            if (error) {
                if (error.code === '23505') {
                    return NextResponse.json({ error: 'Handle already taken' }, { status: 409 });
                }
                console.error('Error updating xfb profile:', error);
                return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 });
            }
            updatedProfile = data;
        }

        // Always sync to user_profiles for GroupMind
        const { error: syncError } = await (supabase as any)
            .from('user_profiles')
            .upsert({
                user_id: user.id,
                display_name: display_name || null,
                handle: handle || null,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });

        if (syncError) {
            console.error('Error syncing to user_profiles:', syncError);
        }

        return NextResponse.json({
            ...updatedProfile,
            email: user.email,
            synced: true,
        });

    } catch (error) {
        console.error('Error in PUT /profile:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
