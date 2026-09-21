// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase-browser';
import MarkdownMessage from '@/components/MarkdownMessage';

type ScratchpadProps = {
    roomSlug: string;
    roomId: string;
    documentId?: string;
    currentUser: { id: string; name: string } | null;
};

export default function Scratchpad({ roomSlug, roomId, documentId = 'default', currentUser }: ScratchpadProps) {
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const [activeTypers, setActiveTypers] = useState<Set<string>>(new Set());
    const [mode, setMode] = useState<'edit' | 'preview'>('edit');

    const supabase = createClient();
    const contentRef = useRef(content);
    const broadcastChannelRef = useRef<any>(null);
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const ignoreNextChangeRef = useRef(false);
    const receivedRealtimeDuringLoadRef = useRef(false);
    const lastSavedAtRef = useRef<Date | null>(null);

    const updateLastSaved = (date: Date | null) => {
        setLastSavedAt(date);
        lastSavedAtRef.current = date;
    };

    // Setup Realtime Broadcast channel and load initial state
    useEffect(() => {
        if (!roomId) return;

        receivedRealtimeDuringLoadRef.current = false;

        // 1. Subscribe instantly to avoid broadcast join-gap
        const channelName = `room_doc:${roomId}:${documentId}`;
        const channel = supabase.channel(channelName, {
            config: { broadcast: { self: false } }
        });

        channel
            .on('broadcast', { event: 'doc_update' }, (payload) => {
                receivedRealtimeDuringLoadRef.current = true;
                if (payload.payload.content !== undefined) {
                    ignoreNextChangeRef.current = true;
                    setContent(payload.payload.content);
                    contentRef.current = payload.payload.content;
                }
                if (payload.payload.typerName) {
                    setActiveTypers(prev => new Set(prev).add(payload.payload.typerName));
                    setTimeout(() => {
                        setActiveTypers(prev => {
                            const next = new Set(prev);
                            next.delete(payload.payload.typerName);
                            return next;
                        });
                    }, 2000);
                }
            })
            .on('broadcast', { event: 'sync_request' }, () => {
                if (contentRef.current.trim().length > 0) {
                    channel.send({
                        type: 'broadcast',
                        event: 'doc_update',
                        payload: { content: contentRef.current, typerName: null }
                    });
                }
            })
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'messages',
                    filter: `room_id=eq.${roomId}`
                },
                (payload) => {
                    const msg = payload.new as any;
                    // Auto-refresh when the scratchpad document state is updated via the API
                    if (msg && msg.metadata && msg.metadata.is_document_state) {
                        receivedRealtimeDuringLoadRef.current = true;
                        const msgDocId = msg.metadata.document_id || 'default';

                        if ((documentId === 'default' && msgDocId === 'default') ||
                            (documentId === msgDocId)) {
                            const nextContent = msg.body || '';
                            if (nextContent !== contentRef.current) {
                                setContent(nextContent);
                                contentRef.current = nextContent;
                            }
                            if (msg.created_at) {
                                updateLastSaved(new Date(msg.created_at));
                            }
                        }
                    }
                }
            )
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    channel.send({
                        type: 'broadcast',
                        event: 'sync_request',
                        payload: {}
                    });
                }
            });

        broadcastChannelRef.current = channel;

        // 2. Fetch document state from API
        const fetchDocument = async () => {
            setLoading(true);
            try {
                const endpoint = documentId === 'default'
                    ? `/api/v1/rooms/${roomSlug}/documents/default`
                    : `/api/v1/rooms/${roomSlug}/documents/${documentId}`;

                const res = await fetch(endpoint);
                if (res.ok) {
                    const data = await res.json();
                    // Only apply DB state if no keystrokes arrived while fetching
                    if (!receivedRealtimeDuringLoadRef.current && data.content !== undefined) {
                        setContent(data.content || '');
                        contentRef.current = data.content || '';
                        if (data.updated_at) {
                            updateLastSaved(new Date(data.updated_at));
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to load document:", e);
            } finally {
                setLoading(false);
            }
        };

        fetchDocument();

        return () => {
            if (broadcastChannelRef.current) {
                supabase.removeChannel(broadcastChannelRef.current);
            }
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
            if (typingTimeoutRef.current) {
                clearTimeout(typingTimeoutRef.current);
            }
        };
    }, [documentId, roomId, roomSlug]);

    // Debounced API save function
    const saveToDatabase = useCallback(async (textToSave: string) => {
        setSaving(true);
        try {
            const bodyPayload: any = { content: textToSave };
            if (lastSavedAtRef.current) {
                bodyPayload.last_saved_at = lastSavedAtRef.current.toISOString();
            }

            const endpoint = documentId === 'default'
                ? `/api/v1/rooms/${roomSlug}/documents/default`
                : `/api/v1/rooms/${roomSlug}/documents/${documentId}`;

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyPayload)
            });
            if (res.ok) {
                updateLastSaved(new Date());
            } else if (res.status === 409) {
                console.warn("Document conflict: another user saved a newer version.");
            }
        } catch (e) {
            console.error("Failed to save to database", e);
        } finally {
            setSaving(false);
        }
    }, [documentId, roomSlug]);

    const handleEmptyAndArchive = async () => {
        if (!contentRef.current.trim()) {
            alert('Document is already empty.');
            return;
        }

        if (!confirm('Archive this document and start an empty scratchpad?')) return;

        setSaving(true);
        try {
            const endpoint = documentId === 'default'
                ? `/api/v1/rooms/${roomSlug}/documents/default`
                : `/api/v1/rooms/${roomSlug}/documents/${documentId}`;

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: contentRef.current, action: 'archive_and_empty' })
            });
            if (res.ok) {
                setContent('');
                contentRef.current = '';
                // Broadcast empty state
                if (broadcastChannelRef.current) {
                    broadcastChannelRef.current.send({
                        type: 'broadcast',
                        event: 'doc_update',
                        payload: {
                            content: '',
                            typerName: currentUser?.name || 'Local User'
                        }
                    });
                }
                updateLastSaved(new Date());
            }
        } catch (e) {
            console.error("Failed to archive and empty", e);
        } finally {
            setSaving(false);
        }
    };

    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newText = e.target.value;

        if (ignoreNextChangeRef.current) {
            ignoreNextChangeRef.current = false;
            // Still update our local value, but don't broadcast it back as our own typing
            setContent(newText);
            contentRef.current = newText;
            return;
        }

        setContent(newText);
        contentRef.current = newText;

        // 1. Broadcast instantly to peers
        if (broadcastChannelRef.current) {
            broadcastChannelRef.current.send({
                type: 'broadcast',
                event: 'doc_update',
                payload: {
                    content: newText,
                    typerName: currentUser?.name || 'Local User'
                }
            });
        }

        // 2. Debounce Database Save (5 seconds of inactivity)
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = setTimeout(() => {
            saveToDatabase(newText);
        }, 5000);
    };

    if (loading) {
        return (
            <div className="flex-1 flex items-center justify-center bg-gray-900/50 border border-white/10 rounded-xl">
                <div className="animate-spin w-6 h-6 border-2 border-[#55AA00] border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col bg-gray-900/50 border border-white/10 rounded-xl overflow-hidden h-full">
            {/* Toolbar Area */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 bg-black/40">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[#99DD00]">📄 Scratchpad</span>
                    {activeTypers.size > 0 && (
                        <span className="text-xs text-[#FFDD00] animate-pulse bg-pink-900/40 px-2 py-0.5 rounded">
                            {Array.from(activeTypers).join(', ')} typing...
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex items-center bg-gray-900 rounded-md border border-white/10 p-0.5">
                        <button
                            onClick={() => setMode('edit')}
                            className={`text-xs px-2 py-1 rounded transition-colors ${mode === 'edit' ? 'bg-[#55AA00] text-white' : 'text-gray-400 hover:text-white'}`}
                        >
                            Edit
                        </button>
                        <button
                            onClick={() => setMode('preview')}
                            className={`text-xs px-2 py-1 rounded transition-colors ${mode === 'preview' ? 'bg-[#55AA00] text-white' : 'text-gray-400 hover:text-white'}`}
                        >
                            Preview
                        </button>
                    </div>
                    {/* A user asked what they are supposed to press when they have finished
                        writing. The answer is nothing - so the pad now says so itself
                        instead of leaving them hunting for a Done button. */}
                    {saving && <span className="text-xs text-gray-500 animate-pulse">Saving...</span>}
                    {lastSavedAt && !saving && (
                        <span className="text-xs text-gray-500">
                            Saved {lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                    )}
                    {!lastSavedAt && !saving && (
                        <span className="text-xs text-gray-500">Saves as you type</span>
                    )}
                    <button
                        onClick={handleEmptyAndArchive}
                        className="text-xs px-2 py-1 flex items-center gap-1 bg-red-900/30 hover:bg-red-800/50 text-red-200 border border-red-900/50 rounded transition-colors"
                        title="Archive this document and start a new, empty one. Nothing is deleted."
                    >
                        Archive &amp; new
                    </button>
                    <button
                        onClick={() => saveToDatabase(contentRef.current)}
                        className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
                        title="Force Save to Database Now"
                    >
                        Save
                    </button>
                </div>
            </div>

            {/* Text Editor Area */}
            {mode === 'edit' ? (
                <textarea
                    value={content}
                    onChange={handleTextChange}
                    placeholder="Start typing... Anyone in the room will see this in real-time."
                    className="flex-1 w-full bg-transparent resize-none p-4 text-gray-200 focus:outline-none font-mono text-sm leading-relaxed"
                    spellCheck={false}
                />
            ) : (
                <div className="flex-1 overflow-y-auto p-4">
                    {content.trim() ? (
                        <MarkdownMessage body={content} className="text-sm" />
                    ) : (
                        <p className="text-sm text-gray-500">Nothing to preview yet.</p>
                    )}
                </div>
            )}
        </div>
    );
}
