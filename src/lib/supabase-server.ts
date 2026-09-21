// SPDX-License-Identifier: AGPL-3.0-only
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from './types';
import { serverSupabaseUrl } from './supabase-url';

export async function createClient() {
    const cookieStore = await cookies();

    return createServerClient<Database>(
        serverSupabaseUrl()!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options)
                        );
                    } catch {
                        // Server Component - cookies are read-only
                    }
                },
            },
        }
    );
}
