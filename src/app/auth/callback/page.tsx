'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

export default function AuthCallback() {
    const router = useRouter();

    useEffect(() => {
        const supabase = createClient();

        const query = new URLSearchParams(window.location.search);
        const next = query.get('next') || '/messages';
        const code = query.get('code');
        const queryError = query.get('error_description') || query.get('error');

        if (queryError) {
            router.replace('/?auth_error=' + encodeURIComponent(queryError));
            return;
        }

        if (code) {
            supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
                if (error) {
                    router.replace('/?auth_error=' + encodeURIComponent(error.message));
                } else {
                    router.replace(next);
                }
            });
            return;
        }

        // Implicit flow fallback: tokens in URL hash (#access_token=...&refresh_token=...)
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');

        if (accessToken && refreshToken) {
            // Set session on createBrowserClient so tokens get stored in cookies
            supabase.auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken,
            }).then(({ error }) => {
                if (error) {
                    router.replace('/?auth_error=' + encodeURIComponent(error.message));
                } else {
                    router.replace(next);
                }
            });
        } else {
            // Check if session already exists (e.g. from a previous login)
            supabase.auth.getSession().then(({ data: { session } }) => {
                if (session) {
                    router.replace(next);
                } else {
                    router.replace('/');
                }
            });
        }
    }, [router]);

    return (
        <div className="flex items-center justify-center min-h-[50vh]">
            <div className="text-gray-400">Signing in...</div>
        </div>
    );
}
