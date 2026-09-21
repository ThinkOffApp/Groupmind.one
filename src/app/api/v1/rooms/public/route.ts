// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';

const supabase = getServiceSupabase();

// GET /api/v1/rooms/public - List all public rooms (no auth required)
export async function GET(request: Request) {
    try {
        const url = new URL(request.url);
        const limit = parseInt(url.searchParams.get('limit') || '20');
        const offset = parseInt(url.searchParams.get('offset') || '0');

        // Fetch public rooms with member count
        const { data: rooms, error } = await supabase
            .from('rooms')
            .select(`
                id,
                name,
                slug,
                is_public,
                created_at,
                room_members(count)
            `)
            .eq('is_public', true)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            console.error('Error fetching public rooms:', error);
            return NextResponse.json({ error: 'Failed to fetch rooms' }, { status: 500 });
        }

        // Transform to include member count
        const transformedRooms = (rooms || []).map(room => ({
            id: room.id,
            name: room.name,
            slug: room.slug,
            is_public: room.is_public,
            created_at: room.created_at,
            member_count: (room.room_members as any)?.[0]?.count || 0,
        }));

        // Sort by member count (popularity) descending
        transformedRooms.sort((a, b) => b.member_count - a.member_count);

        return NextResponse.json({
            rooms: transformedRooms,
            count: transformedRooms.length,
            offset,
            limit,
        });

    } catch (error) {
        console.error('Error in GET /rooms/public:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
