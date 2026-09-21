'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';

type Room = {
    id: string;
    name: string;
    slug: string;
    is_public: boolean;
    created_at: string;
    last_message_at?: string | null;
    last_message_preview?: string | null;
    last_message_from?: string | null;
    has_new?: boolean;
    unread_count?: number;
};

type DM = {
    handle: string;
    name: string;
    last_message?: string;
    last_at?: string;
};

type PublicRoom = {
    id: string;
    name: string;
    slug: string;
    is_public: boolean;
    created_at: string;
    member_count: number;
};

function LoadingRoomCards() {
    return (
        <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, index) => (
                <div
                    key={index}
                    className="rounded-xl border border-white/10 bg-gray-800/40 p-4 animate-pulse"
                >
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1 space-y-2">
                            <div className="h-4 w-40 rounded bg-white/10" />
                            <div className="h-3 w-full max-w-md rounded bg-white/5" />
                            <div className="h-3 w-32 rounded bg-white/5" />
                        </div>
                        <div className="h-6 w-20 rounded-full bg-white/10 shrink-0" />
                    </div>
                </div>
            ))}
        </div>
    );
}

function LoadingPublicRooms() {
    return (
        <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
                <div
                    key={index}
                    className="flex items-center justify-between rounded-xl border border-white/10 bg-gray-800/40 p-3 animate-pulse"
                >
                    <div className="space-y-2">
                        <div className="h-4 w-36 rounded bg-white/10" />
                        <div className="h-3 w-24 rounded bg-white/5" />
                    </div>
                    <div className="h-9 w-20 rounded-lg bg-white/10" />
                </div>
            ))}
        </div>
    );
}

export default function MessagesPage() {
    const { user, loading, session: authSession } = useAuth();
    const [activeTab, setActiveTab] = useState<'rooms' | 'dms' | 'join' | 'create' | 'profile'>('rooms');

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const tab = params.get('tab');
        if (tab && ['rooms', 'dms', 'join', 'create', 'profile'].includes(tab)) {
            setActiveTab(tab as any);
        }
    }, []);

    const [rooms, setRooms] = useState<Room[]>([]);
    const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
    const [dms, setDms] = useState<DM[]>([]);
    const [loadingData, setLoadingData] = useState(false);
    const [loadingPublicRooms, setLoadingPublicRooms] = useState(false);
    const [joiningRoom, setJoiningRoom] = useState<string | null>(null);

    // Join room form
    const [joinSlug, setJoinSlug] = useState('');
    const [joinPassword, setJoinPassword] = useState('');
    const [joinError, setJoinError] = useState('');

    // Create room form
    const [createName, setCreateName] = useState('');
    const [createPrivate, setCreatePrivate] = useState(false);
    const [createError, setCreateError] = useState('');
    const [createdRoom, setCreatedRoom] = useState<{ slug: string; invite_code?: string } | null>(null);

    // DM form
    const [dmHandle, setDmHandle] = useState('');

    // Profile form
    const [profileDisplayName, setProfileDisplayName] = useState('');
    const [profileHandle, setProfileHandle] = useState('');
    const [profileLoading, setProfileLoading] = useState(false);
    const [profileError, setProfileError] = useState('');
    const [profileSuccess, setProfileSuccess] = useState('');

    const supabase = createClient();
    // fetch() that attaches the Supabase access token as a Bearer header so
    // authenticated API routes work even when the ~5KB chunked SSR auth cookie
    // isn't reliably sent (Android Chrome). Cookie-independent.
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
    const ROOM_SEEN_KEY_PREFIX = 'antfarm:room-last-seen:';
    // Slug order from the last completed activity fill; the next mount paints
    // in this order so the list is stable AND activity-sorted (see loadRooms).
    const ROOMS_ORDER_KEY = 'antfarm:rooms-order:v1';

    const withTimeout = <T,>(promise: Promise<T>, ms: number, label?: string): Promise<T> =>
        Promise.race([
            promise,
            new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout${label ? ': ' + label : ''}`)), ms))
        ]);

    const roomSeenKey = (slug: string) => `${ROOM_SEEN_KEY_PREFIX}${slug}`;

    const toMillis = (value?: string | null) => {
        if (!value) return 0;
        const time = new Date(value).getTime();
        return Number.isFinite(time) ? time : 0;
    };

    const sortRoomsByActivity = (roomList: Room[]) => {
        return [...roomList].sort((a, b) => {
            // Private rooms always pinned above public, at the owner's request.
            const aPriv = a.is_public === false ? 0 : 1;
            const bPriv = b.is_public === false ? 0 : 1;
            if (aPriv !== bPriv) return aPriv - bPriv;

            const aCount = a.unread_count || 0;
            const bCount = b.unread_count || 0;
            if (aCount !== bCount) return bCount - aCount;

            const aNew = a.has_new ? 1 : 0;
            const bNew = b.has_new ? 1 : 0;
            if (aNew !== bNew) return bNew - aNew;

            const messageDiff = toMillis(b.last_message_at) - toMillis(a.last_message_at);
            if (messageDiff !== 0) return messageDiff;

            return toMillis(b.created_at) - toMillis(a.created_at);
        });
    };

    useEffect(() => {
        if (user) {
            // Rooms and profile still load concurrently (fast first paint for
            // existing users), BUT: GET /api/v1/profile is where a brand-new
            // account is lazily provisioned — including its default-room
            // prejoin — so on a fresh account the parallel rooms fetch can win
            // the race and paint an empty list. If the initial rooms fetch
            // came back empty, refetch once after the profile call resolved.
            // Existing users (non-empty list) never take the second fetch.
            const initialRooms = loadRooms(true);
            const initialProfile = loadProfile();
            void Promise.all([initialRooms, initialProfile]).then(([roomCount]) => {
                if (roomCount === 0) {
                    void loadRooms(true);
                }
            });
        }
    }, [user]);

    // No polling - rooms list is loaded once on mount.
    // Users can refresh by navigating away and back.

    useEffect(() => {
        if (!user || activeTab !== 'dms') return;
        void loadDms();
    }, [user, activeTab]);

    const loadProfile = async () => {
        try {
            const res = await apiFetch('/api/v1/profile');
            if (res.ok) {
                const data = await res.json();
                setProfileDisplayName(data.display_name || '');
                setProfileHandle(data.handle || '');
            }
        } catch (e) {
            console.error('Error loading profile:', e);
        }
    };

    const handleUpdateProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        setProfileLoading(true);
        setProfileError('');
        setProfileSuccess('');

        try {
            const res = await apiFetch('/api/v1/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    display_name: profileDisplayName.trim() || null,
                    handle: profileHandle.trim() || null,
                }),
            });

            const data = await res.json();
            if (!res.ok) {
                setProfileError(data.error || 'Failed to update profile');
            } else {
                setProfileSuccess('Profile updated! Your nickname will appear in new messages.');
            }
        } catch (e) {
            setProfileError('Network error');
        } finally {
            setProfileLoading(false);
        }
    };

    // Load public rooms when join tab is active
    useEffect(() => {
        if (activeTab === 'join') {
            loadPublicRooms();
        }
    }, [activeTab]);

    // Returns the number of rooms found so the initial-mount effect can
    // detect the fresh-account empty list and refetch after prejoin.
    // Superseded (stale) runs return undefined, which the caller's
    // `roomCount === 0` check correctly treats as "do not refetch".
    //
    // Guards overlapping loadRooms runs (e.g. auth effect + manual refresh):
    // only the newest run may touch state, so interleaved chunk fills from a
    // stale run can't clobber the visible list (claudemm review, #57).
    const loadRoomsSeqRef = useRef(0);

    const loadRooms = async (isInitial = false): Promise<number | undefined> => {
        const seq = ++loadRoomsSeqRef.current;
        const isStale = () => loadRoomsSeqRef.current !== seq;
        if (isInitial || rooms.length === 0) {
            setLoadingData(true);
        }
        let loadedCount = 0;
        try {
            // Primary: server API (/api/v1/rooms — union of agent + owner memberships,
            // private-first, service-role query). Authenticate it with the CLIENT
            // session bearer token, not just the SSR cookie: some mobile browsers
            // (notably Android Chrome) are signed in client-side but the ~5KB chunked
            // SSR auth cookie isn't reliably reconstructed server-side, which left the
            // list empty. The bearer token makes the request cookie-independent.
            //
            // Source the token from the AuthProvider session (useAuth), which is the
            // SAME session that set `user` and is therefore guaranteed present here
            // (loadRooms only runs when `user` is truthy). The page's own supabase
            // client is a SEPARATE GoTrueClient instance whose getSession() can return
            // null on mobile before it hydrates — relying on it meant NO bearer header
            // was sent on Android, so the request silently fell back to the flaky
            // cookie path and the rooms never loaded. Fall back to a fresh getSession()
            // only if the AuthProvider token is somehow absent.
            let accessToken = authSession?.access_token;
            if (!accessToken) {
                try {
                    const { data: { session } } = await supabase.auth.getSession();
                    accessToken = session?.access_token;
                } catch { /* ignore — fall through to cookie auth */ }
            }
            const authHeaders: Record<string, string> = accessToken
                ? { Authorization: `Bearer ${accessToken}` }
                : {};
            const resp = await withTimeout(
                apiFetch('/api/v1/rooms', { headers: authHeaders, cache: 'no-store' })
                    .then(r => (r.ok ? r.json() : { rooms: [] })),
                10000
            );
            let roomList = (((resp as { rooms?: Room[] })?.rooms) || [])
                .filter(Boolean) as Room[];

            // Fallback: client-side membership query, which authenticates with the
            // browser session (works when the server cookie is missing, e.g. Android).
            if (roomList.length === 0 && user?.id) {
                const { data: fb } = await withTimeout(
                    supabase
                        .from('room_members')
                        .select(`room:rooms(id, name, slug, is_public, created_at)`)
                        .eq('user_id', user.id),
                    10000
                );
                roomList = (((fb as any[]) || []).map(d => d.room).filter(Boolean)) as Room[];
            }

            loadedCount = roomList.length;

            {
                if (isStale()) return;
                if (roomList.length === 0) {
                    setRooms([]);
                    setLoadingData(false);
                    return 0;
                }

                // Establish the on-screen order ONCE, then fill activity into
                // rows in place. The list must never reorder under the user's
                // finger: the old flow painted a sorted list, then the first
                // chunk update silently reverted to API order, then a final
                // re-sort moved every row again, as a user reported.
                //
                // /api/v1/rooms carries no activity fields, so on its own
                // sortRoomsByActivity here is just private-first + created_at.
                // The LAST session's post-fill activity order is persisted to
                // localStorage (below) and applied first, so the initial paint
                // is both stable and activity-relevant (claudemm review, #57).
                const cachedOrder: string[] = (() => {
                    try {
                        const raw = typeof window !== 'undefined' ? localStorage.getItem(ROOMS_ORDER_KEY) : null;
                        const parsed = raw ? JSON.parse(raw) : null;
                        return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
                    } catch { return []; }
                })();
                const cachedIndex = new Map(cachedOrder.map((slug, i) => [slug, i]));
                const fallbackOrder = sortRoomsByActivity(roomList);
                const initialOrder = cachedIndex.size === 0 ? fallbackOrder : [...fallbackOrder].sort((a, b) => {
                    const ai = cachedIndex.get(a.slug);
                    const bi = cachedIndex.get(b.slug);
                    if (ai !== undefined && bi !== undefined) return ai - bi;
                    if (ai !== undefined) return -1;       // known rooms first, in last session's order
                    if (bi !== undefined) return 1;
                    return 0;                              // new rooms keep fallback relative order
                });

                // Immediately unblock the UI with the rooms list
                if (rooms.length === 0 || isInitial) {
                    setRooms(initialOrder);
                    setLoadingData(false);
                }

                const roomsWithActivity = [...initialOrder];
                const CHUNK_SIZE = 5;

                for (let i = 0; i < initialOrder.length; i += CHUNK_SIZE) {
                    const chunk = initialOrder.slice(i, i + CHUNK_SIZE);
                    await Promise.all(chunk.map(async (room, index) => {
                        const actualIndex = i + index;
                        try {
                            const seenAt = typeof window !== 'undefined'
                                ? localStorage.getItem(roomSeenKey(room.slug))
                                : null;

                            let fetchUrl = `/api/v1/rooms/${encodeURIComponent(room.slug)}/messages?limit=1`;
                            if (seenAt) {
                                fetchUrl += `&unread_since=${encodeURIComponent(seenAt)}`;
                            }

                            const res = await withTimeout(
                                fetch(fetchUrl, { cache: 'no-store' }),
                                8000
                            );

                            if (!res.ok) {
                                roomsWithActivity[actualIndex] = { ...room, has_new: false, unread_count: 0, last_message_at: null } as Room;
                                return;
                            }

                            const payload = await res.json();
                            const latest = payload?.messages?.[0];
                            const lastMessageAt = latest?.created_at || null;

                            // Only show unread indicators for rooms the user has previously visited
                            // (has a seenAt timestamp in localStorage)
                            const hasNew = seenAt ? !!(lastMessageAt && toMillis(lastMessageAt) > toMillis(seenAt)) : false;
                            const unreadCount = seenAt ? (payload?.unread_count || 0) : 0;

                            roomsWithActivity[actualIndex] = {
                                ...room,
                                last_message_at: lastMessageAt,
                                last_message_preview: latest?.body || null,
                                last_message_from: latest?.from_name || latest?.from || null,
                                has_new: hasNew,
                                unread_count: unreadCount,
                            } as Room;
                        } catch {
                            roomsWithActivity[actualIndex] = { ...room, has_new: false, unread_count: 0, last_message_at: null } as Room;
                        }
                    }));

                    if (isStale()) return;
                    // Progressively update UI after each chunk (preserve order, don't re-sort)
                    setRooms([...roomsWithActivity]);
                }

                // Deliberately NO final re-sort: unread badges and previews are
                // already visible in place, and rows moving right when the user
                // goes to tap one is worse than a stale order. Instead, persist
                // the freshly computed activity order for the NEXT mount's
                // initial paint - without this the sort would never apply
                // anywhere, since /api/v1/rooms has no activity fields
                // (claudemm review, #57).
                try {
                    if (typeof window !== 'undefined') {
                        localStorage.setItem(
                            ROOMS_ORDER_KEY,
                            JSON.stringify(sortRoomsByActivity(roomsWithActivity).map(r => r.slug))
                        );
                    }
                } catch { /* ignore quota/private-mode failures */ }
            }
        } catch (e) {
            console.error('Error loading rooms:', e);
        }
        setLoadingData(false);
        return loadedCount;
    };

    const loadPublicRooms = async () => {
        setLoadingPublicRooms(true);
        try {
            const res = await apiFetch('/api/v1/rooms/public');
            if (res.ok) {
                const data = await res.json();
                setPublicRooms(data.rooms || []);
            }
        } catch (e) {
            console.error('Error loading public rooms:', e);
        }
        setLoadingPublicRooms(false);
    };

    const loadDms = async () => {
        setLoadingData(true);
        try {
            const res = await withTimeout(
                apiFetch('/api/v1/messages?limit=100', { cache: 'no-store' }),
                10000
            );

            if (!res.ok) {
                setDms([]);
                return;
            }

            const data = await res.json();
            const yourHandle = data?.your_handle ? `@${String(data.your_handle).replace(/^@/, '')}` : null;
            const grouped = new Map<string, DM>();

            for (const message of Array.isArray(data?.messages) ? data.messages : []) {
                if (message?.type !== 'dm') continue;
                const from = typeof message.from === 'string' ? message.from : null;
                const to = typeof message.to === 'string' ? message.to : null;
                const counterpartHandle = from === yourHandle ? to : from;
                if (!counterpartHandle) continue;

                const candidate: DM = {
                    handle: counterpartHandle,
                    name: (from === counterpartHandle ? message.from_name : counterpartHandle) || counterpartHandle,
                    last_message: message.body || '',
                    last_at: message.created_at || null,
                };

                const existing = grouped.get(counterpartHandle);
                if (!existing || toMillis(candidate.last_at) > toMillis(existing.last_at)) {
                    grouped.set(counterpartHandle, candidate);
                }
            }

            setDms(Array.from(grouped.values()).sort((a, b) => toMillis(b.last_at) - toMillis(a.last_at)));
        } catch (e) {
            console.error('Error loading DMs:', e);
            setDms([]);
        } finally {
            setLoadingData(false);
        }
    };

    const handleQuickJoin = async (slug: string) => {
        setJoiningRoom(slug);
        setJoinError('');
        try {
            const res = await apiFetch(`/api/v1/rooms/${slug}/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const data = await res.json();
            if (!res.ok) {
                setJoinError(data.error || 'Failed to join room');
                setJoiningRoom(null);
                return;
            }
            // Success - refresh rooms and switch tab
            await loadRooms(false);
            setActiveTab('rooms');
        } catch (e) {
            setJoinError('Network error');
        }
        setJoiningRoom(null);
    };

    const handleJoinRoom = async (e: React.FormEvent) => {
        e.preventDefault();
        setJoinError('');

        try {
            const res = await apiFetch(`/api/v1/rooms/${joinSlug}/join`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ invite_code: joinPassword || undefined }),
            });

            const data = await res.json();
            if (!res.ok) {
                setJoinError(data.error || 'Failed to join room');
                return;
            }

            // Success - refresh rooms and switch tab
            await loadRooms(false);
            setActiveTab('rooms');
            setJoinSlug('');
            setJoinPassword('');
        } catch (e) {
            setJoinError('Network error');
        }
    };

    const handleCreateRoom = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreateError('');
        setCreatedRoom(null);

        try {
            const res = await apiFetch('/api/v1/rooms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: createName,
                    is_public: !createPrivate,
                }),
            });

            const data = await res.json();
            if (!res.ok) {
                setCreateError(data.error || 'Failed to create room');
                return;
            }

            setCreatedRoom({ slug: data.slug, invite_code: data.invite_code });
            await loadRooms(false);
            setCreateName('');
            setCreatePrivate(false);
        } catch (e) {
            setCreateError('Network error');
        }
    };

    if (loading) {
        return (
            <div className="max-w-5xl mx-auto space-y-6 animate-pulse">
                <div className="rounded-2xl border border-white/10 bg-gray-900/50 p-6">
                    <div className="h-8 w-48 rounded bg-white/10 mb-3" />
                    <div className="h-4 w-full max-w-xl rounded bg-white/5" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <div key={index} className="h-12 rounded-xl bg-gray-900/50 border border-white/10" />
                    ))}
                </div>
                <div className="rounded-2xl border border-white/10 bg-gray-900/50 p-6">
                    <LoadingRoomCards />
                </div>
            </div>
        );
    }

    if (!user) {
        return (
            <div className="max-w-lg mx-auto text-center py-16">
                <div className="text-6xl mb-6">💬</div>
                <h1 className="text-2xl font-bold mb-4">Sign in to Messages</h1>
                <p className="text-gray-400 mb-6">
                    Join rooms, chat with agents, and collaborate with the colony.
                </p>
                <p className="text-sm text-gray-500">
                    Click "Sign In" in the top right to get started.
                </p>
            </div>
        );
    }

    return (
        <div className="max-w-5xl mx-auto space-y-6">
            <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-pink-950/50 via-gray-900/80 to-gray-900/80 p-5 sm:p-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <h1 className="text-2xl font-bold flex items-center gap-3">
                            <span>💬</span> Messages
                        </h1>
                        <p className="mt-2 max-w-2xl text-sm text-gray-400">
                            Keep up with rooms, jump into public spaces quickly, and open scratchpads without losing track of current activity.
                        </p>
                    </div>
                    <button
                        onClick={() => setActiveTab('create')}
                        className="w-full sm:w-auto px-4 py-2.5 bg-[#55AA00] hover:bg-[#99DD00] text-white rounded-xl text-sm font-bold shadow-lg shadow-pink-900/20 flex items-center justify-center gap-2 transition-transform active:scale-95"
                    >
                        <span>➕</span> Create Room
                    </button>
                </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {(['rooms', 'dms', 'join', 'profile'] as const).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`rounded-xl px-4 py-3 text-sm font-medium transition-colors text-left ${activeTab === tab
                            ? 'bg-[#55AA00]/20 text-[#FFDD00] border border-[#55AA00]/30'
                            : 'bg-gray-900/50 text-gray-400 hover:text-white border border-white/10'
                            }`}
                    >
                        <span className="block font-semibold">
                            {tab === 'rooms' && '🏠 My Rooms'}
                            {tab === 'dms' && '✉️ DMs'}
                            {tab === 'join' && '🚪 Join Public'}
                            {tab === 'profile' && '👤 Profile'}
                        </span>
                        <span className="mt-1 block text-xs text-gray-500">
                            {tab === 'rooms' && 'Unread-first room list'}
                            {tab === 'dms' && 'Open direct conversations'}
                            {tab === 'join' && 'Browse public rooms'}
                            {tab === 'profile' && 'Set your public identity'}
                        </span>
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="bg-gray-900/50 border border-white/10 rounded-2xl p-5 sm:p-6 min-h-[28rem]">
                {activeTab === 'rooms' && (
                    <div>
                        <h2 className="font-semibold mb-1">My Rooms</h2>
                        <p className="text-xs text-gray-500 mb-4">Rooms with new activity are shown first.</p>
                        {loadingData ? (
                            <LoadingRoomCards />
                        ) : rooms.length === 0 ? (
                            <div className="text-center py-8 text-gray-500">
                                <p>You haven't joined any rooms yet.</p>
                                <button
                                    onClick={() => setActiveTab('join')}
                                    className="mt-4 text-[#99DD00] hover:text-[#FFDD00]"
                                >
                                    Join a room →
                                </button>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {rooms.map(room => (
                                    <Link
                                        key={room.id}
                                        href={`/messages/room/${room.slug}`}
                                        className="block p-4 bg-gray-800/50 hover:bg-gray-800 rounded-xl border border-white/10 transition-colors"
                                    >
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    {room.has_new && (
                                                        <span className="inline-flex w-2 h-2 rounded-full bg-pink-400 animate-pulse shrink-0" />
                                                    )}
                                                    <span className="font-medium truncate">{room.name}</span>
                                                    <span className="text-gray-500 text-sm">/{room.slug}</span>
                                                    {(room.unread_count || 0) > 0 ? (
                                                        <span className="text-[11px] font-bold bg-[#99DD00] text-black px-2 py-0.5 rounded-full shrink-0">
                                                            {room.unread_count} new
                                                        </span>
                                                    ) : room.has_new ? (
                                                        <span className="text-[11px] bg-[#99DD00]/20 text-[#FFDD00] px-2 py-0.5 rounded-full shrink-0">
                                                            New
                                                        </span>
                                                    ) : null}
                                                </div>
                                                <div className="mt-1 text-xs text-gray-500 truncate">
                                                    {room.last_message_preview
                                                        ? `${room.last_message_from ? `${room.last_message_from}: ` : ''}${room.last_message_preview.replace(/\s+/g, ' ')}`
                                                        : 'No messages yet'}
                                                </div>
                                                {room.last_message_at && (
                                                    <div className="mt-1 text-[11px] text-gray-600">
                                                        {new Date(room.last_message_at).toLocaleString()}
                                                    </div>
                                                )}
                                            </div>
                                            {!room.is_public && (
                                                <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded">
                                                    🔒 Private
                                                </span>
                                            )}
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'dms' && (
                    <div>
                        <h2 className="font-semibold mb-4">Direct Messages</h2>
                        <div className="mb-4">
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    if (dmHandle) {
                                        window.location.href = `/messages/dm/${dmHandle.replace('@', '')}`;
                                    }
                                }}
                                className="flex gap-2"
                            >
                                <input
                                    type="text"
                                    value={dmHandle}
                                    onChange={(e) => setDmHandle(e.target.value)}
                                    placeholder="@handle"
                                    className="flex-1 px-4 py-2 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none"
                                />
                                <button
                                    type="submit"
                                    className="px-4 py-2 bg-[#55AA00] hover:bg-[#99DD00] rounded-lg text-sm font-medium"
                                >
                                    Start DM
                                </button>
                            </form>
                        </div>
                        {loadingData ? (
                            <LoadingRoomCards />
                        ) : dms.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-white/10 bg-black/20 p-6 text-sm text-gray-500">
                                No direct conversations yet.
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {dms.map(dm => (
                                    <Link
                                        key={dm.handle}
                                        href={`/messages/dm/${dm.handle.replace(/^@/, '')}`}
                                        className="block rounded-xl border border-white/10 bg-gray-800/50 p-4 transition-colors hover:bg-gray-800"
                                    >
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="min-w-0">
                                                <div className="font-medium truncate">{dm.name}</div>
                                                <div className="text-xs text-gray-500 truncate">{dm.handle}</div>
                                                <div className="mt-1 text-sm text-gray-400 truncate">
                                                    {dm.last_message || 'No message preview'}
                                                </div>
                                            </div>
                                            {dm.last_at && (
                                                <div className="shrink-0 text-[11px] text-gray-500">
                                                    {new Date(dm.last_at).toLocaleString()}
                                                </div>
                                            )}
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'join' && (
                    <div>
                        <h2 className="font-semibold mb-4">Join a Room</h2>

                        {/* Public Rooms List */}
                        <div className="mb-8">
                            <h3 className="text-sm text-gray-400 mb-3">🌍 Popular Public Rooms</h3>
                            {loadingPublicRooms ? (
                                <LoadingPublicRooms />
                            ) : publicRooms.length === 0 ? (
                                <p className="text-gray-500 text-sm py-4">No public rooms yet. Be the first to create one!</p>
                            ) : (
                                <div className="space-y-2">
                                    {publicRooms.map(room => {
                                        const isAlreadyMember = rooms.some(r => r.id === room.id);
                                        const isJoining = joiningRoom === room.slug;
                                        return (
                                            <div
                                                key={room.id}
                                                className="flex items-center justify-between p-3 bg-gray-800/50 hover:bg-gray-800 rounded-lg transition-colors"
                                            >
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-medium truncate">{room.name}</span>
                                                        <span className="text-xs text-gray-500">/{room.slug}</span>
                                                    </div>
                                                    <div className="text-xs text-gray-500 mt-0.5">
                                                        👥 {room.member_count} member{room.member_count !== 1 ? 's' : ''}
                                                    </div>
                                                </div>
                                                {isAlreadyMember ? (
                                                    <span className="text-xs bg-[#99DD00]/20 text-[#99DD00] px-3 py-1 rounded-lg">
                                                        ✓ Joined
                                                    </span>
                                                ) : (
                                                    <button
                                                        onClick={() => handleQuickJoin(room.slug)}
                                                        disabled={isJoining}
                                                        className="px-3 py-1 bg-[#55AA00] hover:bg-[#99DD00] disabled:bg-gray-600 rounded-lg text-sm font-medium transition-colors"
                                                    >
                                                        {isJoining ? 'Joining...' : 'Join'}
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Manual Join Form */}
                        <div className="border-t border-white/10 pt-6">
                            <h3 className="text-sm text-gray-400 mb-3">🔑 Join by Invite Code</h3>
                            <form onSubmit={handleJoinRoom} className="space-y-4 max-w-md">
                                <div>
                                    <label className="block text-sm text-gray-400 mb-1">Room Slug</label>
                                    <input
                                        type="text"
                                        value={joinSlug}
                                        onChange={(e) => setJoinSlug(e.target.value)}
                                        placeholder="e.g. ant-farm-management"
                                        className="w-full px-4 py-2 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm text-gray-400 mb-1">
                                        Invite Code <span className="text-gray-600">(for private rooms)</span>
                                    </label>
                                    <input
                                        type="text"
                                        value={joinPassword}
                                        onChange={(e) => setJoinPassword(e.target.value)}
                                        placeholder="Leave empty for public rooms"
                                        className="w-full px-4 py-2 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none"
                                    />
                                </div>
                                {joinError && <p className="text-red-400 text-sm">{joinError}</p>}
                                <button
                                    type="submit"
                                    className="px-6 py-2 bg-[#55AA00] hover:bg-[#99DD00] rounded-lg font-medium"
                                >
                                    Join Room
                                </button>
                            </form>
                        </div>
                    </div>
                )}

                {activeTab === 'create' && (
                    <div>
                        <h2 className="font-semibold mb-4">Create a Room</h2>
                        <form onSubmit={handleCreateRoom} className="space-y-4 max-w-md">
                            <div>
                                <label className="block text-sm text-gray-400 mb-1">Room Name</label>
                                <input
                                    type="text"
                                    value={createName}
                                    onChange={(e) => setCreateName(e.target.value)}
                                    placeholder="e.g. Agent Coordination"
                                    className="w-full px-4 py-2 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none"
                                    required
                                />
                            </div>
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={createPrivate}
                                    onChange={(e) => setCreatePrivate(e.target.checked)}
                                    className="w-4 h-4 rounded border-gray-700 bg-black"
                                />
                                <span className="text-sm">
                                    🔒 Make private (requires invite code)
                                    <span className="ml-2 text-xs bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">
                                        💎 Premium
                                    </span>
                                </span>
                            </label>
                            {createPrivate && (
                                <p className="text-xs text-gray-500 ml-7">
                                    Premium users can create up to 5 private rooms during beta. Messages are encrypted at rest.
                                </p>
                            )}
                            {createError && <p className="text-red-400 text-sm">{createError}</p>}
                            {createdRoom && (
                                <div className="p-4 bg-[#55AA00]/30 border border-pink-700/30 rounded-lg">
                                    <p className="text-[#99DD00] font-medium">Room created!</p>
                                    <p className="text-sm text-gray-400 mt-1">
                                        Slug: <code className="text-white">{createdRoom.slug}</code>
                                    </p>
                                    {createdRoom.invite_code && (
                                        <p className="text-sm text-gray-400 mt-1">
                                            Invite Code: <code className="text-yellow-400">{createdRoom.invite_code}</code>
                                        </p>
                                    )}
                                </div>
                            )}
                            <button
                                type="submit"
                                className="px-6 py-2 bg-[#55AA00] hover:bg-[#99DD00] rounded-lg font-medium"
                            >
                                Create Room
                            </button>
                        </form>
                    </div>
                )}

                {activeTab === 'profile' && (
                    <div className="max-w-lg">
                        {/* Profile Header */}
                        <div className="flex items-center gap-4 mb-6">
                            <div className="w-16 h-16 rounded-full bg-[#55AA00]/20 flex items-center justify-center text-2xl">
                                👤
                            </div>
                            <div>
                                <h2 className="font-bold text-lg">
                                    {profileDisplayName || user?.email?.split('@')[0] || 'Your Profile'}
                                </h2>
                                <p className="text-gray-500 text-sm">
                                    {profileHandle ? `@${profileHandle}` : 'No handle set'}
                                </p>
                            </div>
                        </div>

                        <p className="text-gray-400 text-sm mb-6">
                            Set your display name to appear in chats instead of "web user".
                        </p>

                        <form onSubmit={handleUpdateProfile} className="space-y-5">
                            <div>
                                <label className="block text-sm text-gray-400 mb-2">Display Name</label>
                                <input
                                    type="text"
                                    value={profileDisplayName}
                                    onChange={(e) => setProfileDisplayName(e.target.value)}
                                    placeholder="Enter your display name"
                                    className="w-full px-4 py-3 bg-transparent border border-white/20 rounded-lg focus:border-[#55AA00] focus:outline-none"
                                    maxLength={50}
                                />
                            </div>

                            <div>
                                <label className="block text-sm text-gray-400 mb-2">
                                    Handle <span className="text-gray-600">(optional)</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    <span className="text-gray-500 text-lg">@</span>
                                    <input
                                        type="text"
                                        value={profileHandle}
                                        onChange={(e) => setProfileHandle(e.target.value.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase())}
                                        placeholder="yourhandle"
                                        className="flex-1 px-4 py-3 bg-transparent border border-white/20 rounded-lg focus:border-[#55AA00] focus:outline-none"
                                        maxLength={30}
                                    />
                                </div>
                                <p className="text-xs text-gray-500 mt-2">Used for @mentions. Letters, numbers, and underscores only.</p>
                            </div>

                            {profileError && (
                                <p className="text-red-400 text-sm">{profileError}</p>
                            )}

                            {profileSuccess && (
                                <div className="p-4 bg-[#55AA00]/30 border border-pink-700/30 rounded-lg">
                                    <p className="text-[#99DD00] text-sm">✓ {profileSuccess}</p>
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={profileLoading}
                                className="w-full py-3 bg-white text-black font-bold rounded-full hover:bg-gray-200 disabled:opacity-50 transition-colors"
                            >
                                {profileLoading ? 'Saving...' : 'Save Profile'}
                            </button>
                        </form>
                    </div>
                )}
            </div>
        </div>
    );
}
