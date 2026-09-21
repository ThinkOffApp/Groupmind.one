// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';

type RoomInfo = {
    id: string;
    name: string;
    slug: string;
    last_message_preview?: string | null;
    last_message_from?: string | null;
    last_message_at?: string | null;
};

function timeAgo(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const seconds = Math.floor((now - then) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export function HomeDashboard({ children }: { children: React.ReactNode }) {
    const { user, loading } = useAuth();
    const [rooms, setRooms] = useState<RoomInfo[]>([]);
    const [loadingRooms, setLoadingRooms] = useState(false);

    useEffect(() => {
        if (!user) return;
        setLoadingRooms(true);
        const supabase = createClient();

        (async () => {
            try {
                const { data } = await supabase
                    .from('room_members')
                    .select('room:rooms(id, name, slug)')
                    .eq('user_id', user.id);

                if (!data) { setLoadingRooms(false); return; }

                const roomList = (data as any[]).map(d => d.room).filter(Boolean) as RoomInfo[];

                // Fetch last message for each room (max 8)
                const enriched = await Promise.all(
                    roomList.slice(0, 8).map(async (room) => {
                        try {
                            const res = await fetch(`/api/v1/rooms/${encodeURIComponent(room.slug)}/messages?limit=1`, { cache: 'no-store' });
                            if (!res.ok) return room;
                            const payload = await res.json();
                            const latest = payload?.messages?.[0];
                            return {
                                ...room,
                                last_message_preview: latest?.body || null,
                                last_message_from: latest?.from_name || latest?.from || null,
                                last_message_at: latest?.created_at || null,
                            };
                        } catch {
                            return room;
                        }
                    })
                );

                // Sort by last message time
                enriched.sort((a, b) => {
                    const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
                    const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
                    return bt - at;
                });

                setRooms(enriched);
            } catch (e) {
                console.error('Error loading dashboard rooms:', e);
            }
            setLoadingRooms(false);
        })();
    }, [user]);

    // Not logged in: show the normal homepage content
    if (loading || !user) {
        return <>{children}</>;
    }

    // Logged in: show personalized dashboard instead
    return (
        <div className="space-y-12">
            {/* Your Rooms */}
            <section className="space-y-6">
                <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <h2 className="text-xl font-semibold text-white">Your Rooms</h2>
                    <Link href="/messages" className="text-sm text-[#99DD00] hover:text-[#55AA00] transition-colors">All Rooms &rarr;</Link>
                </div>
                {loadingRooms ? (
                    <div className="grid gap-3">
                        {Array.from({ length: 3 }).map((_, i) => (
                            <div key={i} className="rounded-xl border border-white/5 bg-white/5 p-4 animate-pulse">
                                <div className="h-4 w-40 rounded bg-white/10 mb-2" />
                                <div className="h-3 w-full max-w-md rounded bg-white/5" />
                            </div>
                        ))}
                    </div>
                ) : rooms.length > 0 ? (
                    <div className="grid gap-3">
                        {rooms.map((room) => (
                            <Link
                                key={room.id}
                                href={`/messages/room/${room.slug}`}
                                className="group flex items-start justify-between p-4 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 transition-colors"
                            >
                                <div className="flex items-start gap-4 min-w-0">
                                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#FFDD00]/20 to-[#99DD00]/20 flex items-center justify-center text-lg border border-[#99DD00]/30 flex-shrink-0 mt-0.5">
                                        💬
                                    </div>
                                    <div className="min-w-0">
                                        <span className="font-medium text-white group-hover:text-[#99DD00] transition-colors block">{room.name}</span>
                                        {room.last_message_preview && (
                                            <p className="text-sm text-gray-500 truncate max-w-md">
                                                {room.last_message_from && <span className="text-gray-400">{room.last_message_from}: </span>}
                                                {room.last_message_preview}
                                            </p>
                                        )}
                                    </div>
                                </div>
                                {room.last_message_at && (
                                    <span className="text-xs text-gray-600 flex-shrink-0 ml-4 mt-1">{timeAgo(room.last_message_at)}</span>
                                )}
                            </Link>
                        ))}
                    </div>
                ) : (
                    <p className="text-gray-500">No rooms yet. <Link href="/messages?tab=join" className="text-[#99DD00] hover:underline">Join one</Link></p>
                )}
            </section>

            {/* Quick Links */}
            <section className="space-y-6">
                <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <h2 className="text-xl font-semibold text-white">Quick Access</h2>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <Link href="/messages?tab=dms" className="group p-4 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 transition-colors text-center">
                        <div className="text-2xl mb-2">✉️</div>
                        <span className="text-sm text-gray-400 group-hover:text-white transition-colors">DMs</span>
                    </Link>
                    <Link href="/scratchpads" className="group p-4 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 transition-colors text-center">
                        <div className="text-2xl mb-2">📝</div>
                        <span className="text-sm text-gray-400 group-hover:text-white transition-colors">Scratchpads</span>
                    </Link>
                    <Link href="/intent" className="group p-4 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 transition-colors text-center">
                        <div className="text-2xl mb-2">🧠</div>
                        <span className="text-sm text-gray-400 group-hover:text-white transition-colors">Fleet</span>
                    </Link>
                    <a href="https://xfor.bot" target="_blank" rel="noopener noreferrer" className="group p-4 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 transition-colors text-center">
                        <div className="text-2xl mb-2">🌐</div>
                        <span className="text-sm text-gray-400 group-hover:text-white transition-colors">xfor.bot</span>
                    </a>
                </div>
            </section>
        </div>
    );
}
