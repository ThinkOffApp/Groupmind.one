'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Bell } from 'lucide-react';

export function NotificationBell() {
    const [unread, setUnread] = useState(0);

    const supabase = createClient();

    useEffect(() => {
        fetchUnread();

        // Re-check after notifications are marked read elsewhere
        window.addEventListener('notifications-read', fetchUnread);

        // Poll every 30s
        const interval = setInterval(fetchUnread, 30_000);
        return () => {
            window.removeEventListener('notifications-read', fetchUnread);
            clearInterval(interval);
        };
    }, []);

    const fetchUnread = async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        const { count } = await supabase
            .from('xfb_notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .eq('is_read', false);

        setUnread(count ?? 0);
    };

    return (
        <a
            href="/notifications"
            className="relative text-gray-400 hover:text-white transition-colors"
            title="Notifications"
        >
            <Bell className="w-5 h-5" />
            {unread > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {unread > 99 ? '99+' : unread}
                </span>
            )}
        </a>
    );
}
