// The URL the SERVER should use to reach Supabase.
//
// WHY THIS EXISTS
// In the self-host stack the browser reaches the Kong gateway on
// http://localhost:8000, so that is what NEXT_PUBLIC_SUPABASE_URL has to be -
// it is compiled into the browser bundle. But inside the app container
// "localhost" is the app container itself; the gateway is a different
// container, reachable as http://kong:8000.
//
// Server components and API routes that used NEXT_PUBLIC_SUPABASE_URL therefore
// failed with ECONNREFUSED. Because the query errors are swallowed, the pages
// still returned HTTP 200 and rendered a calm empty state - indistinguishable
// from "you have no data yet". That is the precise failure mode this stack
// exists to prevent.
//
// Hosted deployments leave SUPABASE_INTERNAL_URL unset and are unaffected:
// the fallback is the existing public URL, so behaviour there is unchanged.
export function serverSupabaseUrl(): string | undefined {
    return process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
}
