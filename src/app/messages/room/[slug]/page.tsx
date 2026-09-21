'use client';

import { useEffect, useLayoutEffect, useMemo, useState, useRef, use } from 'react';
import { isAddressedTo, normalizeHandle, pickAdjacentAnchor, stepFromAnchorId } from '@/lib/mentions';
import { intentActionCommand } from '@/lib/intent-action-command';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '@/components/AuthProvider';
import MarkdownMessage from '@/components/MarkdownMessage';

// Convert URLs in text to clickable links
function linkify(text: string) {
    const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
    if (parts.length === 1) return text;
    return parts.map((part, i) =>
        part.match(/^https?:\/\//) ? (
            <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-[#99DD00] hover:text-[#FFDD00] underline">
                {part}
            </a>
        ) : part
    );
}
import { createClient } from '@/lib/supabase-browser';
import { computeShellHeight, nextShellHeight, pushShellHeight } from '@/lib/shell-height';
import dynamic from 'next/dynamic';

const GatherView = dynamic(() => import('@/components/GatherView'), { ssr: false });
const VoiceCallPanel = dynamic(() => import('@/components/VoiceCallPanel').then(m => ({ default: m.VoiceCallPanel })), { ssr: false });
const Scratchpad = dynamic(() => import('@/components/Scratchpad'), { ssr: false });

type Message = {
    id: string;
    from: string;
    from_name: string;
    body: string;
    audio_url?: string | null;
    image_url?: string | null;
    file_url?: string | null;
    file_name?: string | null;
    file_size?: number | null;
    created_at: string;
    avatar_url?: string | null;
    isHuman?: boolean;
    reactions?: Record<string, string[]>;
    reply_to?: { id: string; from: string; body: string } | null;
    // Inline action buttons (Approve/Deny on confirmation requests).
    actions?: string[] | null;
    intent_id?: string | null;
};

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🔥', '👀', '🎉'];

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Room = {
    id: string;
    name: string;
    slug: string;
    is_public: boolean;
};

type Member = {
    handle: string;
    name: string;
    isHuman?: boolean;
    avatar_url?: string | null;
};

type Document = {
    id: string;
    title: string;
    last_updated?: string;
    preview?: string;
};

const ROOM_SEEN_KEY_PREFIX = 'antfarm:room-last-seen:';
const DESKTOP_NOTIFY_KEY = 'antfarm:desktop-notify';

export default function RoomPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = use(params);
    const { user, loading, session: authSession } = useAuth();
    const [room, setRoom] = useState<Room | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [members, setMembers] = useState<Member[]>([]);
    const [documents, setDocuments] = useState<Document[]>([]);
    const [activeDocumentId, setActiveDocumentId] = useState<string>('default');
    const [creatingDoc, setCreatingDoc] = useState(false);
    const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
    const [newMessage, setNewMessage] = useState('');
    const [loadingRoom, setLoadingRoom] = useState(true);
    const [initialDataPending, setInitialDataPending] = useState(true);
    const [error, setError] = useState('');
    const [sendError, setSendError] = useState('');
    const [sending, setSending] = useState(false);
    const [viewMode, setViewMode] = useState<'chat' | 'gather' | 'scratchpad'>('chat');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    // A callback ref, not useRef: this component returns a loading skeleton first
    // (see the `loading || (loadingRoom && !room)` branch below), so at mount the
    // shell does not exist yet. A useRef + [] effect read null, bailed, and never
    // ran again - which is why the measured height silently never applied on the
    // live page even though the code shipped. A callback ref fires when the node
    // actually attaches, whenever that turns out to be.
    const [shellEl, setShellEl] = useState<HTMLDivElement | null>(null);
    const [shellHeight, setShellHeight] = useState<number | null>(null);
    // The last few heights actually committed, newest last, and the viewport
    // they were measured against. nextShellHeight() needs them to recognise a
    // two-value cycle; the viewport is what tells it when that memory has gone
    // stale. Refs rather than state: reading them must not re-run the effect,
    // and writing them must not re-render.
    const shellHeightRef = useRef<number | null>(null);
    const shellHistoryRef = useRef<number[]>([]);
    const shellViewportRef = useRef<string>('');

    // The chat column used to be sized 100dvh minus a fixed rem guess for the
    // surrounding chrome, and the guess was wrong: it never counted the site
    // footer's own 3rem top margin, so the document came out taller than the
    // viewport, the body scrolled, and the composer rode away with it. This was
    // reported twice (2026-07-20 on a phone, 2026-08-18 on desktop). The
    // first report was patched by pinning the composer on mobile, which treated
    // the symptom and left the same fault live everywhere else.
    //
    // So measure rather than guess: take the distance from this container's top
    // to the top of the document, plus whatever the page renders below it, and
    // give the container exactly the viewport that is left.
    //
    // The comment that used to end here claimed the measured value "does not
    // depend on the container's own height, so applying it does not change it -
    // it settles in one pass instead of oscillating". That was the intent, and
    // it was wrong in fact: the `below` term could be derived from
    // documentElement.scrollHeight, which counts this column's own overflow, so
    // applying a height changed the next measurement. Reported live on
    // 2026-09-20 ("if i make it any larger start shaking") and measured on
    // groupmind.one: at every width from 1024px up the column flipped
    // 620 -> 617 -> 620 -> 617, once per frame, forever.
    //
    // Three things keep it settled now, because the loop had three separate
    // ways to stay alive:
    //   1. `below` is measured from the boxes of the elements that actually
    //      render after <main>, never from scrollHeight, so the column's own
    //      height is no longer an input to its own measurement;
    //   2. every candidate height goes through nextShellHeight() (see
    //      src/lib/shell-height.ts), which refuses a value within a pixel or
    //      two of the current one and refuses to flip back to the value held
    //      before it;
    //   3. observer callbacks are batched into one measure per animation frame.
    // The observers themselves are all still here. Each one is the fix for a
    // reported bug, named at its own site below; removing one brings that bug
    // back. The loop belonged to the decision, not to the observation.
    useLayoutEffect(() => {
        const el = shellEl;
        if (!el) return;
        // A different shell node means a different layout to measure, so the
        // cycle memory from the previous one says nothing about this one.
        shellHistoryRef.current = [];
        shellViewportRef.current = '';
        // The site footer carries mt-12. On a full-height view that reads as dead
        // space under the composer (a user reported: "put it down a bit, there
        // is lots of empty space between input and footer"), and it cannot be
        // absorbed from inside: body is min-h-screen flex, so shrinking the gap
        // just hands the slack to <main> instead. Drop it while a room is open,
        // and put it back on the way out so every other page keeps it.
        const footer = document.querySelector('footer');
        const footerMarginTop = footer ? footer.style.marginTop : '';
        if (footer) footer.style.marginTop = '0px';
        const measure = () => {
            // A real change to the viewport invalidates the cycle memory. The
            // cycle detector is a statement about repeated measurements taken
            // with the SAME inputs; once the window itself moves, a repeated
            // value is a coincidence and must not be mistaken for a flip-flop.
            const viewport = `${window.innerWidth}x${window.innerHeight}`;
            if (viewport !== shellViewportRef.current) {
                shellViewportRef.current = viewport;
                shellHistoryRef.current = shellHeightRef.current === null ? [] : [shellHeightRef.current];
            }
            const docTop = el.getBoundingClientRect().top + window.scrollY;
            // Measure against what renders AFTER <main>, not against the raw
            // document height. <main> is flex-1 inside a min-h-screen body, so it
            // stretches to absorb any slack - counting that stretch as content
            // subtracts space that only exists because it was subtracted, and the
            // column settles one footer-margin short of the bottom every time.
            const main = el.closest('main');
            // Measure "what renders below" from the boxes of the elements that
            // render after <main>, never from scrollHeight: scrollHeight also
            // counts anything overflowing THIS column (a sidebar list taller
            // than the shell), and subtracting that shrinks the column, which
            // shrinks nothing that overflows, so the next measure subtracts even
            // more - straight to the 320 floor. Reproduced 2026-09-01 on
            // production: 15 scratchpads in the sidebar, one resize -> 320 px,
            // "It's unusable".
            //
            // This used to read "from the footer's own box", with scrollHeight
            // as the fallback when there was no footer. That fallback was not a
            // theoretical branch: SiteFooter renders nothing for a CodeWatch
            // visitor on a /messages route, which is exactly how the bug was
            // reported, so the guarded-against expression was the one running on
            // the reporter's screen. It made the column's own 3px of overflow
            // look like 3px of content below it, and the column chased itself.
            // A footer, when there is one, is simply one of these siblings.
            const mainBottom = main
                ? main.getBoundingClientRect().bottom + window.scrollY
                : docTop + el.offsetHeight;
            let below = 0;
            for (let node = main?.nextElementSibling ?? null; node; node = node.nextElementSibling) {
                const rect = node.getBoundingClientRect();
                // Scripts and other non-rendered nodes measure 0x0 at the origin;
                // they are not "content below" anything.
                if (rect.width === 0 && rect.height === 0) continue;
                below = Math.max(below, rect.bottom + window.scrollY - mainBottom);
            }
            below = Math.max(0, below);
            // Floor it: a very short viewport, or chrome taller than the screen,
            // should leave a usable transcript and let the page scroll again,
            // rather than collapse the column to nothing.
            const computed = computeShellHeight(window.innerHeight, docTop, below);
            const decision = nextShellHeight(shellHeightRef.current, computed, shellHistoryRef.current);
            if (decision.height === null) return;
            shellHeightRef.current = decision.height;
            shellHistoryRef.current = pushShellHeight(shellHistoryRef.current, decision.height);
            setShellHeight(decision.height);
        };
        // Batch: a burst of observer callbacks in one frame collapses into a
        // single measure. Without this, the document observer, the sibling
        // observer and the resize listener could each run the same measurement
        // against the same layout, and the extra passes were what Chrome
        // reported as "ResizeObserver loop completed with undelivered
        // notifications".
        let frame: number | null = null;
        const schedule = () => {
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                measure();
            });
        };
        measure();
        // Fires when the header wraps, the invite QR opens, or the mobile URL bar
        // resizes the viewport - every case where the old constant went stale.
        //
        // It still watches the whole document, deliberately. The column's own
        // height is part of what it watches, which is what made the loop
        // possible - but all three bugs above were "we did not notice a case"
        // bugs, and narrowing this target is precisely how you fail to notice
        // the next one. The feedback is cut where the decision is made instead,
        // by nextShellHeight(), which can tell a real change from a flip-flop;
        // an observer cannot.
        const ro = new ResizeObserver(schedule);
        ro.observe(document.documentElement);
        window.addEventListener('resize', schedule);
        // The document observer is blind to one case: something above the column
        // (the search panel) growing or going away. The column gives back exactly
        // what the panel takes, so the document height never moves and no
        // re-measure fires - and the measure that DID run, mid-transition, had
        // the wrong docTop. Every search open/close then took another panel
        // height off the column: 489 -> 401 px per cycle, down to the 320 floor
        // (a user reported: "leaves lots of black"). Watch the column's
        // siblings directly, and re-attach whenever one mounts or unmounts.
        const siblingRo = new ResizeObserver(schedule);
        const watchSiblings = () => {
            siblingRo.disconnect();
            const parent = el.parentElement;
            if (!parent) return;
            for (const child of Array.from(parent.children)) {
                if (child !== el) siblingRo.observe(child);
            }
            schedule();
        };
        watchSiblings();
        const mo = new MutationObserver(watchSiblings);
        if (el.parentElement) mo.observe(el.parentElement, { childList: true });
        return () => {
            if (frame !== null) cancelAnimationFrame(frame);
            ro.disconnect();
            siblingRo.disconnect();
            mo.disconnect();
            window.removeEventListener('resize', schedule);
            if (footer) footer.style.marginTop = footerMarginTop;
        };
    }, [shellEl]);
    // Set on initial load to the id of the oldest unread message (i.e. the
    // first message whose created_at is greater than the persisted
    // last-seen timestamp for this room). When non-null, the render adds
    // an "unread" divider above that message and the load handler scrolls
    // the divider into view instead of snapping to bottom. Null when
    // everything visible is already read, in which case the bottom-scroll
    // path runs as before.
    const firstUnreadIdRef = useRef<string | null>(null);
    const [recording, setRecording] = useState(false);
    const [recordingDuration, setRecordingDuration] = useState(0);
    const [uploading, setUploading] = useState(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const speechRecognitionRef = useRef<any>(null);
    const voiceTranscriptRef = useRef<string>('');
    const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
    const supabase = useMemo(() => createClient(), []);
    // fetch() that attaches the Supabase access token as a Bearer header. Needed
    // because some mobile browsers (Android Chrome) don't reliably round-trip the
    // ~5KB chunked SSR auth cookie to the server, so cookie-only requests 401'd and
    // rooms wouldn't open / messages wouldn't send. The token is cookie-independent.
    const apiFetch = async (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers || {});
        let token = authSession?.access_token;
        if (!token) {
            try {
                const { data: { session } } = await supabase.auth.getSession();
                token = session?.access_token;
            } catch { /* fall through to cookie auth */ }
        }
        if (token && !headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${token}`);
        }
        return fetch(url, { ...init, headers });
    };
    const [replyingTo, setReplyingTo] = useState<Message | null>(null);
    const [forwardingMsg, setForwardingMsg] = useState<Message | null>(null);
    const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
    const [forwardRooms, setForwardRooms] = useState<Room[]>([]);
    const [emojiPickerForMsg, setEmojiPickerForMsg] = useState<string | null>(null);
    const [showInviteCode, setShowInviteCode] = useState(false);
    const [inviteCopied, setInviteCopied] = useState(false);
    // --- room search. The API has existed since #112; this is the box to type in.
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [searchResults, setSearchResults] = useState<
        { id: string; from: string; from_name: string | null; body: string; created_at: string }[] | null
    >(null);
    const [searchMeta, setSearchMeta] = useState<{ scanned: number; truncated: boolean; days: number } | null>(null);
    const [inviteCode, setInviteCode] = useState<string | null>(null);
    const [inviteCodeLoading, setInviteCodeLoading] = useState(false);
    const runSearch = async (q: string) => {
        const term = q.trim();
        if (!term) return;
        setSearchLoading(true);
        setSearchError(null);
        try {
            const res = await apiFetch(
                `/api/v1/rooms/${encodeURIComponent(slug)}/messages/search?q=${encodeURIComponent(term)}&limit=50&days=3650`,
                { cache: 'no-store' }
            );
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Search failed');
            setSearchResults(data.messages || []);
            setSearchMeta({ scanned: data.scanned ?? 0, truncated: !!data.truncated, days: data.days ?? 0 });
        } catch (e) {
            setSearchError(e instanceof Error ? e.message : 'Search failed');
            setSearchResults(null);
            setSearchMeta(null);
        } finally {
            setSearchLoading(false);
        }
    };

    const inviteJoinUrl = useMemo(() => {
        if (!room || !inviteCode) return '';
        const params = new URLSearchParams({ room: slug });
        // The invite has to point at THIS instance, not at whichever host the
        // code was first written for. window.location.origin is the address the
        // inviter is already looking at, so it is the one their guest can reach.
        const origin = typeof window !== 'undefined'
            ? window.location.origin
            : (process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://groupmind.one');
        return `${origin}/join/${encodeURIComponent(inviteCode)}?${params.toString()}`;
    }, [room, slug, inviteCode]);
    const [currentUserIdentity, setCurrentUserIdentity] = useState<{ handle: string; name: string } | null>(null);
    // "Mentions" toggle: show only messages that mention me, reply to me, or
    // are mine. Born from an agent flood (a user reported: "I'm trying to
    // read replies to me but the whole groupmind is full").
    const [mentionsOnly, setMentionsOnly] = useState(false);
    const [findingMine, setFindingMine] = useState(false);
    // Which "for me" message the arrows last landed on. An id, not an index,
    // so a message arriving mid-read cannot shift it.
    const mentionCursorRef = useRef<string | null>(null);
    // The row a smooth scroll is still travelling towards. Two arrow presses in
    // quick succession are normal, and during the animation the target is still
    // far from the centre -- without this the distance guard below would throw
    // the cursor away mid-flight and the second press would start over from
    // wherever the animation had reached (@codexmb).
    const mentionPendingRef = useRef<string | null>(null);
    // The cursor must not outlive the reading position it describes (@codexmb).
    // Two independent guards, because neither covers the other:
    //   - real user input (wheel/touch/keyboard) clears it IMMEDIATELY, even
    //     while our own smooth scroll is still running. A time window could not
    //     do that: a flick 200ms after an arrow press is a real interruption,
    //     and waiting it out is exactly the stale anchor we are avoiding.
    //   - dragging the scrollbar produces none of those events, so every press
    //     also checks the remembered row is still near the viewport centre and
    //     falls back to geometry when it is not.
    const myHandle = useMemo(
        () => normalizeHandle(currentUserIdentity?.handle || user?.email?.split('@')[0] || ''),
        [currentUserIdentity, user],
    );
    const visibleMessages = useMemo(
        () => (mentionsOnly && myHandle ? messages.filter(m => isAddressedTo(m, myHandle)) : messages),
        [messages, mentionsOnly, myHandle],
    );
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const privateRoomRefreshTimeoutRef = useRef<number | null>(null);

    // Split-pane Resizing State
    const [docWidth, setDocWidth] = useState(700); // Larger default
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, width: 0 });
    const activeDocumentTitle = documents.find(d => d.id === activeDocumentId)?.title;
    const isSidePaneOpen = viewMode === 'scratchpad' || viewMode === 'gather';

    const handleMouseDown = (e: React.MouseEvent) => {
        setIsDragging(true);
        setDragStart({ x: e.clientX, width: docWidth });
    };

    useEffect(() => {
        if (!isDragging) return;
        const handleMouseMove = (e: MouseEvent) => {
            const deltaX = dragStart.x - e.clientX;
            const newWidth = Math.max(300, Math.min(window.innerWidth - 400, dragStart.width + deltaX));
            setDocWidth(newWidth);
        };
        const handleMouseUp = () => {
            setIsDragging(false);
        };
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, dragStart]);

    const markRoomSeen = (timestamp?: string | null) => {
        if (typeof window === 'undefined') return;
        const seenAt = timestamp || new Date().toISOString();
        try {
            localStorage.setItem(`${ROOM_SEEN_KEY_PREFIX}${slug}`, seenAt);
        } catch {
            // Ignore localStorage write errors.
        }
    };

    const getLastRoomSeen = (): string | null => {
        if (typeof window === 'undefined') return null;
        try {
            return localStorage.getItem(`${ROOM_SEEN_KEY_PREFIX}${slug}`);
        } catch {
            return null;
        }
    };

    const isDesktopNotifyEnabled = () => {
        if (typeof window === 'undefined') return false;
        return localStorage.getItem(DESKTOP_NOTIFY_KEY) === '1';
    };

    useEffect(() => {
        if (!loading) {
            if (user) {
                loadRoom();
            } else {
                setLoadingRoom(false);
                setError('You are not logged in. Please sign in from the home page to access this room.');
            }
        }
    }, [user, loading, slug]);

    useEffect(() => {
        if (!user) {
            setCurrentUserIdentity(null);
            return;
        }

        let cancelled = false;
        const fallbackHandle = user.email?.split('@')[0] || user.id || 'you';
        const fallbackName = user.user_metadata?.full_name || fallbackHandle;

        setCurrentUserIdentity({
            handle: fallbackHandle,
            name: fallbackName,
        });

        apiFetch('/api/v1/profile', { cache: 'no-store' })
            .then(async (res) => {
                if (!res.ok) {
                    return null;
                }
                return res.json();
            })
            .then((profile) => {
                if (cancelled || !profile) {
                    return;
                }

                setCurrentUserIdentity({
                    handle: profile.handle || profile.display_name || fallbackHandle,
                    name: profile.display_name || profile.handle || fallbackName,
                });
            })
            .catch(() => {
                if (!cancelled) {
                    setCurrentUserIdentity({
                        handle: fallbackHandle,
                        name: fallbackName,
                    });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [user]);

    // Set up real-time subscription.
    //
    // Resilience: the realtime websocket can die silently (network blip, tab
    // throttling, realtime server restart) leaving an ACTIVE tab frozen until
    // manual reload — the visibilitychange refresh only fires when the tab
    // regains visibility. Two guards below:
    //   1. subscribe() status callback → teardown + resubscribe with backoff
    //      on CHANNEL_ERROR/TIMED_OUT/CLOSED, then a catch-up fetch for
    //      anything missed during the gap.
    //   2. a cheap 30 s catch-up poll while the tab is visible (mergeMessages
    //      dedups, so it is idempotent) for drops the client never reports.
    useEffect(() => {
        if (!room?.id) return;

        let disposed = false;
        let resubscribeTimer: number | null = null;
        let resubscribeDelayMs = 2000;
        let currentChannel: ReturnType<typeof supabase.channel> | null = null;

        const catchUp = async () => {
            try {
                const freshMessages = await fetchRoomMessages({ limit: 30 });
                if (disposed || freshMessages.length === 0) return;
                applyFreshMessages(freshMessages);
            } catch (e) {
                console.error('[Realtime] Catch-up fetch failed:', e);
            }
        };

        const buildChannel = () => supabase
            .channel(`room:${room.id}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'messages',
                    filter: `room_id=eq.${room.id}`
                },
                async () => {
                    try {
                        const freshMessages = await fetchRoomMessages({ limit: latestMessageCreatedAtRef.current ? 10 : 1 });
                        if (freshMessages.length > 0) {
                            const latestMsg = freshMessages[freshMessages.length - 1];

                            // Scroll capture + 'instant' follow (never 'smooth': a smooth
                            // animation leaves the view transiently off-bottom, so the NEXT
                            // message's at-bottom check fails and follow silently stops in a
                            // busy room) happen inside applyFreshMessages.
                            applyFreshMessages(freshMessages);

                            // Desktop notifications are opt-in to avoid unwanted system beeps.
                            if (
                                isDesktopNotifyEnabled()
                                && document.hidden
                                && 'Notification' in window
                                && Notification.permission === 'granted'
                            ) {
                                const body = latestMsg.body.length > 100 ? latestMsg.body.substring(0, 97) + '...' : latestMsg.body;
                                new Notification(`${latestMsg.from_name} in ${room?.name || slug}`, {
                                    body,
                                    icon: '🐜',
                                    tag: `room-${room?.id}-${latestMsg.id}`,
                                });
                            }
                        }
                    } catch (e) {
                        console.error('[Realtime] Failed to fetch message:', e);
                    }
                }
            )
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'messages',
                    filter: `room_id=eq.${room.id}`
                },
                (payload) => {
                    const updated = payload.new as any;
                    const previous = payload.old as any;
                    if (!updated?.id) return;

                    const metadata = updated.metadata || {};
                    const previousMetadata = previous?.metadata || {};
                    const bodyChanged = typeof updated.body === 'string' && updated.body !== previous?.body;
                    const audioChanged = (metadata.audio_url || null) !== (previousMetadata.audio_url || null);
                    const imageChanged = (metadata.image_url || null) !== (previousMetadata.image_url || null);
                    const replyChanged = JSON.stringify(metadata.reply_to || null) !== JSON.stringify(previousMetadata.reply_to || null);
                    const reactionsChanged = JSON.stringify(metadata.reactions || {}) !== JSON.stringify(previousMetadata.reactions || {});
                    const hasRenderableContentChange = bodyChanged || audioChanged || imageChanged || replyChanged;

                    if (room?.is_public === false && hasRenderableContentChange) {
                        if (typeof window !== 'undefined') {
                            if (privateRoomRefreshTimeoutRef.current !== null) {
                                window.clearTimeout(privateRoomRefreshTimeoutRef.current);
                            }
                            privateRoomRefreshTimeoutRef.current = window.setTimeout(async () => {
                                privateRoomRefreshTimeoutRef.current = null;
                                try {
                                    const freshMessages = await fetchRoomMessages({ limit: 30 });
                                    applyFreshMessages(freshMessages);
                                } catch (e) {
                                    console.error('[Realtime] Failed to refresh updated message:', e);
                                }
                            }, 75);
                        }
                        return;
                    }

                    if (hasRenderableContentChange || reactionsChanged) {
                        applyLocalChange(prev => prev.map(m =>
                            m.id === updated.id
                                ? {
                                    ...m,
                                    body: bodyChanged ? updated.body : m.body,
                                    audio_url: audioChanged ? (metadata.audio_url || null) : m.audio_url,
                                    image_url: imageChanged ? (metadata.image_url || null) : m.image_url,
                                    reply_to: replyChanged ? (metadata.reply_to || null) : m.reply_to,
                                    reactions: metadata.reactions || {},
                                }
                                : m
                        ));
                    }
                }
            )
            .on(
                'postgres_changes',
                {
                    event: 'DELETE',
                    schema: 'public',
                    table: 'messages'
                },
                (payload: { old?: { id?: string } | null }) => {
                    // DELETE payloads carry only the old row's primary key
                    // (default replica identity), so no room_id filter is
                    // possible server-side — match against local state instead.
                    const deletedId = payload.old?.id;
                    if (!deletedId) return;
                    applyLocalChange(prev => prev.filter(m => m.id !== deletedId), false);
                }
            )
            ;

        const teardownChannel = () => {
            if (currentChannel) {
                supabase.removeChannel(currentChannel);
                currentChannel = null;
            }
        };

        const scheduleResubscribe = () => {
            if (disposed || resubscribeTimer !== null) return;
            const delay = resubscribeDelayMs;
            resubscribeDelayMs = Math.min(resubscribeDelayMs * 2, 30000);
            resubscribeTimer = window.setTimeout(() => {
                resubscribeTimer = null;
                if (disposed) return;
                teardownChannel();
                connect();
            }, delay);
        };

        const connect = () => {
            if (disposed) return;
            currentChannel = buildChannel();
            currentChannel.subscribe((status: string) => {
                if (disposed) return;
                if (status === 'SUBSCRIBED') {
                    resubscribeDelayMs = 2000;
                    // Pick up anything that arrived while the channel was down.
                    void catchUp();
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    console.warn(`[Realtime] room channel ${status}; resubscribing`);
                    scheduleResubscribe();
                }
            });
        };

        connect();

        // Belt-and-braces: silent websocket drops the client never reports
        // self-heal within one poll tick. Skipped while hidden — the
        // visibilitychange handler already refreshes on return.
        const pollTimer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void catchUp();
        }, 30000);

        return () => {
            disposed = true;
            if (resubscribeTimer !== null) window.clearTimeout(resubscribeTimer);
            window.clearInterval(pollTimer);
            teardownChannel();
        };
    }, [room?.id, room?.is_public]);

    // --- Scroll control ---
    // shouldScrollRef: set BEFORE setMessages to control post-render behavior
    //   'instant' = snap to bottom (initial load)
    //   'smooth'  = smooth scroll to bottom (user's own message)
    //   false     = don't scroll (user is reading history)
    const shouldScrollRef = useRef<'instant' | 'smooth' | false>('instant');
    // savedScrollTopRef: captures scrollTop BEFORE DOM mutation
    const savedScrollTopRef = useRef<number | null>(null);
    const scrollStorageKey = `antfarm:room-scroll:${slug}`;
    const [userHasScrolledUp, setUserHasScrolledUp] = useState(false);
    const latestMessageCreatedAtRef = useRef<string | null>(null);

    // A field-wise "did this fetch tell us anything new" check. Nested fields
    // (reactions, reply_to, actions) are compared by value.
    const sameMessage = (a: Message, b: Message) => {
        for (const key of Object.keys(b) as (keyof Message)[]) {
            const left = a[key];
            const right = b[key];
            if (left === right) continue;
            if (typeof left === 'object' && typeof right === 'object'
                && left !== null && right !== null
                && JSON.stringify(left) === JSON.stringify(right)) continue;
            return false;
        }
        return true;
    };

    // Returns the SAME array when the fetch changed nothing, so React bails
    // out of the render: no new row objects, no layout effect, no scrollTop
    // write. The 30 s catch-up poll in a quiet room used to give every visible
    // message a fresh identity and re-run the scroll restore, which is what
    // dropped a text selection (and the phone's Copy popup) mid-gesture while
    // someone was copying an IP out of a message (reported by a user).
    const mergeMessages = (current: Message[], incoming: Message[]) => {
        const next = [...current];
        let changed = false;

        for (const message of incoming) {
            const existingIndex = next.findIndex(currentMessage => currentMessage.id === message.id);
            if (existingIndex >= 0) {
                if (sameMessage(next[existingIndex], message)) continue;
                next[existingIndex] = { ...next[existingIndex], ...message };
            } else {
                next.push(message);
            }
            changed = true;
        }

        if (!changed) return current;

        return next.sort((left, right) => {
            const leftTime = Date.parse(left.created_at);
            const rightTime = Date.parse(right.created_at);

            if (Number.isNaN(leftTime) || Number.isNaN(rightTime) || leftTime === rightTime) {
                return left.id.localeCompare(right.id);
            }

            return leftTime - rightTime;
        });
    };

    const fetchRoomMessages = async ({ limit = 100, before }: { limit?: number; before?: string } = {}) => {
        const beforeParam = before ? `&before=${encodeURIComponent(before)}` : '';
        const res = await apiFetch(`/api/v1/rooms/${slug}/messages?limit=${limit}${beforeParam}`, {
            cache: 'no-store',
        });
        const data = await res.json();
        if (!res.ok || !data.messages) {
            throw new Error(data.error || 'Failed to fetch room messages');
        }
        return (data.messages as Message[]).reverse();
    };

    // Extending scroll: the archive stores everything (23k+ messages in this
    // room) but one fetch caps at 100, so reaching the top loads the next
    // 100 older messages and prepends them, keeping the viewport anchored on
    // what the reader was looking at.
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [historyExhausted, setHistoryExhausted] = useState(false);
    const loadingOlderRef = useRef(false);

    // `beforeOverride` lets a caller that runs across several renders (the
    // "↑ mine" loop) pass the cursor it can see in the DOM instead of the
    // `messages` this closure captured at render time, which would repeat
    // the same page (codexmb review of #127). Returns what happened so such
    // a caller can stop on exhaustion without reading stale state.
    const loadOlderMessages = async (beforeOverride?: string): Promise<'loaded' | 'exhausted' | 'skipped'> => {
        if (loadingOlderRef.current || historyExhausted) return 'skipped';
        const el = scrollContainerRef.current;
        const oldest = beforeOverride ?? messages[0]?.created_at;
        if (!oldest) return 'skipped';
        loadingOlderRef.current = true;
        setLoadingOlder(true);
        try {
            const older = await fetchRoomMessages({ limit: 100, before: oldest });
            if (older.length === 0) {
                setHistoryExhausted(true);
                return 'exhausted';
            }
            const prevHeight = el ? el.scrollHeight : 0;
            const prevTop = el ? el.scrollTop : 0;
            setMessages(prev => {
                const seen = new Set(prev.map(m => m.id));
                const fresh = older.filter(m => !seen.has(m.id));
                if (fresh.length === 0) return prev;
                return [...fresh, ...prev];
            });
            if (older.length < 100) setHistoryExhausted(true);
            // Keep the reader anchored: restore the distance from the bottom
            // after the prepend grows the scroll height.
            requestAnimationFrame(() => {
                if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop;
            });
            return older.length < 100 ? 'exhausted' : 'loaded';
        } catch (e) {
            console.error('Failed to load older messages:', e);
            return 'skipped';
        } finally {
            loadingOlderRef.current = false;
            setLoadingOlder(false);
        }
    };

    // Follow-the-room decision for INCOMING messages (call BEFORE setMessages).
    // Two rules, both from live user reports (2026-07-18):
    //   1. Follow only when truly AT the bottom (8px slop for fractional
    //      scrollTop at browser zoom) — the old 150px window meant "slightly
    //      scrolled up" still counted as bottom and the view kept jumping down.
    //   2. Never while a selection is live in the transcript: a scroll moves
    //      content under the anchored pointer, so the selection silently grows
    //      or shrinks mid-drag ("text copying still does not work" — this,
    //      not CSS, was the remaining cause in a room that posts every few
    //      seconds). Any click collapses the selection and follow resumes.
    const isAtBottom = () => {
        const el = scrollContainerRef.current;
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    };
    const hasLiveSelectionInTranscript = () => {
        const el = scrollContainerRef.current;
        if (!el) return false;
        const sel = window.getSelection();
        return !!(sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode));
    };
    const followBottom = () => isAtBottom() && !hasLiveSelectionInTranscript();

    // Fetched messages wait while a text selection is live inside the
    // transcript. Polling continues; the result is buffered and applied the
    // moment the selection collapses (any tap does that), so nothing is lost
    // and nothing moves under a finger that is choosing text. The scroll
    // bookkeeping happens inside the updater so a no-op merge leaves no stale
    // scrollTop behind for the next real update to restore.
    const pendingFreshRef = useRef<Message[] | null>(null);
    // Realtime edits, reactions and deletes that arrive during a selection
    // queue here IN ORDER and are applied after the buffered fetch on flush.
    // A fetch snapshot taken before an edit would otherwise spread its older
    // body over the newer one when the buffer lands (codex review on #132),
    // and a snapshot taken before a delete would resurrect the message.
    const pendingOpsRef = useRef<Array<(prev: Message[]) => Message[]>>([]);

    const commit = (next: Message[], prev: Message[], follow: boolean) => {
        if (next === prev) return prev;
        if (scrollContainerRef.current) {
            savedScrollTopRef.current = scrollContainerRef.current.scrollTop;
        }
        shouldScrollRef.current = follow && followBottom() ? 'instant' : false;
        return next;
    };

    const applyFreshMessages = (fresh: Message[]) => {
        if (fresh.length === 0) return;
        if (hasLiveSelectionInTranscript()) {
            pendingFreshRef.current = mergeMessages(pendingFreshRef.current ?? [], fresh);
            return;
        }
        setMessages(prev => commit(mergeMessages(prev, fresh), prev, true));
    };

    const applyLocalChange = (updater: (prev: Message[]) => Message[], follow = true) => {
        if (hasLiveSelectionInTranscript()) {
            pendingOpsRef.current.push(updater);
            return;
        }
        setMessages(prev => commit(updater(prev), prev, follow));
    };

    useEffect(() => {
        const flushPending = () => {
            if (hasLiveSelectionInTranscript()) return;
            const fresh = pendingFreshRef.current;
            const ops = pendingOpsRef.current;
            if (!fresh && ops.length === 0) return;
            pendingFreshRef.current = null;
            pendingOpsRef.current = [];
            setMessages(prev => {
                let next = fresh ? mergeMessages(prev, fresh) : prev;
                for (const op of ops) next = op(next);
                return commit(next, prev, true);
            });
        };
        document.addEventListener('selectionchange', flushPending);
        return () => document.removeEventListener('selectionchange', flushPending);
    }, []);

    const scrollToBottom = () => {
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
    };

    // "↑ mine": scroll to the newest message from me. The DOM is the source
    // of truth here (data-from on each row) so the loop sees rows added by
    // loadOlderMessages without racing React state. Bounded: at most five
    // older pages, then we give up quietly rather than paging forever.
    const jumpToMyLastMessage = async () => {
        const el = scrollContainerRef.current;
        if (!el || !myHandle || findingMine) return;
        setFindingMine(true);
        try {
            for (let attempt = 0; attempt < 6; attempt++) {
                const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-msg-id][data-from]'));
                const mine = rows.filter(r => r.dataset.from === myHandle).pop();
                if (mine) {
                    // Continue from here, not from wherever the arrows were.
                    mentionCursorRef.current = mine.dataset.msgId || null;
                    mentionPendingRef.current = mine.dataset.msgId || null;
                    mine.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    mine.classList.add('ring-1', 'ring-[#99DD00]/60', 'rounded-lg');
                    setTimeout(() => mine.classList.remove('ring-1', 'ring-[#99DD00]/60', 'rounded-lg'), 2500);
                    return;
                }
                if (attempt === 5) return;
                // Cursor from the DOM: the oldest row currently rendered. This
                // advances with every page; the closure's `messages` would not.
                const oldestRendered = rows[0]?.dataset.createdAt;
                if (!oldestRendered) return;
                const outcome = await loadOlderMessages(oldestRendered);
                if (outcome !== 'loaded') return;
                // Let React commit the older rows before searching again.
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                const newOldest = el.querySelector<HTMLElement>('[data-msg-id][data-created-at]')?.dataset.createdAt;
                if (!newOldest || newOldest === oldestRendered) return; // nothing new arrived; stop rather than loop
            }
        } finally {
            setFindingMine(false);
        }
    };

    // Step through the messages that are FOR ME: mentions, replies to me, and
    // my own. A user asked: "can we have mentions up and down arrows, so i
    // can click to last mention of me or my message?"
    //
    // Position comes from the DOM each press rather than a stored index, so a
    // message arriving mid-read cannot desynchronise the cursor. `prev` pages
    // older messages in the same way jumpToMyLastMessage does, because the
    // previous mention is very often above what is currently rendered.
    const jumpToAdjacentMention = async (direction: 'prev' | 'next') => {
        const el = scrollContainerRef.current;
        if (!el || !myHandle || findingMine) return;
        setFindingMine(true);
        try {
            for (let attempt = 0; attempt < 6; attempt++) {
                const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-msg-id][data-for-me="1"]'));
                // Where am I? Answer by IDENTITY first. Geometry cannot answer
                // it at the ends of the scroll range: a row at the very top
                // cannot be centred, so the cursor is not where the last jump
                // left it and ▲ returns the same message for ever. Remembering
                // the id (not the index) survives messages arriving mid-read,
                // because the id is looked up again on every press.
                const ids = rows.map(r => r.dataset.msgId || '');
                // Is the remembered row still what the reader is looking at? A
                // scrollbar drag fires no wheel/touch/key event, so this is the
                // guard that catches it.
                const boxTop = el.getBoundingClientRect().top;
                const centreOf = (r: HTMLElement) => {
                    const b = r.getBoundingClientRect();
                    return b.top - boxTop + el.scrollTop + b.height / 2;
                };
                const cursorRow = mentionCursorRef.current
                    ? rows.find(r => r.dataset.msgId === mentionCursorRef.current)
                    : undefined;
                if (cursorRow) {
                    const away = Math.abs(centreOf(cursorRow) - (el.scrollTop + el.clientHeight / 2));
                    if (away <= el.clientHeight / 2) {
                        // Arrived: nothing is in flight any more.
                        if (mentionPendingRef.current === cursorRow.dataset.msgId) mentionPendingRef.current = null;
                    } else if (mentionPendingRef.current !== cursorRow.dataset.msgId) {
                        // Far away and NOT where we are still heading: the reader
                        // moved by some means that fired no input event.
                        mentionCursorRef.current = null;
                    }
                }
                let idx = stepFromAnchorId(ids, mentionCursorRef.current, direction);
                if (idx === -1) {
                    // First press, or the remembered message has scrolled out of
                    // the rendered window: fall back to geometry. Compare row
                    // CENTRES against the viewport centre -- comparing against
                    // offsetTop makes the current row look half its own height
                    // above the cursor, which re-selects it (@codexmb).
                    const current = el.scrollTop + el.clientHeight / 2;
                    // Container-relative, not offsetTop: offsetTop is measured
                    // from offsetParent, which is not necessarily this scroll
                    // container, and mixing it with scrollTop would compare two
                    // different origins (@codexmb).
                    const top = el.getBoundingClientRect().top;
                    const centres = rows.map(r => {
                        const box = r.getBoundingClientRect();
                        return box.top - top + el.scrollTop + box.height / 2;
                    });
                    idx = pickAdjacentAnchor(centres, current, direction);
                }
                if (idx != null && idx !== -1) {
                    const target = rows[idx];
                    mentionCursorRef.current = target.dataset.msgId || null;
                    mentionPendingRef.current = target.dataset.msgId || null;
                    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    target.classList.add('ring-1', 'ring-[#99DD00]/60', 'rounded-lg');
                    setTimeout(() => target.classList.remove('ring-1', 'ring-[#99DD00]/60', 'rounded-lg'), 2500);
                    return;
                }
                // Nothing further in this direction among the rendered rows.
                // Newer than the newest can only mean "none", but older may
                // simply not be loaded yet, so page back and look again.
                if (direction === 'next') return;
                const allRows = Array.from(el.querySelectorAll<HTMLElement>('[data-msg-id][data-created-at]'));
                const oldestRendered = allRows[0]?.dataset.createdAt;
                if (!oldestRendered) return;
                const outcome = await loadOlderMessages(oldestRendered);
                if (outcome !== 'loaded') return;
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                const newOldest = el.querySelector<HTMLElement>('[data-msg-id][data-created-at]')?.dataset.createdAt;
                if (!newOldest || newOldest === oldestRendered) return;
            }
        } finally {
            setFindingMine(false);
        }
    };

    // Track userHasScrolledUp for the floating button
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const handleScroll = () => {
            // A smooth scroll is only "in flight" until it lands. Clear the
            // pending target the moment it reaches the centre, so a later move
            // by any means is seen as the reader relocating rather than as our
            // own animation still running. Without this, exempting the pending
            // target from the distance guard re-opens the stale anchor it was
            // added to close -- the harness caught exactly that regression.
            const pending = mentionPendingRef.current;
            if (pending) {
                const row = el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(pending)}"]`);
                if (row) {
                    const box = row.getBoundingClientRect();
                    const centre = box.top - el.getBoundingClientRect().top + el.scrollTop + box.height / 2;
                    if (Math.abs(centre - (el.scrollTop + el.clientHeight / 2)) <= el.clientHeight / 2) {
                        mentionPendingRef.current = null;
                    }
                }
            }
            const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
            setUserHasScrolledUp(!nearBottom);
            try {
                sessionStorage.setItem(scrollStorageKey, String(el.scrollTop));
            } catch {}
        };
        // Real user input drops the arrow cursor at once, even mid-jump: a flick
        // 200ms after an arrow press is an interruption, not part of the jump.
        const dropMentionCursor = () => {
            mentionCursorRef.current = null;
            mentionPendingRef.current = null;   // a real interruption cancels the flight too
        };
        const onKey = (ev: KeyboardEvent) => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(ev.key)) {
                dropMentionCursor();
            }
        };
        el.addEventListener('scroll', handleScroll, { passive: true });
        el.addEventListener('wheel', dropMentionCursor, { passive: true });
        el.addEventListener('touchmove', dropMentionCursor, { passive: true });
        el.addEventListener('keydown', onKey);
        return () => {
            el.removeEventListener('scroll', handleScroll);
            el.removeEventListener('wheel', dropMentionCursor);
            el.removeEventListener('touchmove', dropMentionCursor);
            el.removeEventListener('keydown', onKey);
        };
    }, [room?.id, scrollStorageKey]);

    // useLayoutEffect fires synchronously AFTER DOM mutation, BEFORE browser paint.
    // This is the correct place to restore scroll position — the user never sees a jump.
    useLayoutEffect(() => {
        if (messages.length === 0 || loadingRoom) return;
        const el = scrollContainerRef.current;
        if (!el) return;

        const action = shouldScrollRef.current;
        shouldScrollRef.current = false; // reset for next time

        if (action === 'instant' || action === 'smooth') {
            // Scroll to bottom. Discard any stashed scrollTop that a racing
            // focus/visibility handler may have written: bottom-scroll always
            // wins over restore when both fire in the same render cycle.
            savedScrollTopRef.current = null;
            if (action === 'smooth') {
                el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            } else {
                el.scrollTop = el.scrollHeight;
            }
        } else {
            // Restore saved scroll position (prevents layout-shift jump)
            if (savedScrollTopRef.current !== null) {
                el.scrollTop = savedScrollTopRef.current;
                savedScrollTopRef.current = null;
            }
        }
    }, [messages, loadingRoom]);

    useEffect(() => {
        latestMessageCreatedAtRef.current = messages[messages.length - 1]?.created_at || null;
    }, [messages]);

    useEffect(() => {
        return () => {
            if (privateRoomRefreshTimeoutRef.current !== null) {
                window.clearTimeout(privateRoomRefreshTimeoutRef.current);
                privateRoomRefreshTimeoutRef.current = null;
            }
        };
    }, []);

    const loadRoom = async () => {
        setLoadingRoom(true);
        setInitialDataPending(true);
        try {
            // Get room info
            const { data: roomData } = await supabase
                .from('rooms')
                .select('id, name, slug, is_public')
                .eq('slug', slug)
                .single();

            if (roomData) {
                const roomInfo = roomData as Room;
                const { data: membership, error: membershipError } = await supabase
                    .from('room_members')
                    .select('id')
                    .eq('room_id', roomInfo.id)
                    .eq('user_id', user?.id || '')
                    .maybeSingle();

                if (membershipError) {
                    throw membershipError;
                }

                if (!membership) {
                    if (!roomInfo.is_public) {
                        setError('You are not a member of this room. Join it from Messages with an invite code first.');
                        setLoadingRoom(false);
                        return;
                    }

                    const joinRes = await apiFetch(`/api/v1/rooms/${encodeURIComponent(roomInfo.slug)}/join`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({}),
                    });

                    const joinPayload = await joinRes.json().catch(() => ({}));
                    if (!joinRes.ok) {
                        setError(joinPayload.error || 'Failed to join room');
                        setLoadingRoom(false);
                        return;
                    }
                }

                setRoom(roomInfo);
                setLoadingRoom(false);
                await Promise.all([
                    loadMessages(),
                    loadMembers(roomInfo.id),
                    loadDocuments(),
                ]);
            } else {
                setError('Room not found');
                setLoadingRoom(false);
            }
        } catch (e) {
            setError('Failed to load room');
            setLoadingRoom(false);
        } finally {
            setInitialDataPending(false);
        }
    };

    const loadDocuments = async () => {
        try {
            const res = await apiFetch(`/api/v1/rooms/${slug}/documents`);
            const data = await res.json();
            if (res.ok && data.documents) {
                setDocuments(data.documents);
                // If there is no default document but there is another one, select the first one
                if (data.documents.length > 0 && !data.documents.find((d: any) => d.id === 'default')) {
                    setActiveDocumentId(data.documents[0].id);
                }
            }
        } catch (e) {
            console.error('Error loading documents:', e);
        }
    };

    const createNewDocument = async () => {
        setCreatingDoc(true);
        try {
            const title = prompt("Enter a title for the new Scratchpad:");
            if (!title) return;

            const res = await apiFetch(`/api/v1/rooms/${slug}/documents`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, content: '' })
            });

            if (res.ok) {
                const data = await res.json();
                setDocuments(prev => [data.document, ...prev]);
                setActiveDocumentId(data.document.id);
                setViewMode('scratchpad');
            } else {
                alert("Failed to create document.");
            }
        } catch (e) {
            console.error("Error creating document:", e);
        } finally {
            setCreatingDoc(false);
        }
    };

    const deleteDocument = async (doc: Document) => {
        if (doc.id === 'default') return;
        const confirmed = window.confirm(`Delete scratchpad "${doc.title}"? This removes its current state and archives.`);
        if (!confirmed) return;

        setDeletingDocId(doc.id);
        try {
            const res = await apiFetch(`/api/v1/rooms/${slug}/documents/${doc.id}`, {
                method: 'DELETE'
            });

            if (!res.ok) {
                alert('Failed to delete scratchpad.');
                return;
            }

            const nextDocs = documents.filter(existingDoc => existingDoc.id !== doc.id);
            setDocuments(nextDocs);
            if (activeDocumentId === doc.id) {
                setActiveDocumentId(nextDocs[0]?.id || 'default');
                setViewMode('scratchpad');
            }
        } catch (e) {
            console.error('Error deleting scratchpad:', e);
            alert('Failed to delete scratchpad.');
        } finally {
            setDeletingDocId(null);
        }
    };

    const loadMessages = async () => {
        try {
            const orderedMessages = await fetchRoomMessages({ limit: 100 });

            // Read the previously-stored last-seen timestamp BEFORE we mark
            // the room seen, so we can find the oldest message the user
            // hasn't seen yet and land on it instead of the very bottom.
            // (Falls back to bottom-scroll when there are no unread messages.)
            const rawLastSeen = getLastRoomSeen();
            // Guard against invalid/non-ISO values in storage — silently
            // ignore rather than crash the unread heuristic.
            const lastSeenMs = rawLastSeen ? Date.parse(rawLastSeen) : NaN;
            const lastSeen = Number.isFinite(lastSeenMs) ? rawLastSeen : null;

            const firstUnreadIdx = lastSeen
                ? orderedMessages.findIndex((m) => m.created_at > lastSeen)
                : -1;
            const firstUnread = firstUnreadIdx >= 0 ? orderedMessages[firstUnreadIdx] : null;
            const newestId = orderedMessages[orderedMessages.length - 1]?.id;

            // Only treat as "unread" when:
            //   - we found a first-unread message at all
            //   - it's NOT the very newest (that case is identical to bottom-scroll)
            //   - it's NOT the very oldest message in the loaded batch
            //     (means lastSeen is older than everything we fetched; the
            //     user is probably re-entering after a long absence and would
            //     rather see the freshest activity than be dumped at ancient
            //     history. They can scroll up to read backward.)
            const shouldOpenAtUnread =
                !!firstUnread &&
                firstUnread.id !== newestId &&
                firstUnreadIdx > 0;
            firstUnreadIdRef.current = shouldOpenAtUnread ? firstUnread!.id : null;

            // Belt-and-suspenders for mobile: force the scroll after the
            // layout effect has painted so a late focus/visibility refresh
            // can't strand us at scrollTop=0. See PR #22 for the race.
            shouldScrollRef.current = shouldOpenAtUnread ? false : 'instant';
            savedScrollTopRef.current = null;
            setMessages(orderedMessages);

            const latestSeen = orderedMessages[orderedMessages.length - 1]?.created_at;
            markRoomSeen(latestSeen || new Date().toISOString());

            // Double rAF: first frame lets React commit + run the layout
            // effect; second frame guarantees layout has settled. Then
            // either scroll to the first-unread divider or snap to bottom.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const container = scrollContainerRef.current;
                    if (!container) return;
                    if (shouldOpenAtUnread && firstUnreadIdRef.current) {
                        const node = container.querySelector<HTMLElement>(
                            `[data-msg-id="${CSS.escape(firstUnreadIdRef.current)}"]`
                        );
                        if (node) {
                            // Align the first-unread to ~1/3 down the viewport
                            // so a little prior context is visible above it.
                            const offset = node.offsetTop - container.clientHeight / 3;
                            container.scrollTop = Math.max(0, offset);
                            // We deliberately opened above the end: show the
                            // jump pill at once, not only after the first
                            // scroll gesture (a flood can put the end tens of
                            // screens below the first unread).
                            setUserHasScrolledUp(true);
                            return;
                        }
                    }
                    container.scrollTop = container.scrollHeight;
                });
            });
        } catch (e) {
            console.error('Error loading messages:', e);
        }
    };

    useEffect(() => {
        const persistScrollPosition = () => {
            const el = scrollContainerRef.current;
            if (!el) return;
            try {
                sessionStorage.setItem(scrollStorageKey, String(el.scrollTop));
            } catch {}
        };

        window.addEventListener('pagehide', persistScrollPosition);
        return () => window.removeEventListener('pagehide', persistScrollPosition);
    }, [scrollStorageKey]);

    useEffect(() => {
        if (!room || loadingRoom) return;
        const latestSeen = messages[messages.length - 1]?.created_at;
        markRoomSeen(latestSeen || new Date().toISOString());
    }, [room?.id, loadingRoom, messages, slug]);

    useEffect(() => {
        if (!room) return;

        const refreshLatestMessages = async () => {
            // Guard against the mobile autoscroll race: on initial mount the
            // mobile webview can fire `focus` / `visibilitychange` before the
            // first message list has rendered. Without this guard the handler
            // captures `scrollTop = 0` into `savedScrollTopRef`, then the
            // layout-effect restores 0 on the next setMessages, landing the
            // user on the oldest messages instead of the newest.
            if (initialDataPending || loadingRoom) return;
            try {
                const freshMessages = await fetchRoomMessages({ limit: 30 });
                applyFreshMessages(freshMessages);
            } catch (e) {
                console.error('[Focus refresh] Failed to refresh room messages:', e);
            }
        };

        const markLatestSeen = () => {
            const latestSeen = messages[messages.length - 1]?.created_at;
            markRoomSeen(latestSeen || new Date().toISOString());
        };

        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                void refreshLatestMessages();
                markLatestSeen();
            }
        };

        const onFocus = () => {
            void refreshLatestMessages();
            markLatestSeen();
        };

        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [room?.id, messages, slug, initialDataPending, loadingRoom]);

    const loadMembers = async (roomId: string) => {
        try {
            // Fetch agent members
            const { data: agentData } = await supabase
                .from('room_members')
                .select(`
                    agent:agents(handle, name, metadata)
                `)
                .eq('room_id', roomId)
                .not('agent_id', 'is', null);

            // Fetch human user members
            const { data: userData } = await supabase
                .from('room_members')
                .select(`
                    user_id,
                    profile:user_profiles(display_name)
                `)
                .eq('room_id', roomId)
                .not('user_id', 'is', null);

            // Fetch xfb profiles for avatar_url
            const humanIds = ((userData || []) as any[]).map((d) => d.user_id).filter(Boolean);
            let xfbProfiles: Map<string, { avatar_url: string | null; handle: string | null }> = new Map();
            if (humanIds.length > 0) {
                const { data: xfbs } = await supabase
                    .from('xfb_user_profiles')
                    .select('user_id, avatar_url, handle')
                    .in('user_id', humanIds);
                if (xfbs) {
                    for (const x of xfbs as any[]) {
                        xfbProfiles.set(x.user_id, { avatar_url: x.avatar_url, handle: x.handle });
                    }
                }
            }

            const memberList: Member[] = [];

            // Add agent members
            if (agentData) {
                for (const d of agentData as any[]) {
                    if (d.agent) {
                        memberList.push({
                            handle: d.agent.handle,
                            name: d.agent.name,
                            avatar_url: d.agent.metadata?.avatar_url || null,
                        });
                    }
                }
            }

            // Add human members
            if (userData) {
                for (const d of userData as any[]) {
                    const displayName = d.profile?.display_name || 'Human User';
                    const xfb = xfbProfiles.get(d.user_id);
                    memberList.push({
                        handle: xfb?.handle || displayName,
                        name: displayName,
                        isHuman: true,
                        avatar_url: xfb?.avatar_url || null,
                    });
                }
            }

            setMembers(memberList);
        } catch (e) {
            console.error('Error loading members:', e);
        }
    };

    // Delete your OWN message within 15 min of posting (server enforces both;
    // this only decides whether to show the affordance). Human messages carry
    // the sender's handle in `from` — compare against the signed-in identity.
    const DELETE_WINDOW_MS = 15 * 60 * 1000;
    const canDeleteMessage = (msg: Message) => {
        if (!msg.isHuman) return false;
        const myHandle = (currentUserIdentity?.handle || user?.email?.split('@')[0] || '').replace(/^@/, '').toLowerCase();
        if (!myHandle) return false;
        const fromHandle = (msg.from || '').replace(/^@/, '').toLowerCase();
        if (fromHandle !== myHandle) return false;
        return Date.now() - new Date(msg.created_at).getTime() < DELETE_WINDOW_MS;
    };

    const deleteMessage = async (msg: Message) => {
        const preview = msg.body.length > 60 ? msg.body.slice(0, 57) + '...' : msg.body;
        if (!window.confirm(`Delete your message "${preview}"? This removes it for everyone.`)) return;
        try {
            const res = await apiFetch(`/api/v1/rooms/${slug}/messages/${msg.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json().catch(() => null);
                alert(err?.error || 'Failed to delete message.');
                return;
            }
            // Optimistic local removal; other tabs drop it via the realtime DELETE event.
            setMessages(prev => prev.filter(m => m.id !== msg.id));
        } catch (e) {
            console.error('Error deleting message:', e);
            alert('Failed to delete message.');
        }
    };

    const toggleReaction = async (messageId: string, emoji: string) => {
        try {
            const msg = messages.find(m => m.id === messageId);
            const currentReactions = msg?.reactions || {};
            const currentUsers = currentReactions[emoji] || [];
            const currentUserHandle = currentUserIdentity?.handle || user?.email?.split('@')[0] || user?.id || 'you';
            // Determine if we're removing (user already reacted)
            const isRemoving = currentUsers.some(h => h === 'You' || h === currentUserHandle);

            const res = await apiFetch(`/api/v1/rooms/${slug}/messages/${messageId}/react`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emoji, remove: isRemoving }),
            });
            const data = await res.json();
            if (res.ok) {
                setMessages(prev => prev.map(m =>
                    m.id === messageId ? { ...m, reactions: data.reactions } : m
                ));
            }
        } catch (e) {
            console.error('Reaction error:', e);
        }
        setEmojiPickerForMsg(null);
    };

    const startReply = (msg: Message) => {
        setReplyingTo(msg);
        inputRef.current?.focus();
    };

    const startForward = async (msg: Message) => {
        setForwardingMsg(msg);
        // Load user's rooms for the forward dialog
        try {
            const { data: memberships } = await supabase
                .from('room_members')
                .select('room_id, room:rooms(id, name, slug, is_public)')
                .eq('user_id', user?.id ?? '');
            if (memberships) {
                const rooms = memberships
                    .map((m: any) => m.room as Room)
                    .filter((r: Room | null): r is Room => !!r && r.slug !== slug);
                setForwardRooms(rooms);
            }
        } catch (e) {
            console.error('Error loading rooms for forward:', e);
        }
    };

    const forwardMessage = async (targetSlug: string) => {
        if (!forwardingMsg) return;
        try {
            const forwardBody = `↪️ *Forwarded from ${forwardingMsg.from} in /${slug}:*\n\n${forwardingMsg.body}`;
            await apiFetch(`/api/v1/rooms/${targetSlug}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body: forwardBody }),
            });
        } catch (e) {
            console.error('Forward error:', e);
        }
        setForwardingMsg(null);
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
                room: slug,
                body: msgBody,
                ...(attachmentType === 'audio' ? { audio_url: attachmentUrl }
                    : attachmentType === 'image' ? { image_url: attachmentUrl }
                    : { file_url: attachmentUrl, file_name: fileMeta?.name, file_size: fileMeta?.size }),
            };
            if (replyingTo) {
                payload.reply_to = {
                    id: replyingTo.id,
                    from: replyingTo.from,
                    body: replyingTo.body.length > 200 ? replyingTo.body.slice(0, 200) + '…' : replyingTo.body,
                };
            }

            const res = await apiFetch('/api/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (res.ok) {
                setNewMessage('');
                setReplyingTo(null);
                shouldScrollRef.current = 'smooth';
                setMessages(prev => {
                    if (prev.some(m => m.id === data.id)) return prev;
                    return [...prev, {
                        id: data.id,
                        from: data.from,
                        from_name: 'You',
                        body: msgBody,
                        audio_url: attachmentType === 'audio' ? attachmentUrl : null,
                        image_url: attachmentType === 'image' ? attachmentUrl : null,
                        file_url: attachmentType === 'file' ? attachmentUrl : null,
                        file_name: attachmentType === 'file' ? (fileMeta?.name || null) : null,
                        file_size: attachmentType === 'file' ? (fileMeta?.size ?? null) : null,
                        created_at: data.created_at,
                        isHuman: true,
                        reply_to: replyingTo ? {
                            id: replyingTo.id,
                            from: replyingTo.from,
                            body: replyingTo.body.length > 200 ? replyingTo.body.slice(0, 200) + '…' : replyingTo.body,
                        } : null,
                    }];
                });
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
        // Clear value so selecting the same file again still triggers onChange.
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
            const uploadRes = await apiFetch('/api/v1/upload', {
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

    // Copy a message's text with one tap. Long-press selection is unreliable on
    // phones (a user could not copy a shell command out of a
    // message), so the action bar gets an explicit Copy. navigator.clipboard
    // needs a secure context and a user gesture; the execCommand path covers
    // older mobile browsers and embedded webviews where it is missing.
    const copyMessageText = async (msg: Message) => {
        const text = msg.body || '';
        if (!text) return;
        let ok = false;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                ok = true;
            }
        } catch {
            ok = false;
        }
        if (!ok) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, text.length);
            try {
                ok = document.execCommand('copy');
            } catch {
                ok = false;
            }
            document.body.removeChild(ta);
        }
        if (ok) {
            setCopiedMsgId(msg.id);
            setTimeout(() => setCopiedMsgId((cur) => (cur === msg.id ? null : cur)), 1500);
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

    // Handle action-button taps on an intent message.
    //
    // Posts the equivalent chat command back to the room. The IAK chat-reply
    // poller catches it and routes to the intent decision endpoint. We reuse
    // the existing chat-reply pipeline rather than introducing a new backend
    // route — same plumbing, same auth.
    //
    // Two shapes, and the label decides which:
    //   approve*/deny*  -> `/approve <id>` | `/deny <id>`
    //   anything else   -> `/choose <id> <label>`
    //
    // Until 2026-09-19 this function hardcoded the approve/deny pair and did
    // `if (!decision) return;` — so a button with any other label was dropped
    // in silence, no post, no error, and the button simply did nothing. The
    // Android client had the same two-prefix filter (MainActivity.kt), which
    // meant a choice button would have failed on BOTH clients. claudeMB's
    // daemon (ide-agent-kit feat/choice-intents) now emits arbitrary labels,
    // so the client has to carry them through rather than recognise them.
    //
    // The label is posted with its DECLARED spelling: the daemon holds the
    // option list as an allow-list, matches case-insensitively and trimmed,
    // and stores the declared form, so normalising here would only risk
    // disagreeing with it. An unknown or stale label is refused there and the
    // intent stays pending — the client is not the thing keeping this safe.
    //
    // Ordering matters: every state write happens AFTER the wire form is
    // resolved. The Android bug was not the missing branch but the order —
    // it persisted the intent as decided before the unknown-label return, so
    // the tap greyed the button out, saved that, and sent nothing.
    const sendIntentAction = async (msg: Message, action: string) => {
        const intentId = msg.intent_id;
        if (!intentId) return;
        const command = intentActionCommand(intentId, action);
        if (!command) return;
        // Optimistic: clear actions on this message so buttons vanish.
        setMessages(prev => prev.map(m =>
            m.id === msg.id ? { ...m, actions: null } : m
        ));
        try {
            await apiFetch('/api/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ room: slug, body: command }),
            });
        } catch (err) {
            // Re-show the buttons if posting failed.
            setMessages(prev => prev.map(m =>
                m.id === msg.id ? { ...m, actions: msg.actions } : m
            ));
        }
    };

    const sendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        const currentBody = newMessage.trim();
        if (!currentBody || sending) return;

        const currentReplyTo = replyingTo;
        const tempId = `temp-${Date.now()}`;

        // Extract a better handle before falling back to ID
        const fallbackHandle = currentUserIdentity?.handle || user?.email?.split('@')[0] || user?.id || 'you';

        // Optimistic UI update immediately
        setNewMessage('');
        setReplyingTo(null);
        shouldScrollRef.current = 'smooth';

        // Own sends bypass applyFreshMessages on purpose: the sender's tap on
        // Send already collapsed any selection, and their message must show
        // immediately, never wait in the selection buffer.
        setMessages(prev => [...prev, {
            id: tempId,
            from: fallbackHandle,
            from_name: 'You',
            body: currentBody,
            created_at: new Date().toISOString(),
            isHuman: true,
            reply_to: currentReplyTo ? {
                id: currentReplyTo.id,
                from: currentReplyTo.from,
                body: currentReplyTo.body.length > 200 ? currentReplyTo.body.slice(0, 200) + '…' : currentReplyTo.body,
            } : null,
        }]);

        setSendError('');

        try {
            const payload: Record<string, unknown> = {
                room: slug,
                body: currentBody,
            };
            if (currentReplyTo) {
                payload.reply_to = {
                    id: currentReplyTo.id,
                    from: currentReplyTo.from,
                    body: currentReplyTo.body.length > 200 ? currentReplyTo.body.slice(0, 200) + '…' : currentReplyTo.body,
                };
            }

            // Fire and forget (optimistic UI handles the rest)
            apiFetch('/api/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }).then(async res => {
                const data = await res.json();
                if (res.ok) {
                    setMessages(prev => prev.map(m => m.id === tempId ? { ...m, id: data.id, created_at: data.created_at } : m));
                } else {
                    setSendError(data.error || 'Failed to send message');
                    setMessages(prev => prev.filter(m => m.id !== tempId));
                }
            }).catch(e => {
                console.error('Error sending message:', e);
                setSendError('Network error');
                setMessages(prev => prev.filter(m => m.id !== tempId));
            }).finally(() => {
                setSending(false);
            });

        } catch (e) {
            console.error('Synchronous error preparing message:', e);
            setSending(false);
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
                // Stop all tracks
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

                // Upload
                setUploading(true);
                setSendError('');
                try {
                    const formData = new FormData();
                    formData.append('file', blob, `voice-${Date.now()}.webm`);

                    const uploadRes = await apiFetch('/api/v1/upload', {
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
                // Follow the speaker's own browser language instead of assuming
                // American English. Hardcoding en-US made every Finnish voice
                // message come out as nonsense - a user reported: "Mahtavaa eclass, se
                // puhuu nyt suomea" and the room showed "month of a class"
                // (2026-08-20). The audio was fine; only the recogniser was told
                // the wrong language. navigator.language is what the user already
                // set, so this needs no new setting to get right.
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

            mediaRecorder.start(250); // collect in 250ms chunks
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

    if (loading || (loadingRoom && !room)) {
        return (
            <div className="w-full px-3 sm:px-6 space-y-4 animate-pulse">
                <div className="rounded-2xl border border-white/10 bg-gray-900/50 p-5">
                    <div className="mb-3 h-7 w-48 rounded bg-white/10" />
                    <div className="h-4 w-40 rounded bg-white/5" />
                </div>
                <div className="flex flex-col gap-3 lg:flex-row">
                    <div className="min-h-[60vh] flex-1 rounded-2xl border border-white/10 bg-gray-900/50 p-4">
                        <div className="space-y-3">
                            {Array.from({ length: 6 }).map((_, index) => (
                                <div key={index} className="flex gap-3">
                                    <div className="h-8 w-8 shrink-0 rounded-full bg-white/10" />
                                    <div className="flex-1 space-y-2">
                                        <div className="h-3 w-28 rounded bg-white/10" />
                                        <div className="h-3 w-full max-w-lg rounded bg-white/5" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="hidden lg:block lg:w-[22rem] rounded-2xl border border-white/10 bg-gray-900/50 p-4">
                        <div className="mb-4 h-6 w-32 rounded bg-white/10" />
                        <div className="space-y-3">
                            <div className="h-10 rounded-xl bg-white/5" />
                            <div className="h-10 rounded-xl bg-white/5" />
                            <div className="h-48 rounded-xl bg-white/5" />
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (!user) {
        return (
            <div className="text-center py-16">
                <p className="text-gray-500">Sign in to view this room.</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="text-center py-16">
                <p className="text-red-400">{error}</p>
                <Link href="/messages" className="text-[#99DD00] hover:text-[#FFDD00] mt-4 inline-block">
                    ← Back to Messages
                </Link>
            </div>
        );
    }

    // Chat used to sit in a centred max-w-6xl (1152px) column, so on anything
    // wider than a laptop most of the screen was black margin. A user raised it
    // three times; the third was a photo of their ultrawide with the content in a
    // narrow strip and bars either side.
    //
    // My first attempt capped it at 110rem (1760px), which I reasoned would
    // "fill a 1440 or 1920 screen". That was still a guess dressed as a fix: on
    // their monitor a 1760px cap leaves hundreds of pixels of black on each side,
    // and they would have reported the same bug again after a deploy. A cap I
    // pick is a cap that is wrong on the next screen size.
    //
    // So: no cap. The column fills the viewport with a gutter. The readability
    // argument for capping line length is real, but it belongs on the message
    // BODY, not on the whole layout — capping the layout also strands the
    // scratchpad sidebar and the header, which was the visible complaint.
    const chatColumn = viewMode === 'gather'
        ? 'w-full'
        : 'w-full px-3 sm:px-6';

    return (
        <div className={chatColumn}>
            {/* Header. Kept deliberately short on phones: every row here is a row
                the message list does not get. */}
            <div className="mb-2 rounded-2xl border border-white/10 bg-gray-900/40 p-2.5 sm:mb-4 sm:p-4">
                <div className="flex flex-col gap-2 sm:gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
                            <Link href="/messages" className="text-gray-400 hover:text-white shrink-0">
                                ←
                            </Link>
                            <h1 className="min-w-0 text-xl font-bold flex items-center gap-2">
                                <span>🏠</span>
                                <span className="truncate">{room?.name}</span>
                                {room && !room.is_public && (
                                    <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded ml-2 shrink-0">
                                        🔒 Private
                                    </span>
                                )}
                            </h1>
                            <button
                                onClick={() => setMentionsOnly(v => !v)}
                                aria-label="Show only messages for me"
                                aria-pressed={mentionsOnly}
                                disabled={!myHandle}
                                className={`ml-auto shrink-0 rounded-lg px-2.5 py-1.5 text-sm transition-colors disabled:opacity-40 ${mentionsOnly
                                    ? 'bg-[#55AA00] text-white'
                                    : 'bg-gray-800/80 text-gray-300 hover:bg-gray-700'
                                    }`}
                                title={myHandle ? `Only messages that mention @${myHandle}, reply to you, or are yours` : 'Sign in to filter mentions'}
                            >
                                @me{mentionsOnly ? ` ${visibleMessages.length}` : ''}
                            </button>
                            <button
                                onClick={() => jumpToAdjacentMention('prev')}
                                aria-label="Previous message for me"
                                disabled={!myHandle || findingMine}
                                className="shrink-0 rounded-l-lg min-w-11 px-2 py-1.5 text-sm transition-colors bg-gray-800/80 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
                                title={myHandle ? 'Previous mention, reply to you, or message of yours (loads older history if needed)' : 'Sign in to step through your mentions'}
                            >
                                {findingMine ? '\u2026' : '\u25b2'}
                            </button>
                            <button
                                onClick={() => jumpToAdjacentMention('next')}
                                aria-label="Next message for me"
                                disabled={!myHandle || findingMine}
                                className="shrink-0 rounded-r-lg min-w-11 px-2 py-1.5 text-sm transition-colors bg-gray-800/80 text-gray-300 hover:bg-gray-700 disabled:opacity-40 -ml-px"
                                title={myHandle ? 'Next mention, reply to you, or message of yours' : 'Sign in to step through your mentions'}
                            >
                                {findingMine ? '\u2026' : '\u25bc'}
                            </button>
                            <button
                                onClick={jumpToMyLastMessage}
                                aria-label="Jump to my latest message"
                                disabled={!myHandle || findingMine}
                                className="shrink-0 rounded-lg px-2.5 py-1.5 text-sm transition-colors bg-gray-800/80 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
                                title={myHandle ? 'Jump to your latest message (loads older history if needed)' : 'Sign in to find your messages'}
                            >
                                {findingMine ? '…' : '↑ mine'}
                            </button>
                            <button
                                onClick={() => setSearchOpen(!searchOpen)}
                                aria-label="Search messages in this room"
                                aria-expanded={searchOpen}
                                className={`shrink-0 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${searchOpen
                                    ? 'bg-[#55AA00] text-white'
                                    : 'bg-gray-800/80 text-gray-300 hover:bg-gray-700'
                                    }`}
                                title="Search messages"
                            >
                                🔍
                            </button>
                        </div>
                        <div className="mt-1 pl-8 flex items-center gap-3 sm:mt-2">
                            <span className="text-sm text-gray-500">/{slug}</span>
                            {room && !room.is_public && (
                                <button
                                    onClick={async () => {
                                        if (!showInviteCode && inviteCode === null) {
                                            setInviteCodeLoading(true);
                                            try {
                                                const res = await apiFetch(`/api/v1/rooms/${encodeURIComponent(slug)}/invite-code`);
                                                if (res.ok) {
                                                    const data = await res.json();
                                                    setInviteCode(data.invite_code || null);
                                                }
                                            } catch {}
                                            setInviteCodeLoading(false);
                                        }
                                        setShowInviteCode(!showInviteCode);
                                    }}
                                    disabled={inviteCodeLoading}
                                    className="text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 px-2 py-0.5 rounded transition-colors disabled:opacity-50"
                                    title="Show invite code"
                                >
                                    {inviteCodeLoading ? 'Loading...' : '🔗 Invite'}
                                </button>
                            )}
                        </div>
                        {showInviteCode && inviteCode && (
                            <div className="mt-3 pl-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                                <div className="rounded-lg border border-white/10 bg-white p-2 w-fit">
                                    <QRCodeSVG value={inviteJoinUrl} size={132} level="M" />
                                </div>
                                <div className="flex min-w-0 flex-col gap-2">
                                    <div className="flex items-center gap-2">
                                        <code className="text-sm bg-black/50 border border-white/10 px-3 py-1 rounded text-yellow-300">
                                            {inviteCode}
                                        </code>
                                        <button
                                            onClick={() => {
                                                navigator.clipboard.writeText(inviteCode);
                                                setInviteCopied(true);
                                                setTimeout(() => setInviteCopied(false), 2000);
                                            }}
                                            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded transition-colors"
                                        >
                                            {inviteCopied ? 'Copied!' : 'Copy'}
                                        </button>
                                    </div>
                                    <p className="text-xs text-gray-500">
                                        Scan with CodeWatch or open the join link to enter this room.
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="grid grid-cols-3 gap-2 lg:flex lg:items-center">
                        <button
                            onClick={() => setViewMode('chat')}
                            className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${viewMode === 'chat'
                                ? 'bg-[#55AA00] text-white'
                                : 'bg-gray-800/80 text-gray-300 hover:bg-gray-700'
                                }`}
                        >
                            Chat
                        </button>
                        <button
                            onClick={() => setViewMode('scratchpad')}
                            className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${viewMode === 'scratchpad'
                                ? 'bg-[#55AA00] text-white'
                                : 'bg-gray-800/80 text-gray-300 hover:bg-gray-700'
                                }`}
                        >
                            Scratchpad
                        </button>
                        <button
                            onClick={() => setViewMode('gather')}
                            className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${viewMode === 'gather'
                                ? 'bg-indigo-600 text-white'
                                : 'bg-gray-800/80 text-gray-300 hover:bg-gray-700'
                                }`}
                        >
                            Gather
                        </button>
                    </div>
                </div>
            </div>

            {searchOpen && (
                <div className="mb-2 rounded-2xl border border-white/10 bg-gray-900/40 p-2.5 sm:mb-4 sm:p-4">
                    <form
                        onSubmit={(e) => { e.preventDefault(); runSearch(searchQuery); }}
                        className="flex items-center gap-2"
                    >
                        <input
                            autoFocus
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search this room…"
                            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-[#55AA00] focus:outline-none"
                        />
                        <button
                            type="submit"
                            disabled={searchLoading || !searchQuery.trim()}
                            className="shrink-0 rounded-xl bg-[#55AA00] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[#4a9600] disabled:opacity-40"
                        >
                            {searchLoading ? '…' : 'Search'}
                        </button>
                    </form>

                    {searchError && <p className="mt-3 text-sm text-red-400">{searchError}</p>}

                    {searchResults && !searchError && (
                        <div className="mt-3">
                            {/* Never let an empty result look like a complete one. */}
                            <p className="text-xs text-gray-500">
                                {searchResults.length} match{searchResults.length === 1 ? '' : 'es'}
                                {searchMeta && ` · scanned ${searchMeta.scanned.toLocaleString()} messages`}
                                {searchMeta?.truncated && ' · stopped early, older messages not searched'}
                            </p>
                            <div className="mt-2 max-h-[50vh] space-y-2 overflow-y-auto">
                                {searchResults.map((m) => (
                                    <div key={m.id} className="rounded-xl border border-white/10 bg-black/30 p-2.5">
                                        <div className="flex items-baseline justify-between gap-2 text-xs text-gray-500">
                                            <span className="truncate font-medium text-gray-400">
                                                {m.from_name || m.from}
                                            </span>
                                            <span className="shrink-0">
                                                {new Date(m.created_at).toLocaleString()}
                                            </span>
                                        </div>
                                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-200">
                                            {m.body}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {isSidePaneOpen && (
                <button
                    type="button"
                    aria-label="Close side pane"
                    onClick={() => setViewMode('chat')}
                    className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
                />
            )}

            <div
                ref={setShellEl}
                className={`relative flex h-[calc(100dvh-10rem)] w-full flex-col gap-3 pb-[env(safe-area-inset-bottom)] lg:h-[calc(100dvh-13rem)] lg:flex-row lg:items-stretch ${isDragging ? 'select-none' : ''}`}
                style={{
                    cursor: isDragging ? 'col-resize' : 'default',
                    // Overrides the calc() in the class list once measured. The
                    // class stays so the first paint, and any render without JS,
                    // keep today's behaviour instead of collapsing.
                    ...(shellHeight !== null ? { height: shellHeight } : {}),
                }}
            >
                {/* Messages Area */}
                <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-gray-900/50">
                    {/* Messages */}
                    <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 pb-32 lg:pb-4 space-y-3">
                        {initialDataPending && messages.length === 0 ? (
                            <div className="space-y-3 animate-pulse">
                                {Array.from({ length: 6 }).map((_, index) => (
                                    <div key={index} className="flex gap-3">
                                        <div className="h-8 w-8 shrink-0 rounded-full bg-white/10" />
                                        <div className="flex-1 space-y-2">
                                            <div className="h-3 w-28 rounded bg-white/10" />
                                            <div className="h-3 w-full max-w-lg rounded bg-white/5" />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : messages.length === 0 ? (
                            <p className="text-gray-500 text-center py-8">No messages yet. Start the conversation!</p>
                        ) : (
                            <>
                            <div className="flex items-center justify-center py-1">
                                {historyExhausted ? (
                                    <span className="text-[11px] uppercase tracking-wider text-gray-600">Beginning of room history</span>
                                ) : (
                                    <button
                                        onClick={() => { void loadOlderMessages(); }}
                                        disabled={loadingOlder}
                                        className="text-xs text-gray-400 hover:text-white px-3 py-1 rounded-full border border-white/10 bg-white/5 disabled:opacity-50"
                                    >
                                        {loadingOlder ? 'Loading…' : 'Load older messages'}
                                    </button>
                                )}
                            </div>
                            {mentionsOnly && visibleMessages.length === 0 && (
                                <p className="text-gray-500 text-center py-8">
                                    Nothing addressed to @{myHandle} in the loaded messages. Load older messages above, or switch @me off.
                                </p>
                            )}
                            {visibleMessages.map(msg => (
                                <div key={msg.id} data-msg-id={msg.id} data-from={normalizeHandle(msg.from)} data-created-at={msg.created_at} data-for-me={myHandle && isAddressedTo(msg, myHandle) ? '1' : undefined}>
                                    {firstUnreadIdRef.current === msg.id && (
                                        <div
                                            className="flex items-center gap-3 my-2 text-[11px] uppercase tracking-wider text-[#99DD00]"
                                            aria-label="First unread message"
                                        >
                                            <div className="h-px flex-1 bg-[#99DD00]/40" />
                                            <span>New</span>
                                            <div className="h-px flex-1 bg-[#99DD00]/40" />
                                        </div>
                                    )}
                                <div className="group relative flex gap-3 hover:bg-white/[0.02] rounded-lg px-2 py-1 -mx-2">
                                    <Link
                                        href={msg.isHuman ? `/messages/dm/${msg.from.replace(/^@/, '')}` : `/a/${msg.from.replace(/^@/, '')}`}
                                        className="shrink-0"
                                    >
                                        {msg.avatar_url ? (
                                            <img
                                                src={msg.avatar_url}
                                                alt={msg.from}
                                                className="w-8 h-8 rounded-full object-cover"
                                            />
                                        ) : (
                                            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0 ${msg.isHuman ? 'bg-orange-800/50' : 'bg-pink-800/50'}`}>
                                                {msg.isHuman ? '👤' : '🤖'}
                                            </div>
                                        )}
                                    </Link>
                                    <div className="flex-1 min-w-0">
                                        {/* Reply-to preview */}
                                        {msg.reply_to && (
                                            <div className="select-none flex items-center gap-1.5 text-xs text-gray-500 mb-1 pl-3 border-l-2 border-gray-600">
                                                <span>↩</span>
                                                <span className="font-medium text-gray-400">{msg.reply_to.from}</span>
                                                <span className="truncate max-w-[200px]">{msg.reply_to.body}</span>
                                            </div>
                                        )}
                                        {/* select-none on the chrome (author, timestamp) so a drag-select
                                            grabs only the message body, not "@handle 12:00" etc.
                                            (a user reported: selection "grabs more/less than i want") */}
                                        <div className="select-none flex items-baseline gap-2">
                                            <Link
                                                href={msg.isHuman ? `/messages/dm/${msg.from.replace(/^@/, '')}` : `/a/${msg.from.replace(/^@/, '')}`}
                                                className={`font-medium hover:underline ${msg.isHuman ? 'text-orange-400' : 'text-[#99DD00]'}`}
                                            >
                                                {msg.from}
                                            </Link>
                                            <span className="text-xs text-gray-500">
                                                {new Date(msg.created_at).toLocaleTimeString()}
                                            </span>
                                        </div>
                                        {/* The LAYOUT fills the window (see chatColumn); the TEXT
                                            MEASURE is capped here instead. Removing the column cap
                                            fixed the owner's black bars but would have traded them for
                                            a worse problem on their curved ultrawide: a full-width
                                            line is a very long measure, the eye loses its place on
                                            the return sweep, and they would never file that as a bug
                                            - it would just feel tiring (@claudeMB's catch).
                                            In `ch`, so it tracks font size rather than assuming a
                                            monitor: ~90 characters is the readable ceiling, and a
                                            fixed px cap is wrong on the next screen by definition.
                                            Tables and code blocks inside can still use the full
                                            width, which is what the wide screen is actually for. */}
                                        <div className="select-text max-w-[90ch]">
                                            <MarkdownMessage body={msg.body} />
                                        </div>
                                        {msg.image_url && (
                                            <a
                                                href={msg.image_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="block mt-1.5 w-fit"
                                            >
                                                <img
                                                    src={msg.image_url}
                                                    alt="Image attachment"
                                                    className="rounded-lg max-w-[320px] max-h-72 object-cover border border-white/10 hover:border-[#55AA00]/60 transition-colors"
                                                    onLoad={(e) => {
                                                        // Late-loading images grow the transcript under a
                                                        // bottom-pinned view; re-pin ONLY if the reader was at
                                                        // the bottom before this image's height landed
                                                        // (distance <= grown height + slop) and is not
                                                        // mid-selection. The old !userHasScrolledUp check used
                                                        // the 150px flag and ignored selection, so a late image
                                                        // could yank a reader in history or copying (codexmb,
                                                        // PR #68 review).
                                                        const el = scrollContainerRef.current;
                                                        if (!el || hasLiveSelectionInTranscript()) return;
                                                        const grown = e.currentTarget.offsetHeight;
                                                        if (el.scrollHeight - el.scrollTop - el.clientHeight < grown + 8) {
                                                            scrollToBottom();
                                                        }
                                                    }}
                                                />
                                            </a>
                                        )}
                                        {msg.audio_url && (
                                            <audio
                                                controls
                                                src={msg.audio_url}
                                                className="mt-1.5 max-w-[280px] h-8"
                                                style={{ filter: 'sepia(20%) saturate(70%) grayscale(1) contrast(99%) invert(12%)' }}
                                            />
                                        )}
                                        {msg.file_url && (
                                            <a
                                                href={msg.file_url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                download={msg.file_name || true}
                                                className="mt-1.5 flex w-fit max-w-[320px] items-center gap-2 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-gray-200 transition-colors hover:border-[#55AA00]/60"
                                            >
                                                <span aria-hidden>📎</span>
                                                <span className="min-w-0 truncate">{msg.file_name || 'Attachment'}</span>
                                                {typeof msg.file_size === 'number' && (
                                                    <span className="shrink-0 text-xs text-gray-500">{formatFileSize(msg.file_size)}</span>
                                                )}
                                            </a>
                                        )}

                                        {/* Inline action buttons (e.g. Approve/Deny on confirmation requests) */}
                                        {msg.actions && msg.actions.length > 0 && msg.intent_id && (
                                            <div className="flex flex-wrap gap-2 mt-2">
                                                {msg.actions.map((action) => {
                                                    const isPositive = /^approve|^accept|^yes/i.test(action);
                                                    const isNegative = /^deny|^reject|^no/i.test(action);
                                                    const cls = isPositive
                                                        ? 'bg-[#99DD00] text-black hover:bg-[#88CC00] border-[#99DD00]'
                                                        : isNegative
                                                            ? 'bg-transparent text-red-300 hover:bg-red-900/30 border-red-700/60'
                                                            : 'bg-transparent text-gray-200 hover:bg-white/10 border-white/20';
                                                    return (
                                                        <button
                                                            key={action}
                                                            onClick={() => sendIntentAction(msg, action)}
                                                            className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${cls}`}
                                                        >
                                                            {action}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}

                                        {/* Reaction badges */}
                                        {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                                            <div className="select-none flex flex-wrap gap-1 mt-1.5">
                                                {Object.entries(msg.reactions).map(([emoji, users]) => (
                                                    <button
                                                        key={emoji}
                                                        onClick={() => toggleReaction(msg.id, emoji)}
                                                        className="relative group/rx inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-800/80 hover:bg-gray-700 border border-white/10 rounded-full text-xs transition-colors"
                                                    >
                                                        <span>{emoji}</span>
                                                        <span className="text-gray-400">{users.length}</span>
                                                        {/* Instant who-reacted tooltip (native title is slow and skips touch) */}
                                                        <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 hidden group-hover/rx:block group-focus-visible/rx:block whitespace-nowrap px-2 py-1 bg-gray-900 border border-white/15 rounded-md text-[11px] text-gray-200 shadow-lg z-20">
                                                            {users.join(', ')}
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}

                                        {/* Inline emoji picker */}
                                        {emojiPickerForMsg === msg.id && (
                                            <div className="flex gap-1 mt-1.5 p-1.5 bg-gray-800 border border-white/10 rounded-lg w-fit">
                                                {QUICK_EMOJIS.map(emoji => (
                                                    <button
                                                        key={emoji}
                                                        onClick={() => toggleReaction(msg.id, emoji)}
                                                        className="w-8 h-8 flex items-center justify-center rounded hover:bg-white/10 text-lg transition-colors"
                                                    >
                                                        {emoji}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Action bar: hover-revealed with a mouse, always visible on
                                        touch devices (no hover there, and opacity-0 still eats taps) */}
                                    <div className="absolute top-0 right-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition-opacity flex gap-0.5 bg-gray-800 border border-white/10 rounded-lg shadow-lg">
                                        <button
                                            onClick={() => copyMessageText(msg)}
                                            className="p-1.5 hover:bg-white/10 rounded-l-lg text-sm transition-colors flex items-center justify-center text-gray-200"
                                            title={copiedMsgId === msg.id ? 'Copied' : 'Copy text'}
                                            aria-label={copiedMsgId === msg.id ? 'Copied' : 'Copy message text'}
                                        >
                                            {copiedMsgId === msg.id ? (
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                                            ) : (
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                                            )}
                                        </button>
                                        <button
                                            onClick={() => setEmojiPickerForMsg(emojiPickerForMsg === msg.id ? null : msg.id)}
                                            className="p-1.5 hover:bg-white/10 text-sm transition-colors"
                                            title="React"
                                        >
                                            😀
                                        </button>
                                        <button
                                            onClick={() => startReply(msg)}
                                            className="p-1.5 hover:bg-white/10 text-sm transition-colors"
                                            title="Reply"
                                        >
                                            ↩️
                                        </button>
                                        <button
                                            onClick={() => startForward(msg)}
                                            className="p-1.5 hover:bg-white/10 last:rounded-r-lg text-sm transition-colors"
                                            title="Forward"
                                        >
                                            ↪️
                                        </button>
                                        {canDeleteMessage(msg) && (
                                            <button
                                                onClick={() => deleteMessage(msg)}
                                                className="p-1.5 hover:bg-red-500/20 rounded-r-lg text-sm transition-colors"
                                                title="Delete (your message, first 15 min)"
                                            >
                                                🗑️
                                            </button>
                                        )}
                                    </div>
                                </div>
                                </div>
                            ))}
                            </>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Jump to latest button — positioned absolutely */}
                    {userHasScrolledUp && (
                        <div className="flex justify-center py-1 relative z-10">
                            <button
                                onClick={() => {
                                    scrollToBottom();
                                    setUserHasScrolledUp(false);
                                }}
                                className="px-4 py-1.5 bg-[#55AA00]/90 hover:bg-[#99DD00] text-white text-xs font-medium rounded-full shadow-lg backdrop-blur-sm transition-all animate-bounce"
                            >
                                ↓ Jump to latest
                            </button>
                        </div>
                    )}

                    {/* Input */}
                    {/* Mobile: pinned to the viewport bottom so it survives the
                        page itself scrolling (narrow-phone headers overflow the
                        100dvh-10rem column budget and the body starts to scroll,
                        as a user reported). Desktop (lg:) keeps the in-flow
                        layout. Same fixed->lg:static pattern as the doc panels. */}
                    <form onSubmit={sendMessage} className="fixed inset-x-0 bottom-0 z-40 bg-gray-950/95 backdrop-blur-md border-t border-white/10 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:static lg:z-auto lg:bg-transparent lg:backdrop-blur-none">
                        {/* Reply-to preview bar */}
                        {replyingTo && (
                            <div className="flex items-center gap-2 mb-2 px-3 py-2 bg-gray-800/70 border-l-2 border-[#55AA00] rounded text-sm">
                                <span className="text-gray-500">↩ Replying to</span>
                                <span className="font-medium text-[#99DD00]">{replyingTo.from}</span>
                                <span className="text-gray-400 truncate flex-1">{replyingTo.body.slice(0, 80)}</span>
                                <button
                                    type="button"
                                    onClick={() => setReplyingTo(null)}
                                    className="text-gray-500 hover:text-white shrink-0"
                                >
                                    ✕
                                </button>
                            </div>
                        )}
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <div className="w-full sm:flex-1">
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
                                    ref={inputRef}
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
                                        if (e.key === 'Escape' && replyingTo) {
                                            setReplyingTo(null);
                                        }
                                    }}
                                    placeholder={replyingTo ? `Reply to ${replyingTo.from}...` : "Type a message... (Shift+Enter for new line)"}
                                    rows={1}
                                    className="w-full px-4 py-2.5 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none resize-none min-h-[42px] max-h-32 overflow-y-auto"
                                    style={{ fieldSizing: 'content' } as any}
                                />
                            </div>
                            <div className="flex gap-2 justify-end sm:justify-start sm:shrink-0">
                                <button
                                    type="button"
                                    disabled={uploading}
                                    onClick={() => fileInputRef.current?.click()}
                                    className={`px-3 py-2.5 rounded-lg font-medium transition-all shrink-0 ${
                                        uploading
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
                        </div>
                        {sendError && (
                            <p className="text-red-400 text-sm mt-2">{sendError}</p>
                        )}
                    </form>
                </div>

                {/* Draggable Divider Component */}
                {(viewMode === 'scratchpad' || viewMode === 'gather') && (
                    <div
                        className="hidden lg:flex w-8 mx-1 group items-center justify-center cursor-col-resize shrink-0 transition-colors hover:bg-white/[0.04] rounded-lg relative"
                        onMouseDown={handleMouseDown}
                    >
                        <div className={`w-1.5 h-16 rounded-full transition-all shadow-md ${isDragging ? 'bg-pink-400 scale-y-110' : 'bg-gray-400 group-hover:bg-white/90'}`} />
                    </div>
                )}

                {/* Right Pane (Scratchpad / Gather / Members) */}
                {viewMode === 'scratchpad' ? (
                    <div
                        className="fixed inset-x-3 top-24 bottom-3 z-40 flex flex-col rounded-2xl bg-gray-900/95 border border-white/10 p-4 shadow-2xl lg:static lg:inset-auto lg:z-auto lg:shadow-none lg:w-[var(--doc-width)] lg:bg-gray-900/50"
                        style={{ ['--doc-width' as string]: `${docWidth}px` }}
                    >
                        <div className="flex justify-between items-center mb-4 shrink-0">
                            <h3 className="text-lg font-bold">📄 Scratchpad {activeDocumentTitle ? `- ${activeDocumentTitle}` : ''}</h3>
                            <div className="flex items-center gap-2">
                                {activeDocumentId !== 'default' && (
                                    <button
                                        onClick={() => {
                                            const activeDoc = documents.find(doc => doc.id === activeDocumentId);
                                            if (activeDoc) {
                                                void deleteDocument(activeDoc);
                                            }
                                        }}
                                        disabled={deletingDocId === activeDocumentId}
                                        className="text-sm px-3 py-1.5 bg-red-600/80 hover:bg-red-500 disabled:bg-red-900/40 disabled:text-red-200/60 rounded-lg transition-colors border border-red-400/30"
                                    >
                                        {deletingDocId === activeDocumentId ? 'Deleting...' : 'Delete'}
                                    </button>
                                )}
                                <button
                                    onClick={() => setViewMode('chat')}
                                    className="text-sm px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors border border-white/10"
                                >✕ Close</button>
                            </div>
                        </div>
                        <div className="mb-3 flex gap-2 overflow-x-auto pb-1 lg:hidden">
                            <button
                                onClick={() => setActiveDocumentId('default')}
                                className={`shrink-0 rounded-lg px-3 py-2 text-sm border ${activeDocumentId === 'default' ? 'bg-[#55AA00] text-white border-pink-400/40' : 'bg-gray-800 text-gray-300 border-white/10'}`}
                            >
                                Default
                            </button>
                            {documents.map(doc => (
                                <button
                                    key={doc.id}
                                    onClick={() => setActiveDocumentId(doc.id)}
                                    className={`shrink-0 rounded-lg px-3 py-2 text-sm border ${activeDocumentId === doc.id ? 'bg-[#55AA00] text-white border-pink-400/40' : 'bg-gray-800 text-gray-300 border-white/10'}`}
                                >
                                    {doc.title}
                                </button>
                            ))}
                            <button
                                onClick={createNewDocument}
                                disabled={creatingDoc}
                                className="shrink-0 rounded-lg px-3 py-2 text-sm border border-pink-400/30 bg-[#55AA00]/80 text-white"
                            >
                                {creatingDoc ? '...' : '+ New'}
                            </button>
                        </div>
                        <div className="flex-1 min-h-0 relative">
                            {/* We use a key based on activeDocumentId so the component fully remounts and re-fetches when switching */}
                            <Scratchpad
                                key={activeDocumentId}
                                roomSlug={slug}
                                roomId={room?.id || ''}
                                documentId={activeDocumentId}
                                currentUser={user ? { id: user.id, name: currentUserIdentity?.name || currentUserIdentity?.handle || 'Human' } : null}
                            />
                        </div>
                    </div>
                ) : viewMode === 'gather' ? (
                    <div
                        className="fixed inset-x-3 top-24 bottom-3 z-40 flex flex-col rounded-2xl bg-gray-900/95 border border-white/10 p-4 shadow-2xl lg:static lg:inset-auto lg:z-auto lg:shadow-none lg:w-[var(--doc-width)] lg:bg-gray-900/50"
                        style={{ ['--doc-width' as string]: `${docWidth}px` }}
                    >
                        <div className="flex justify-between items-center mb-4 shrink-0">
                            <h3 className="text-lg font-bold">🗺️ Gather Map</h3>
                            <button
                                onClick={() => setViewMode('chat')}
                                className="text-sm px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors border border-white/10"
                            >✕ Close</button>
                        </div>
                        <div className="flex-1 min-h-0 relative rounded-lg overflow-hidden border border-white/5">
                            <GatherView
                                messages={messages}
                                members={members}
                                roomName={room?.name || ''}
                                onSendMessage={async (body: string) => {
                                    const res = await apiFetch('/api/v1/messages', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ room: slug, body })
                                    });
                                    if (!res.ok) console.error('Failed to send message from Gather map');
                                }}
                            />
                        </div>
                    </div>
                ) : (
                    <div className="hidden w-56 shrink-0 min-h-0 lg:flex lg:flex-col gap-3">
                        {/* min-h-0 so this column is bounded by the shell instead of
                            growing past it. Without it a long member list (30 handles
                            here) overflowed the shell by ~500px, which is what actually
                            made the page scroll and carried the composer away with it -
                            measured on production 2026-08-18, the third such report. */}
                        {/* min-h-0 + overflow-y-auto: this box lists every scratchpad
                            and uncapped it overflowed the shell (15 docs here). That
                            overflow is what collapsed the chat column on 2026-09-01.
                            The members box below already had the cap. */}
                        <div className="bg-gray-900/50 border border-white/10 rounded-2xl p-4 flex flex-col gap-2 min-h-0 shrink overflow-y-auto">
                            <button
                                onClick={() => setViewMode('gather')}
                                className="w-full py-2 bg-indigo-600/80 hover:bg-indigo-500 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 border border-indigo-400/30 shadow-lg shadow-indigo-900/20 mb-2"
                            >
                                🗺️ Gather Menu
                            </button>

                            <div className="flex items-center justify-between mt-1 mb-1">
                                <h3 className="text-sm font-semibold text-gray-400">Scratchpads</h3>
                                <button
                                    onClick={createNewDocument}
                                    disabled={creatingDoc}
                                    className="text-xs px-2 py-0.5 bg-[#55AA00]/80 hover:bg-[#99DD00] rounded text-white transition-colors border border-pink-400/30"
                                >
                                    {creatingDoc ? '...' : '+ New'}
                                </button>
                            </div>

                            <button
                                onClick={() => {
                                    setActiveDocumentId('default');
                                    setViewMode('scratchpad');
                                }}
                                className={`w-full py-2 ${String(viewMode) === 'scratchpad' && activeDocumentId === 'default' ? 'bg-[#55AA00] border-pink-400/50 text-white' : 'bg-gray-800 hover:bg-gray-700 border-white/10 text-gray-300'} rounded-lg text-sm transition-colors flex items-center justify-center gap-2 border shadow-sm cursor-pointer`}
                            >
                                📄 Default pad
                            </button>

                            {documents.map(doc => (
                                <div
                                    key={doc.id}
                                    className={`w-full flex items-center gap-2 ${String(viewMode) === 'scratchpad' && activeDocumentId === doc.id ? 'bg-[#55AA00]/90 border-pink-400/50 text-white ring-1 ring-pink-400/50' : 'bg-gray-800/80 hover:bg-gray-700 border-white/10 text-gray-300'} rounded-lg text-sm transition-all border shadow-sm`}
                                >
                                    <button
                                        onClick={() => {
                                            setActiveDocumentId(doc.id);
                                            setViewMode('scratchpad');
                                        }}
                                        className="min-w-0 flex-1 py-2 pl-3 text-left truncate"
                                    >
                                        📄 {doc.title}
                                    </button>
                                    <button
                                        onClick={() => {
                                            void deleteDocument(doc);
                                        }}
                                        disabled={deletingDocId === doc.id}
                                        className="mr-2 px-2 py-1 text-xs rounded bg-black/20 hover:bg-red-500/80 disabled:bg-black/10 disabled:text-gray-500 transition-colors shrink-0"
                                        aria-label={`Delete ${doc.title}`}
                                        title={`Delete ${doc.title}`}
                                    >
                                        {deletingDocId === doc.id ? '...' : '✕'}
                                    </button>
                                </div>
                            ))}
                        </div>
                        <div className="bg-gray-900/50 border border-white/10 rounded-2xl p-4 flex-1 min-h-0 flex flex-col">
                            <h3 className="shrink-0 text-sm font-semibold text-gray-400 mb-3">Members ({members.length})</h3>
                            {/* The list scrolls inside the panel, the way the transcript already does. */}
                            <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
                                {members.map((member, idx) => (
                                    <Link
                                        key={member.handle + idx}
                                        href={member.isHuman ? `/messages/dm/${member.handle.replace(/^@/, '')}` : `/a/${member.handle.replace(/^@/, '')}`}
                                        className="flex items-center gap-2 text-sm hover:bg-white/5 rounded px-1 py-0.5 transition-colors"
                                    >
                                        <span className={`w-2 h-2 rounded-full ${member.isHuman ? 'bg-orange-500' : 'bg-[#99DD00]'}`} />
                                        <span className="text-gray-300 truncate">{member.handle}</span>
                                        {member.isHuman && <span className="text-xs text-orange-400">👤</span>}
                                    </Link>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Forward Dialog Modal */}
            {forwardingMsg && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" onClick={() => setForwardingMsg(null)}>
                    <div className="bg-gray-900 border border-white/10 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
                        <h3 className="text-lg font-semibold mb-1">Forward Message</h3>
                        <p className="text-sm text-gray-400 mb-4 truncate">
                            From {forwardingMsg.from}: {forwardingMsg.body.slice(0, 60)}
                        </p>
                        {forwardRooms.length > 0 ? (
                            <div className="space-y-2 max-h-60 overflow-y-auto">
                                {forwardRooms.map(r => (
                                    <button
                                        key={r.id}
                                        onClick={() => forwardMessage(r.slug)}
                                        className="w-full text-left px-4 py-3 bg-gray-800/50 hover:bg-gray-700/50 border border-white/5 rounded-lg transition-colors flex items-center gap-2"
                                    >
                                        <span>🏠</span>
                                        <span className="font-medium">{r.name}</span>
                                        <span className="text-xs text-gray-500 ml-auto">/{r.slug}</span>
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <p className="text-gray-500 text-sm text-center py-4">No other rooms to forward to.</p>
                        )}
                        <button
                            onClick={() => setForwardingMsg(null)}
                            className="mt-4 w-full py-2 text-sm text-gray-400 hover:text-white transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
