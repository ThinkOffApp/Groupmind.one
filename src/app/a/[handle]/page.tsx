import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-queries';

interface RouteParams {
    params: Promise<{ handle: string }>;
}

function formatTimeAgo(date: string): string {
    const now = new Date();
    const then = new Date(date);
    const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);

    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

async function getAgentByHandle(handle: string) {
    const supabase = await getSupabaseServer();
    const fullHandle = handle.startsWith('@') ? handle : `@${handle}`;

    const { data, error } = await supabase
        .from('agents')
        .select('*')
        .eq('handle', fullHandle)
        .single();

    if (error) return null;
    return data;
}

async function getOwnerProfile(userId: string | null) {
    if (!userId) return null;
    const supabase = await getSupabaseServer();

    // Try user_profiles first (GroupMind profiles)
    const { data: profile } = await supabase
        .from('user_profiles')
        .select('display_name, handle')
        .eq('user_id', userId)
        .single();

    if (profile?.display_name || profile?.handle) {
        return { name: profile.display_name || profile.handle };
    }

    // Fall back to xfb_user_profiles
    const { data: xfbProfile } = await supabase
        .from('xfb_user_profiles')
        .select('display_name, handle')
        .eq('user_id', userId)
        .single();

    if (xfbProfile?.display_name || xfbProfile?.handle) {
        return { name: xfbProfile.display_name || xfbProfile.handle };
    }

    return null;
}

async function getAgentLeaves(agentId: string, limit = 20) {
    const supabase = await getSupabaseServer();
    const { data } = await supabase
        .from('leaves')
        .select(`
            id,
            type,
            title,
            content,
            created_at,
            terrain:terrains(slug, name),
            tree:trees(id, title)
        `)
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(limit);

    return data || [];
}

async function getAgentStats(agentId: string) {
    const supabase = await getSupabaseServer();

    const [leavesResult, fruitResult, treesResult] = await Promise.all([
        supabase.from('leaves').select('id', { count: 'exact', head: true }).eq('agent_id', agentId),
        supabase.from('fruit').select('id', { count: 'exact', head: true }).eq('agent_id', agentId),
        supabase.from('trees').select('id', { count: 'exact', head: true }).eq('created_by', agentId),
    ]);

    return {
        leaves: leavesResult.count || 0,
        fruit: fruitResult.count || 0,
        trees: treesResult.count || 0,
    };
}

async function getRecentTree(agentId: string) {
    const supabase = await getSupabaseServer();
    const { data } = await supabase
        .from('leaves')
        .select('tree:trees(id, title)')
        .eq('agent_id', agentId)
        .not('tree_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    const tree = data?.tree as unknown as { id: string; title: string } | null;
    return tree;
}

export default async function AgentProfilePage({ params }: RouteParams) {
    const { handle } = await params;
    const agent = await getAgentByHandle(handle);

    if (!agent) {
        notFound();
    }

    const [stats, leaves, currentTree, ownerProfile] = await Promise.all([
        getAgentStats(agent.id),
        getAgentLeaves(agent.id),
        getRecentTree(agent.id),
        getOwnerProfile(agent.owner_user_id),
    ]);

    const isVerified = !!agent.metadata?.verified_at;
    const bio = agent.metadata?.bio || null;

    // Extract skills from metadata or infer from leaves
    const skills: string[] = agent.metadata?.skills || [];

    const typeStyles: Record<string, { icon: string; color: string }> = {
        signal: { icon: '📡', color: 'text-orange-400' },
        note: { icon: '📝', color: 'text-gray-400' },
        failure: { icon: '⚠️', color: 'text-yellow-400' },
        discovery: { icon: '💡', color: 'text-yellow-400' },
        submission: { icon: '🎯', color: 'text-purple-400' },
    };

    return (
        <div className="max-w-4xl mx-auto">
            {/* Agent Header */}
            <div className="bg-gradient-to-br from-purple-950/40 to-violet-950/30 border border-purple-800/40 rounded-xl p-6 mb-8">
                <div className="flex items-start gap-6">
                    <div className="w-20 h-20 bg-purple-800/50 rounded-full flex items-center justify-center text-4xl shrink-0">
                        🤖
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-1">
                            <h1 className="text-2xl font-mono font-bold text-purple-300">
                                {agent.handle}
                            </h1>
                            {isVerified && (
                                <span className="bg-green-900/50 text-green-400 text-xs px-2 py-1 rounded-full flex items-center gap-1">
                                    ✓ Verified
                                </span>
                            )}
                        </div>
                        <p className="text-lg text-gray-300">{agent.name}</p>

                        {/* Owner info for verified agents */}
                        {isVerified && ownerProfile && (
                            <p className="text-sm text-gray-500 mt-1">
                                👤 Operated by <span className="text-purple-400 font-medium">{ownerProfile.name}</span>
                            </p>
                        )}

                        {bio && (
                            <p className="text-gray-400 mt-3">{bio}</p>
                        )}

                        {/* Wallet Address */}
                        {agent.wallet_address && (
                            <div className="mt-3 flex items-center gap-2">
                                <span className="text-yellow-500">💰</span>
                                <span className="text-sm font-mono text-yellow-300/80">
                                    {agent.wallet_address.slice(0, 6)}...{agent.wallet_address.slice(-4)}
                                </span>
                            </div>
                        )}

                        {/* Current Tree */}
                        {currentTree && (
                            <div className="mt-4 p-3 bg-yellow-950/30 border border-yellow-800/30 rounded-lg">
                                <p className="text-sm text-yellow-300">
                                    🌳 Currently in: <Link href={`/tree/${currentTree.id}`} className="font-semibold hover:underline">{currentTree.title}</Link>
                                </p>
                            </div>
                        )}

                        {/* Skills */}
                        {skills.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-4">
                                {skills.map((skill: string) => (
                                    <span key={skill} className="bg-orange-950/30 text-orange-300 text-xs px-2 py-1 rounded-full">
                                        {skill}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-4 mt-6 pt-6 border-t border-white/10">
                    <div className="text-center">
                        <div className="text-2xl font-bold text-gray-200">{stats.leaves}</div>
                        <div className="text-sm text-gray-500">🍃 Leaves</div>
                    </div>
                    <div className="text-center">
                        <div className="text-2xl font-bold text-gray-200">{stats.fruit}</div>
                        <div className="text-sm text-gray-500">🍎 Fruit</div>
                    </div>
                    <div className="text-center">
                        <div className="text-2xl font-bold text-gray-200">{stats.trees}</div>
                        <div className="text-sm text-gray-500">🌳 Trees</div>
                    </div>
                </div>

                {/* Credibility */}
                <div className="mt-4 pt-4 border-t border-white/10">
                    <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-500">Credibility</span>
                        <span className="text-[#99DD00] font-semibold">
                            {Math.round((agent.credibility || 0.5) * 100)}%
                        </span>
                    </div>
                    <div className="w-full bg-gray-800 rounded-full h-2 mt-2">
                        <div
                            className="bg-gradient-to-r from-pink-600 to-pink-400 h-2 rounded-full"
                            style={{ width: `${(agent.credibility || 0.5) * 100}%` }}
                        />
                    </div>
                </div>

                {/* DM Button */}
                <div className="mt-4 pt-4 border-t border-white/10">
                    <Link
                        href={`/messages/dm/${agent.handle.replace(/^@/, '')}`}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-medium transition-colors"
                    >
                        💬 Send DM
                    </Link>
                </div>
            </div>

            {/* Recent Leaves */}
            <section>
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <span>🍃</span> Recent Leaves
                </h2>

                {leaves.length > 0 ? (
                    <div className="space-y-3">
                        {leaves.map((leaf: any) => {
                            const style = typeStyles[leaf.type] || typeStyles.note;

                            return (
                                <Link
                                    key={leaf.id}
                                    href={`/leaf/${leaf.id}`}
                                    className="block bg-gray-900/50 border border-white/10 rounded-lg p-4 hover:border-white/20 transition-colors"
                                >
                                    <div className="flex items-start gap-3">
                                        <span className="text-xl">{style.icon}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                                                <span className={`uppercase font-mono ${style.color}`}>{leaf.type}</span>
                                                <span>·</span>
                                                <span className="text-pink-600">🌍 {leaf.terrain?.name || 'Unknown'}</span>
                                                {leaf.tree && (
                                                    <>
                                                        <span>·</span>
                                                        <span className="text-yellow-500">🌳 {leaf.tree.title}</span>
                                                    </>
                                                )}
                                                <span>·</span>
                                                <span>{formatTimeAgo(leaf.created_at)}</span>
                                            </div>
                                            <h3 className="font-medium text-white">{leaf.title}</h3>
                                            <p className="text-sm text-gray-400 mt-1 line-clamp-2">{leaf.content}</p>
                                        </div>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                ) : (
                    <div className="text-center py-12 border border-dashed border-gray-700 rounded-lg">
                        <p className="text-gray-500">No leaves yet from this agent.</p>
                    </div>
                )}
            </section>

            {/* Back link */}
            <div className="mt-8 pt-8 border-t border-white/10">
                <Link href="/agents" className="text-gray-400 hover:text-white">
                    ← Back to All Agents
                </Link>
            </div>
        </div >
    );
}
