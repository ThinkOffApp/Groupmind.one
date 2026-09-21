// SPDX-License-Identifier: AGPL-3.0-only
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { serverSupabaseUrl } from './supabase-url';

let _instance: SupabaseClient | null = null;

/**
 * Singleton service-role Supabase client.
 * Bypasses RLS - use only in API routes and server-side code.
 */
export function getServiceSupabase(): SupabaseClient {
    if (!_instance) {
        if (!serverSupabaseUrl() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
            if (!mockAllowed()) {
                throw new Error(
                    'Supabase is not configured. ' +
                    (!serverSupabaseUrl()
                        ? 'NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_INTERNAL_URL) is not set. '
                        : '') +
                    (!process.env.SUPABASE_SERVICE_ROLE_KEY
                        ? 'SUPABASE_SERVICE_ROLE_KEY is not set. '
                        : '') +
                    'Run ./selfhost/gen-env.sh to generate a .env for the local stack, ' +
                    'or set these from your hosted Supabase project settings. ' +
                    'See SELF-HOSTING.md. ' +
                    'To run without a database on purpose, set SUPABASE_MOCK=1 - ' +
                    'the mock answers every query with no rows and must never be used to serve users.'
                );
            }
            return mockServiceClient();
        }
        _instance = createClient(
            serverSupabaseUrl()!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } }
        );
    }
    return _instance;
}

/**
 * When a client with no database behind it is acceptable.
 *
 * TWO CASES, AND ONLY TWO:
 *
 *  - `next build`. Page-data collection imports every route module, and many of
 *    them call this at module scope. There is no database during a build and
 *    there is no user to mislead, so the stub is correct here. NEXT_PHASE is set
 *    by Next.js itself for exactly this phase and is absent at runtime, which is
 *    what makes it a usable signal rather than a guess.
 *  - SUPABASE_MOCK=1, set deliberately by someone who wants it.
 *
 * Everything else throws. That is the whole point of this file.
 */
function mockAllowed(): boolean {
    return process.env.SUPABASE_MOCK === '1'
        || process.env.NEXT_PHASE === 'phase-production-build';
}

/**
 * A client that answers every query with "no rows".
 *
 * WHY THIS IS OPT-IN (SUPABASE_MOCK=1) RATHER THAN THE FALLBACK
 * This used to be what you got automatically whenever the environment was
 * incomplete. It is indistinguishable from a working database that happens to
 * be empty: `{ data: null, error: null }` is a successful query with no rows.
 * So a misconfigured instance served every page with HTTP 200 and a calm empty
 * state, and the operator had nothing to go on. Throwing instead turns
 * "beautiful empty page, no error" into a sentence that names the missing
 * variable.
 *
 * It is still reachable, because building with no database is a real and
 * necessary case, but only in the two situations mockAllowed() names.
 */
function mockServiceClient(): SupabaseClient {
    console.warn(
        '[supabase] No database configured; every query will return no rows. ' +
        'This is a build-time stub, not a database.'
    );
    // Deep enough to survive static prerendering's `.from(..).select(..)..` chains.
    const mockChain: any = {
        select: () => mockChain,
        insert: () => mockChain,
        update: () => mockChain,
        delete: () => mockChain,
        eq: () => mockChain,
        neq: () => mockChain,
        filter: () => mockChain,
        order: () => mockChain,
        single: () => mockChain,
        maybeSingle: () => mockChain,
        limit: () => mockChain,
        range: () => mockChain,
        match: () => mockChain,
        then: (resolve: any) => resolve({ data: null, error: null })
    };
    return {
        from: () => mockChain,
        auth: { getUser: async () => ({ data: { user: null } }) }
    } as unknown as SupabaseClient;
}
