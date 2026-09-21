import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './types';

// Module-level singleton. createBrowserClient must be instantiated ONCE per
// browser context: each call creates a separate GoTrueClient with its own
// in-memory session state. Multiple instances (AuthProvider + each page each
// calling createClient()) desync - one instance hydrates the session from the
// cookie while another still returns null, so getSession() in a page could yield
// no token even though the user is signed in. That left bearer-auth requests
// unauthenticated on mobile and triggered the "Multiple GoTrueClient instances"
// warning. Sharing one instance makes getSession() authoritative everywhere.
let browserClient: ReturnType<typeof createBrowserClient<Database>> | undefined;

const MISCONFIGURED =
    'GroupMind is not configured: NEXT_PUBLIC_SUPABASE_URL and ' +
    'NEXT_PUBLIC_SUPABASE_ANON_KEY are missing from the build. ' +
    'These are compiled into the browser bundle, so they must be set BEFORE ' +
    'the app is built - run ./selfhost/gen-env.sh and rebuild with ' +
    '`docker compose up --build`. See SELF-HOSTING.md.';

export function createClient() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !key) {
        // The stub is acceptable while `next build` prerenders (NEXT_PHASE is
        // set by Next.js only then, and is never set in a browser), or when
        // somebody asks for it by name. In a real browser, neither holds and
        // this throws - which is the entire point.
        const mockAllowed =
            process.env.NEXT_PUBLIC_SUPABASE_MOCK === '1'
            || process.env.NEXT_PHASE === 'phase-production-build';
        if (!mockAllowed) {
            throw new Error(MISCONFIGURED);
        }
        return mockBrowserClient();
    }

    if (!browserClient) {
        browserClient = createBrowserClient<Database>(url, key);
    }
    return browserClient;
}

/**
 * A client that does nothing and says nothing went wrong.
 *
 * WHY THIS IS OPT-IN (NEXT_PUBLIC_SUPABASE_MOCK=1) RATHER THAN THE FALLBACK
 * This stub used to be returned automatically whenever the public env vars were
 * missing from the build. Its signInWithPassword and signUp both resolved to
 * `{ error: null }`, which every caller in this codebase reads as success - so
 * the sign-up form congratulated the user and created no account. Nothing was
 * logged, nothing turned red, and the only symptom was that the user could
 * never sign in with the credentials they had just "created".
 *
 * Even in the opt-in mock the auth methods now REJECT rather than resolve
 * clean. A stub exists to let a page render during static generation, not to
 * fake a successful login: a build-time prerender never calls signUp, so
 * nothing legitimate regresses, and anything that does call it is a bug that
 * should be loud.
 */
function mockBrowserClient() {
    const noop = () => stub;
    const stub: any = new Proxy({}, { get: () => noop });
    const refuse = async () => { throw new Error(MISCONFIGURED); };
    stub.auth = {
        // Reads resolve empty: "nobody is signed in" is honestly true here.
        getSession: async () => ({ data: { session: null }, error: null }),
        getUser: async () => ({ data: { user: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        setSession: async () => ({ data: { session: null }, error: null }),
        signOut: async () => ({ error: null }),
        // Writes refuse. These are the ones that used to lie.
        signInWithOAuth: refuse,
        signInWithPassword: refuse,
        signUp: refuse,
    };
    return stub;
}
