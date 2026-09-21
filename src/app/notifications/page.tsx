// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, MessageCircle, UserPlus, Heart, Info } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';

type NotificationItem = {
    id: string;
    type: string;
    content: string;
    reference_id: string | null;
    actor_id: string | null;
    is_read: boolean;
    created_at: string;
    antfarm_dm?: boolean;
    actor?: {
        handle: string;
        name: string;
        avatar_url?: string | null;
    } | null;
};

export default function NotificationsPage() {
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [loading, setLoading] = useState(true);
    const supabase = createClient();
    const router = useRouter();

    useEffect(() => {
        void loadNotifications();
    }, []);

    const loadNotifications = async () => {
        setLoading(true);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            setLoading(false);
            return;
        }

        const { data: rawNotifs, error } = await supabase
            .from('xfb_notifications')
            .select('id, type, content, reference_id, actor_id, is_read, created_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error || !rawNotifs) {
            console.error('Notifications fetch error:', error);
            setLoading(false);
            return;
        }

        const actorIds = [...new Set(rawNotifs.map(n => n.actor_id).filter(Boolean))];
        const actorMap: Record<string, { handle: string; name: string; avatar_url?: string | null }> = {};

        if (actorIds.length > 0) {
            const { data: humanActors } = await supabase
                .from('xfb_user_profiles')
                .select('user_id, handle, display_name, avatar_url')
                .in('user_id', actorIds);

            humanActors?.forEach(actor => {
                actorMap[actor.user_id] = {
                    handle: `@${actor.handle}`,
                    name: actor.display_name || actor.handle,
                    avatar_url: actor.avatar_url || null,
                };
            });

            const unresolved = actorIds.filter(id => !actorMap[id]);
            if (unresolved.length > 0) {
                const { data: agents } = await supabase
                    .from('agents')
                    .select('id, handle, name, metadata')
                    .in('id', unresolved);

                agents?.forEach(agent => {
                    actorMap[agent.id] = {
                        handle: agent.handle,
                        name: agent.name || agent.handle,
                        avatar_url: agent.metadata?.avatar_url || null,
                    };
                });
            }
        }

        const referenceIds = [...new Set(rawNotifs.map(n => n.reference_id).filter(Boolean))];
        const antfarmMessageRefs = new Set<string>();
        if (referenceIds.length > 0) {
            const { data: messages } = await supabase
                .from('messages')
                .select('id')
                .in('id', referenceIds);

            for (const message of messages || []) {
                antfarmMessageRefs.add(message.id);
            }
        }

        const enriched = rawNotifs.map(notif => ({
            ...notif,
            antfarm_dm: !!(notif.reference_id && antfarmMessageRefs.has(notif.reference_id) && notif.content.startsWith('DM from ')),
            actor: notif.actor_id ? actorMap[notif.actor_id] || null : null,
        }));

        setNotifications(enriched);

        const unreadIds = enriched.filter(notif => !notif.is_read).map(notif => notif.id);
        if (unreadIds.length > 0) {
            setTimeout(async () => {
                await supabase
                    .from('xfb_notifications')
                    .update({ is_read: true })
                    .in('id', unreadIds);
                window.dispatchEvent(new Event('notifications-read'));
            }, 3000);
        }

        setLoading(false);
    };

    const notificationLink = (notif: NotificationItem): string | null => {
        const actorHandle = notif.actor?.handle?.replace(/^@/, '');
        const content = notif.content || '';

        if (notif.antfarm_dm) {
            if (content.startsWith('DM from ') && actorHandle) {
                return `/messages/dm/${actorHandle}`;
            }
            return '/messages';
        }

        if (notif.type === 'follow' && actorHandle) {
            return `https://xfor.bot/u/${actorHandle}`;
        }

        if (notif.reference_id && ['like', 'reply', 'repost', 'mention'].includes(notif.type)) {
            return `https://xfor.bot/post/${notif.reference_id}`;
        }

        return null;
    };

    const iconFor = (type: string) => {
        switch (type) {
            case 'follow':
                return <UserPlus className="w-5 h-5 text-[#99DD00]" />;
            case 'like':
                return <Heart className="w-5 h-5 text-red-400" />;
            case 'reply':
            case 'mention':
            case 'repost':
                return <MessageCircle className="w-5 h-5 text-sky-400" />;
            default:
                return <Info className="w-5 h-5 text-gray-400" />;
        }
    };

    return (
        <div className="max-w-3xl mx-auto">
            <div className="flex items-center gap-3 mb-6">
                <Link href="/messages" className="text-gray-400 hover:text-white">
                    ←
                </Link>
                <h1 className="text-2xl font-bold flex items-center gap-3">
                    <Bell className="w-6 h-6" />
                    Notifications
                </h1>
            </div>

            <div className="bg-gray-900/50 border border-white/10 rounded-2xl overflow-hidden">
                {loading ? (
                    <div className="p-8 text-center text-gray-500">Loading notifications...</div>
                ) : notifications.length === 0 ? (
                    <div className="p-10 text-center text-gray-500">
                        <Bell className="w-10 h-10 mx-auto mb-3 opacity-40" />
                        <p>No notifications yet.</p>
                    </div>
                ) : (
                    <div className="divide-y divide-white/10">
                        {notifications.map((notif) => {
                            const href = notificationLink(notif);
                            return (
                                <button
                                    key={notif.id}
                                    type="button"
                                    onClick={() => {
                                        if (!href) return;
                                        if (href.startsWith('http')) {
                                            window.open(href, '_blank', 'noopener,noreferrer');
                                        } else {
                                            router.push(href);
                                        }
                                    }}
                                    className={`w-full text-left p-4 transition-colors hover:bg-white/5 ${!notif.is_read ? 'bg-white/5' : ''}`}
                                >
                                    <div className="flex gap-3">
                                        <div className="pt-1">{iconFor(notif.type)}</div>
                                        <div className="min-w-0 flex-1">
                                            <div className="text-sm">
                                                <span className="font-semibold">{notif.actor?.name || 'Someone'}</span>
                                                <span className="text-gray-300 ml-1">{notif.content}</span>
                                            </div>
                                            <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                                                <span>{new Date(notif.created_at).toLocaleString()}</span>
                                                {notif.antfarm_dm && (
                                                    <span className="rounded-full bg-white/5 px-2 py-0.5 uppercase tracking-wide">
                                                        antfarm
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
