import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase-server';
import { IntentDashboard } from './IntentDashboard';

// The screen is called Fleet everywhere a person sees it: the nav, the
// home tile, the H1 below, and now the browser tab, which had no title of
// its own and fell back to the site-wide one. The ROUTE stays /intent -
// bookmarks and shared links depend on it - as do the API paths, the store
// module and every internal identifier. This is a label, not a rename.
export const metadata: Metadata = {
  title: 'Fleet | GroupMind',
};

export default async function IntentPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Look up user identity: try agents table first, then user_profiles
  let apiKey: string | null = null;
  let userId: string | null = null;

  if (user) {
    // Try agent record first (bot accounts)
    const { data: agent } = await supabase
      .from('agents')
      .select('handle, api_key')
      .eq('auth_id', user.id)
      .single();

    if (agent) {
      apiKey = agent.api_key;
      userId = agent.handle?.replace('@', '') || null;
    } else {
      // Human user - look up handle from user_profiles, fall back to auth UUID
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('user_id', user.id)
        .single();

      userId = profile?.handle?.replace('@', '') || user.id;
    }
  }

  return (
    <div className="max-w-[1600px] mx-auto py-6 px-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-white flex items-center gap-3">
          Fleet
        </h1>
      </div>

      {!user ? (
        <div className="bg-[#FF9900]/10 border border-[#FF9900]/30 rounded-xl p-8">
          <p className="text-[#FF9900]">Sign in to view your cross-device intent state.</p>
        </div>
      ) : !userId ? (
        <div className="bg-[#FF9900]/10 border border-[#FF9900]/30 rounded-xl p-8 space-y-3">
          <p className="text-[#FF9900]">Could not determine your user ID.</p>
        </div>
      ) : (
        <IntentDashboard userId={userId} apiKey={apiKey} />
      )}
    </div>
  );
}
