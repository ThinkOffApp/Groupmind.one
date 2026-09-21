// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState, useRef, use } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import MarkdownMessage from '@/components/MarkdownMessage';

type Message = {
    id: string;
    from: string;
    from_name: string;
    to?: string;
    body: string;
    audio_url?: string | null;
    image_url?: string | null;
    file_url?: string | null;
    file_name?: string | null;
    file_size?: number | null;
    created_at: string;
    type: 'dm' | 'broadcast';
};

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DMPage({ params }: { params: Promise<{ handle: string }> }) {
    const { handle } = use(params);
    const { user, loading } = useAuth();
    const [messages, setMessages] = useState<Message[]>([]);
    const [newMessage, setNewMessage] = useState('');
    const [loadingMessages, setLoadingMessages] = useState(true);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState('');
    const [uploading, setUploading] = useState(false);
    const [recording, setRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const lastMessageIdRef = useRef<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const speechRecognitionRef = useRef<any>(null);
    const voiceTranscriptRef = useRef<string>('');
    const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);

    const targetHandle = handle.startsWith('@') ? handle : `@${handle}`;

    useEffect(() => {
        if (user) {
            loadMessages();
            const interval = setInterval(loadMessages, 5000);
            return () => clearInterval(interval);
        }
    }, [user, handle]);

    useEffect(() => {
        // Only react when a genuinely new message lands, not on every 5s poll
        // (each poll produces a fresh array). Autoscroll only when the reader
        // is already at the bottom, so it never fights scrolling through history.
        const el = scrollContainerRef.current;
        const lastId = messages[messages.length - 1]?.id ?? null;
        if (!el || lastId === lastMessageIdRef.current) return;
        const isFirstLoad = lastMessageIdRef.current === null;
        lastMessageIdRef.current = lastId;
        if (isFirstLoad) {
            el.scrollTop = el.scrollHeight;
            return;
        }
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
        if (nearBottom) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    const loadMessages = async () => {
        try {
            const res = await fetch('/api/v1/messages?limit=100');
            const data = await res.json();
            if (res.ok && data.messages) {
                // Filter to only show DMs between us and target
                const filtered = data.messages.filter((m: Message) =>
                    (m.from === targetHandle || m.to === targetHandle) && m.type === 'dm'
                );
                setMessages(filtered.reverse());
            }
        } catch (e) {
            console.error('Error loading messages:', e);
        }
        setLoadingMessages(false);
    };

    const sendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        const currentMessage = newMessage.trim();
        if (!currentMessage || sending) return;

        const tempId = `temp-${Date.now()}`;
        setNewMessage('');

        // Optimistic update
        setMessages(prev => [...prev, {
            id: tempId,
            from: targetHandle, // In this view, our messages appear on the right side based on targetHandle mismatch.
            from_name: 'You',
            body: currentMessage,
            created_at: new Date().toISOString(),
            type: 'dm'
        }]);

        try {
            fetch('/api/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: targetHandle,
                    body: currentMessage,
                }),
            }).then(async res => {
                if (res.ok) {
                    await loadMessages();
                } else {
                    setMessages(prev => prev.filter(m => m.id !== tempId));
                    setNewMessage(currentMessage);
                }
            }).catch(err => {
                console.error('Error sending message:', err);
                setMessages(prev => prev.filter(m => m.id !== tempId));
                setNewMessage(currentMessage);
            });
        } catch (e) {
            console.error('Synchronous error preparing message:', e);
        }
    };

    const sendAttachmentMessage = async (
        attachmentUrl: string,
        attachmentType: 'audio' | 'image' | 'file',
        fileMeta?: { name?: string; size?: number },
        transcript?: string,
    ) => {
        setSending(true);
        setSendError('');
        try {
            const fallbackBody = transcript
                ? `🎤 ${transcript}`
                : (attachmentType === 'audio' ? '🎧 Audio attachment'
                : attachmentType === 'image' ? '🖼️ Image attachment'
                : `📎 ${fileMeta?.name || 'File attachment'}`);
            const msgBody = newMessage.trim() || fallbackBody;

            const payload: Record<string, unknown> = {
                to: targetHandle,
                body: msgBody,
                ...(attachmentType === 'audio' ? { audio_url: attachmentUrl }
                    : attachmentType === 'image' ? { image_url: attachmentUrl }
                    : { file_url: attachmentUrl, file_name: fileMeta?.name, file_size: fileMeta?.size }),
            };

            const res = await fetch('/api/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (res.ok) {
                setNewMessage('');
                await loadMessages();
            } else {
                setSendError(data.error || `Failed to send ${attachmentType} attachment`);
            }
        } catch (e) {
            console.error(`Error sending ${attachmentType} attachment:`, e);
            setSendError(`Failed to send ${attachmentType} attachment`);
        } finally {
            setSending(false);
        }
    };

    const handleAttachmentSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
        // Several files at once: three photos of the same thing is the normal
        // case, and sending them one at a time loses the connection between
        // them. Each still becomes its own message — that is the data model —
        // but the picking and uploading happen in one go.
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (files.length === 0 || uploading) return;

        setUploading(true);
        setSendError('');
        try {
            // Sequential, not parallel: order is meaningful when someone sends
            // three angles of one cabinet, and parallel uploads arrive shuffled.
            for (const file of files) {
                const ok = await uploadAndSend(file);
                if (!ok) break; // stop on the first failure rather than spraying errors
            }
        } finally {
            setUploading(false);
        }
    };

    /** Upload one file and post it as a message. Returns false on failure. */
    const uploadAndSend = async (file: File, fileName?: string): Promise<boolean> => {
        try {
            const formData = new FormData();
            formData.append('file', file, fileName || file.name);
            const uploadRes = await fetch('/api/v1/upload', {
                method: 'POST',
                body: formData,
            });
            const uploadData = await uploadRes.json();
            if (!uploadRes.ok) {
                setSendError(uploadData.error || 'Upload failed');
                return false;
            }

            const attachmentType = uploadData.type === 'audio' ? 'audio'
                : uploadData.type === 'image' ? 'image'
                : 'file';
            await sendAttachmentMessage(uploadData.url, attachmentType, {
                name: uploadData.name || fileName || file.name,
                size: uploadData.size ?? file.size,
            });
            return true;
        } catch (err) {
            console.error('Attachment upload error:', err);
            setSendError('Failed to upload attachment');
            return false;
        }
    };

    const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const items = e.clipboardData?.items;
        if (!items || uploading) return;

        // Collect every pasted image before uploading any. The old loop read
        // `uploading` as its per-item guard, but that is React state and does
        // not change inside a running loop, so it never guarded anything — and
        // a `break` after the first image meant a multi-image paste silently
        // dropped the rest.
        const images: File[] = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                const blob = items[i].getAsFile();
                if (blob) images.push(blob);
            }
        }
        if (images.length === 0) return;

        setUploading(true);
        setSendError('');
        try {
            // Pasted blobs share the generic name the clipboard gives them, so
            // number them; two images pasted together would otherwise upload
            // under one filename.
            const stamp = Date.now();
            for (const [index, image] of images.entries()) {
                const ok = await uploadAndSend(image, `pasted-image-${stamp}-${index}.png`);
                if (!ok) break;
            }
        } finally {
            setUploading(false);
        }
    };

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mediaRecorder = new MediaRecorder(stream, {
                mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? 'audio/webm;codecs=opus'
                    : 'audio/webm',
            });
            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunksRef.current.push(e.data);
            };

            mediaRecorder.onstop = async () => {
                stream.getTracks().forEach(t => t.stop());
                if (recordingTimerRef.current) {
                    clearInterval(recordingTimerRef.current);
                    recordingTimerRef.current = null;
                }
                setRecordingDuration(0);

                const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                if (blob.size < 1000) {
                    setSendError('Recording too short');
                    return;
                }

                setUploading(true);
                setSendError('');
                try {
                    const formData = new FormData();
                    formData.append('file', blob, `voice-${Date.now()}.webm`);

                    const uploadRes = await fetch('/api/v1/upload', {
                        method: 'POST',
                        body: formData,
                    });
                    const uploadData = await uploadRes.json();
                    if (!uploadRes.ok) {
                        setSendError(uploadData.error || 'Upload failed');
                        return;
                    }
                    const transcript = voiceTranscriptRef.current.trim();
                    await sendAttachmentMessage(uploadData.url, 'audio', undefined, transcript || undefined);
                } catch (e) {
                    console.error('Error uploading voice:', e);
                    setSendError('Failed to upload voice message');
                } finally {
                    setUploading(false);
                }
            };

            // Start browser speech recognition if available
            const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
            if (SpeechRecognition) {
                const rec = new SpeechRecognition();
                rec.continuous = true;
                rec.interimResults = true;
                // Same fix as the room page: follow the speaker's browser language
                // rather than assuming American English (2026-08-20).
                rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
                rec.onresult = (e: any) => {
                    let text = '';
                    for (let i = e.resultIndex; i < e.results.length; i++) {
                        if (e.results[i].isFinal) {
                            text += e.results[i][0].transcript + ' ';
                        }
                    }
                    if (text) {
                        voiceTranscriptRef.current += text;
                    }
                };
                rec.onerror = (e: any) => {
                    console.error('Speech recognition error:', e.error);
                };
                speechRecognitionRef.current = rec;
                voiceTranscriptRef.current = '';
                rec.start();
            }

            mediaRecorder.start(250);
            setRecording(true);
            setRecordingDuration(0);
            recordingTimerRef.current = setInterval(() => {
                setRecordingDuration(d => d + 1);
            }, 1000);
        } catch (err: any) {
            console.error('Mic error:', err);
            setSendError(err.name === 'NotAllowedError' ? 'Microphone access denied' : 'Could not access microphone');
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
        if (speechRecognitionRef.current) {
            try {
                speechRecognitionRef.current.stop();
            } catch (e) {
                console.error('Error stopping speech recognition:', e);
            }
        }
        setRecording(false);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[50vh]">
                <div className="animate-spin w-8 h-8 border-2 border-[#55AA00] border-t-transparent rounded-full" />
            </div>
        );
    }

    if (!user) {
        return (
            <div className="text-center py-16">
                <p className="text-gray-500">Sign in to view messages.</p>
            </div>
        );
    }

    return (
        <div className="max-w-3xl mx-auto">
            {/* Header */}
            <div className="flex items-center gap-3 mb-4">
                <Link href="/messages" className="text-gray-400 hover:text-white">
                    ←
                </Link>
                <div className="w-10 h-10 bg-purple-800/50 rounded-full flex items-center justify-center text-lg">
                    🤖
                </div>
                <div>
                    <h1 className="text-xl font-bold">{targetHandle}</h1>
                    <p className="text-sm text-gray-500">Direct Message</p>
                </div>
            </div>

            {/* Messages Area */}
            <div className="bg-gray-900/50 border border-white/10 rounded-xl flex flex-col h-[70vh]">
                {/* Messages */}
                <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-3">
                    {loadingMessages ? (
                        <div className="flex items-center justify-center py-8">
                            <div className="animate-spin w-6 h-6 border-2 border-[#55AA00] border-t-transparent rounded-full" />
                        </div>
                    ) : messages.length === 0 ? (
                        <p className="text-gray-500 text-center py-8">
                            No messages yet. Start a conversation with {targetHandle}!
                        </p>
                    ) : (
                        messages.map(msg => {
                            const isFromTarget = msg.from === targetHandle;
                            return (
                                <div key={msg.id} className={`flex gap-3 ${isFromTarget ? '' : 'flex-row-reverse'}`}>
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0 ${isFromTarget ? 'bg-purple-800/50' : 'bg-pink-800/50'
                                        }`}>
                                        🤖
                                    </div>
                                    <div className={`max-w-[70%] ${isFromTarget ? '' : 'text-right'}`}>
                                        <div className={`inline-block px-4 py-2 rounded-2xl ${isFromTarget
                                            ? 'bg-gray-800 text-gray-300'
                                            : 'bg-[#55AA00] text-white'
                                            }`}>
                                            <MarkdownMessage body={msg.body} />
                                        </div>
                                        {msg.image_url && (
                                            <a
                                                href={msg.image_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className={`block mt-1.5 w-fit ${!isFromTarget ? 'ml-auto' : ''}`}
                                            >
                                                <img
                                                    src={msg.image_url}
                                                    alt="Image attachment"
                                                    className={`rounded-lg max-w-[320px] max-h-72 object-cover border transition-colors ${isFromTarget ? 'border-gray-700 hover:border-gray-500' : 'border-[#55AA00] hover:border-pink-300'}`}
                                                    onLoad={() => {
                                                        // Late-loading images grow the transcript under a
                                                        // bottom-pinned view; re-pin while still at the bottom.
                                                        const el = scrollContainerRef.current;
                                                        if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
                                                            el.scrollTop = el.scrollHeight;
                                                        }
                                                    }}
                                                />
                                            </a>
                                        )}
                                        {msg.audio_url && (
                                            <audio
                                                controls
                                                src={msg.audio_url}
                                                className={`mt-1.5 max-w-[280px] h-8 ${!isFromTarget ? 'ml-auto' : ''}`}
                                            />
                                        )}
                                        {msg.file_url && (
                                            <a
                                                href={msg.file_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                download={msg.file_name || true}
                                                className={`mt-1.5 flex w-fit max-w-[320px] items-center gap-2 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-gray-200 transition-colors hover:border-[#55AA00]/60 ${!isFromTarget ? 'ml-auto' : ''}`}
                                            >
                                                <span aria-hidden>📎</span>
                                                <span className="min-w-0 truncate">{msg.file_name || 'Attachment'}</span>
                                                {typeof msg.file_size === 'number' && (
                                                    <span className="shrink-0 text-xs text-gray-500">{formatFileSize(msg.file_size)}</span>
                                                )}
                                            </a>
                                        )}
                                        <p className="text-xs text-gray-500 mt-1">
                                            {new Date(msg.created_at).toLocaleTimeString()}
                                        </p>
                                    </div>
                                </div>
                            );
                        })
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <form onSubmit={sendMessage} className="p-4 border-t border-white/10">
                    <div className="flex gap-2 items-end">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="*/*"
                            multiple
                            className="hidden"
                            onChange={handleAttachmentSelected}
                            disabled={uploading || sending}
                        />
                        <textarea
                            value={newMessage}
                            onChange={(e) => setNewMessage(e.target.value)}
                            onPaste={handlePaste}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    if (newMessage.trim()) {
                                        sendMessage(e);
                                    }
                                }
                            }}
                            placeholder={`Message ${targetHandle}... (Shift+Enter for new line)`}
                            rows={1}
                            className="flex-1 px-4 py-2.5 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none resize-none min-h-[42px] max-h-32 overflow-y-auto"
                            style={{ fieldSizing: 'content' } as any}
                        />
                        <button
                            type="button"
                            disabled={uploading || sending}
                            onClick={() => fileInputRef.current?.click()}
                            className={`px-3 py-2.5 rounded-lg font-medium transition-all shrink-0 ${uploading || sending
                                ? 'bg-gray-700 text-gray-400'
                                : 'bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white'
                                }`}
                            title="Add image or audio attachment"
                        >
                            {uploading ? '⏳' : '+'}
                        </button>
                        <button
                            type="button"
                            disabled={uploading}
                            onClick={recording ? stopRecording : startRecording}
                            className={`px-3 py-2.5 rounded-lg font-medium transition-all shrink-0 ${recording
                                ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse'
                                : uploading
                                    ? 'bg-gray-700 text-gray-400'
                                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white'
                                }`}
                            title={recording ? `Recording... ${recordingDuration}s (click to stop)` : 'Record voice message'}
                        >
                            {uploading ? '⏳' : recording ? `🔴 ${recordingDuration}s` : '🎤'}
                        </button>
                        <button
                            type="submit"
                            disabled={sending || !newMessage.trim()}
                            className="px-6 py-2.5 bg-[#55AA00] hover:bg-[#99DD00] disabled:bg-gray-700 rounded-lg font-medium transition-colors shrink-0"
                        >
                            {sending ? '...' : 'Send'}
                        </button>
                    </div>
                    {sendError && (
                        <p className="text-red-400 text-sm mt-2">{sendError}</p>
                    )}
                </form>
            </div>
        </div>
    );
}
