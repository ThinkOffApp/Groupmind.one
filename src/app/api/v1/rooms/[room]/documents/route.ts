// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { WEB_USER_AGENT_ID } from '@/lib/web-agent';

const supabase = getServiceSupabase();

type RouteParams = { params: Promise<{ room: string }> };

export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug } = await params;

        // Find room by slug
        const { data: room } = await supabase
            .from('rooms')
            .select('id')
            .eq('slug', roomSlug)
            .single();

        if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

        // Find all document states for this room
        const { data: messages, error } = await supabase
            .from('messages')
            .select('id, body, created_at, metadata')
            .eq('room_id', room.id)
            .not('metadata', 'is', null)
            .contains('metadata', { is_document_state: true })
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Deduplicate: only keep the latest message for each document_id
        const docMap = new Map();

        // Handle legacy single documents without document_id by assigning them an ID
        let hasLegacyDoc = false;

        if (messages) {
            for (const msg of messages) {
                const docId = msg.metadata.document_id || 'default';
                if (!docMap.has(docId)) {
                    docMap.set(docId, {
                        id: docId,
                        title: msg.metadata.title || 'Scratchpad',
                        last_updated: msg.created_at,
                        preview: typeof msg.body === 'string' ? msg.body.substring(0, 50) + (msg.body.length > 50 ? '...' : '') : ''
                    });
                    if (docId === 'default') hasLegacyDoc = true;
                }
            }
        }

        // If a legacy document exists but isn't marked, it will be wrapped into "default"
        return NextResponse.json({
            documents: Array.from(docMap.values())
        });

    } catch (error) {
        console.error('Error fetching documents list:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug } = await params;
        const body = await request.json().catch(() => null);

        if (!body || !body.title) {
            return NextResponse.json({ error: 'Missing document title' }, { status: 400 });
        }

        const { data: room } = await supabase
            .from('rooms')
            .select('id')
            .eq('slug', roomSlug)
            .single();

        if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

        const newDocId = crypto.randomUUID();
        const initialContent = body.content || '';

        const { error: insertError } = await supabase
            .from('messages')
            .insert({
                room_id: room.id,
                from_agent_id: WEB_USER_AGENT_ID,
                body: initialContent,
                metadata: {
                    is_document_state: true,
                    document_id: newDocId,
                    title: body.title
                }
            });

        if (insertError) throw insertError;

        return NextResponse.json({
            success: true,
            document: {
                id: newDocId,
                title: body.title,
                content: initialContent
            }
        });
    } catch (error) {
        console.error('Error creating document:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
