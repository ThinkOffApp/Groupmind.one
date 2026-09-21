// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { WEB_USER_AGENT_ID } from '@/lib/web-agent';

const supabase = getServiceSupabase();

type RouteParams = { params: Promise<{ room: string, docId: string }> };

export async function GET(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug, docId } = await params;

        // Find room by slug
        const { data: room } = await supabase
            .from('rooms')
            .select('id')
            .eq('slug', roomSlug)
            .single();

        if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

        // Find the specific document state message
        // If docId is 'default', we look for documents without a document_id or matching 'default'
        let query = supabase
            .from('messages')
            .select('id, body, created_at, metadata')
            .eq('room_id', room.id)
            .not('metadata', 'is', null)
            .contains('metadata', { is_document_state: true })
            .order('created_at', { ascending: false });

        const { data: messages, error } = await query;

        if (error) throw error;

        let targetDoc = null;
        if (messages) {
            if (docId === 'default') {
                targetDoc = messages.find(m => !m.metadata.document_id || m.metadata.document_id === 'default');
            } else {
                targetDoc = messages.find(m => m.metadata.document_id === docId);
            }
        }

        // Cleanup duplicate states for exactly this docId if they exist
        if (messages && targetDoc) {
            const sameDocMessages = messages.filter(m =>
                (docId === 'default' && (!m.metadata.document_id || m.metadata.document_id === 'default')) ||
                (m.metadata.document_id === docId)
            );

            if (sameDocMessages.length > 1) {
                const idsToDelete = sameDocMessages.slice(1).map((m: any) => m.id);
                await supabase.from('messages').delete().in('id', idsToDelete);
            }
        }

        return NextResponse.json({
            content: targetDoc ? targetDoc.body : '',
            updated_at: targetDoc ? targetDoc.created_at : null
        });

    } catch (error) {
        console.error('Error fetching document:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug, docId } = await params;
        const body = await request.json().catch(() => null);

        if (!body || typeof body.content !== 'string') {
            return NextResponse.json({ error: 'Invalid document content' }, { status: 400 });
        }

        const { data: room } = await supabase
            .from('rooms')
            .select('id')
            .eq('slug', roomSlug)
            .single();

        if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

        // Find existing document states in the room
        const { data: existingDocs, error: findError } = await supabase
            .from('messages')
            .select('id, created_at, metadata')
            .eq('room_id', room.id)
            .not('metadata', 'is', null)
            .contains('metadata', { is_document_state: true })
            .order('created_at', { ascending: false });

        if (findError) throw findError;

        let existingDoc = null;
        let sameDocMessages: any[] = [];

        if (existingDocs) {
            sameDocMessages = existingDocs.filter(m =>
                (docId === 'default' && (!m.metadata.document_id || m.metadata.document_id === 'default')) ||
                (m.metadata.document_id === docId)
            );
            if (sameDocMessages.length > 0) {
                existingDoc = sameDocMessages[0];
            }
        }

        const existingDocId = existingDoc ? existingDoc.id : null;

        // Cleanup duplicate states for exactly this docId if they were created by concurrent inserts
        if (sameDocMessages.length > 1) {
            const idsToDelete = sameDocMessages.slice(1).map((m: any) => m.id);
            await supabase.from('messages').delete().in('id', idsToDelete);
        }

        // Version check to prevent lost-update races
        if (existingDoc && body.action !== 'archive_and_empty') {
            if (!body.last_saved_at) {
                // Require last_saved_at for updates to existing documents
                return NextResponse.json({ error: 'Conflict: must provide last_saved_at when updating an existing document. Read the document first to get its updated_at.' }, { status: 409 });
            }
            const dbTime = new Date(existingDoc.created_at).getTime();
            const clientTime = new Date(body.last_saved_at).getTime();
            if (dbTime > clientTime) {
                return NextResponse.json({ error: 'Conflict: Document was modified by someone else.' }, { status: 409 });
            }
        }

        if (body.action === 'archive_and_empty') {
            // Save current content as an archive
            const { error: archiveError } = await supabase
                .from('messages')
                .insert({
                    room_id: room.id,
                    from_agent_id: WEB_USER_AGENT_ID,
                    body: body.content || '(empty)',
                    metadata: {
                        is_document_archive: true,
                        document_id: docId
                    }
                });
            if (archiveError) throw archiveError;

            // Clear the live document state
            if (existingDocId) {
                const { error: clearError } = await supabase
                    .from('messages')
                    .update({ body: '' })
                    .eq('id', existingDocId);
                if (clearError) throw clearError;
            } else {
                const { error: clearError } = await supabase
                    .from('messages')
                    .insert({
                        room_id: room.id,
                        from_agent_id: WEB_USER_AGENT_ID,
                        body: '',
                        metadata: {
                            is_document_state: true,
                            document_id: docId !== 'default' ? docId : undefined
                        }
                    });
                if (clearError) throw clearError;
            }

            return NextResponse.json({ success: true, cleared: true });
        }

        // Normal save
        if (existingDocId) {
            const { error: updateError } = await supabase
                .from('messages')
                .update({ body: body.content, created_at: new Date().toISOString() })
                .eq('id', existingDocId);
            if (updateError) throw updateError;
        } else {
            const { error: insertError } = await supabase
                .from('messages')
                .insert({
                    room_id: room.id,
                    from_agent_id: WEB_USER_AGENT_ID, // Use system/web agent id to avoid breaking schema
                    body: body.content,
                    metadata: {
                        is_document_state: true,
                        document_id: docId !== 'default' ? docId : undefined
                    }
                });
            if (insertError) throw insertError;
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error saving document:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function DELETE(request: Request, { params }: RouteParams) {
    try {
        const { room: roomSlug, docId } = await params;

        if (docId === 'default') {
            return NextResponse.json({ error: 'Default scratchpad cannot be deleted' }, { status: 400 });
        }

        const { data: room } = await supabase
            .from('rooms')
            .select('id')
            .eq('slug', roomSlug)
            .single();

        if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

        const { error: deleteStateError } = await supabase
            .from('messages')
            .delete()
            .eq('room_id', room.id)
            .not('metadata', 'is', null)
            .contains('metadata', { is_document_state: true, document_id: docId });

        if (deleteStateError) throw deleteStateError;

        const { error: deleteArchiveError } = await supabase
            .from('messages')
            .delete()
            .eq('room_id', room.id)
            .not('metadata', 'is', null)
            .contains('metadata', { is_document_archive: true, document_id: docId });

        if (deleteArchiveError) throw deleteArchiveError;

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting document:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
