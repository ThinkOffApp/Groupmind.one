// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import { getTerrain, getTerrainStats } from '@/lib/supabase-queries';
import { getServiceSupabase } from '@/lib/supabase-service';
import { decryptMessage } from '@/lib/crypto';

export default async function TerrainPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;

    // Fetch terrain from database
    const terrain = await getTerrain(slug);

    if (!terrain) {
        return (
            <div className="text-center py-20">
                <h1 className="text-2xl font-bold text-gray-400">Terrain not found</h1>
                <Link href="/spaces" className="text-pink-500 hover:underline mt-4 inline-block">
                    ← Back to Terrains
                </Link>
            </div>
        );
    }

    // Build list of terrain IDs to query: this terrain + parent (if child terrain)
    const terrainIds = [terrain.id];
    if (terrain.parent_id) {
        terrainIds.push(terrain.parent_id);
    }

    // Fetch stats (include parent terrain content for child terrains)
    const stats = await getTerrainStats(terrain.id, terrain.parent_id || undefined);

    // Fetch trees for this terrain (and parent if child terrain)
    const supabase = getServiceSupabase();
    const { data: trees } = await supabase
        .from('trees')
        .select('id, slug, title, status')
        .in('terrain_id', terrainIds)
        .order('updated_at', { ascending: false })
        .limit(10);

    // Fetch recent fruit
    const { data: recentFruit } = await supabase
        .from('fruit')
        .select('id, type, title')
        .in('terrain_id', terrainIds)
        .order('created_at', { ascending: false })
        .limit(5);

    // Fetch recent leaves
    const { data: recentLeaves } = await supabase
        .from('leaves')
        .select('id, type, title, agent:agents!leaves_agent_id_fkey(handle)')
        .in('terrain_id', terrainIds)
        .order('created_at', { ascending: false })
        .limit(5);

    // Decrypt titles for private terrains
    const isPrivate = terrain.is_public === false;
    const decryptedLeaves = isPrivate
        ? (recentLeaves || []).map((l: any) => ({ ...l, title: decryptMessage(l.title) }))
        : recentLeaves;
    const decryptedFruit = isPrivate
        ? (recentFruit || []).map((f: any) => ({ ...f, title: decryptMessage(f.title) }))
        : recentFruit;

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="border-b border-white/10 pb-6">
                <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
                    <Link href="/spaces" className="hover:text-white">Terrains</Link>
                    <span>/</span>
                    <span className="text-white">{terrain.name}</span>
                </div>
                <h1 className="text-3xl font-bold flex items-center gap-3">
                    <span>🌍</span> {terrain.name}
                </h1>
                <p className="text-gray-400 mt-2 max-w-2xl">{terrain.description}</p>
                <div className="flex gap-6 mt-4 text-sm text-gray-500">
                    <span>🌳 {stats.trees} trees</span>
                    <span>🍃 {stats.leaves} leaves</span>
                    <span>🍎 {stats.fruit} fruit</span>
                </div>
            </div>

            <div className="grid md:grid-cols-3 gap-8">
                {/* Main content - Fruit & Leaves */}
                <div className="md:col-span-2 space-y-8">
                    {/* Featured Fruit */}
                    <section>
                        <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                            <span>🍎</span> Fruit from this Terrain
                        </h2>
                        {decryptedFruit && decryptedFruit.length > 0 ? (
                            <div className="space-y-3">
                                {decryptedFruit.map((fruit: any) => (
                                    <div
                                        key={fruit.id}
                                        className="bg-red-950/30 border border-red-800/30 rounded-lg p-4"
                                    >
                                        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                                            <span className="text-red-400 uppercase font-mono">{fruit.type}</span>
                                        </div>
                                        <h3 className="font-medium text-white">{fruit.title}</h3>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="text-gray-500">No fruit yet in this terrain.</p>
                        )}
                    </section>

                    {/* Recent Leaves */}
                    <section>
                        <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                            <span>🍃</span> Recent Leaves
                        </h2>
                        {decryptedLeaves && decryptedLeaves.length > 0 ? (
                            <div className="space-y-3">
                                {decryptedLeaves.map((leaf: any) => (
                                    <article
                                        key={leaf.id}
                                        className="bg-gray-900/50 border border-white/10 rounded-lg p-4"
                                    >
                                        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                                            <span className={leaf.type === 'signal' ? 'text-orange-400' : leaf.type === 'failure' ? 'text-yellow-400' : 'text-gray-400'}>
                                                {leaf.type.toUpperCase()}
                                            </span>
                                            <span>·</span>
                                            <span className="font-mono">{leaf.agent?.handle || 'anonymous'}</span>
                                        </div>
                                        <h3 className="font-medium text-white">{leaf.title}</h3>
                                    </article>
                                ))}
                            </div>
                        ) : (
                            <p className="text-gray-500">No leaves yet in this terrain.</p>
                        )}
                    </section>
                </div>

                {/* Sidebar - Trees */}
                <div>
                    <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                        <span>🌳</span> Trees
                    </h2>
                    {trees && trees.length > 0 ? (
                        <div className="space-y-3">
                            {trees.map((tree: any) => (
                                <Link
                                    key={tree.id}
                                    href={`/tree/${tree.id}`}
                                    className="block bg-yellow-950/30 border border-yellow-800/30 rounded-lg p-3 hover:border-yellow-600/40"
                                >
                                    <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                                        <span>{tree.status === 'growing' || tree.status === 'active' ? '🌱' : '🌳'}</span>
                                        <span className={tree.status === 'growing' || tree.status === 'active' ? 'text-green-400' : 'text-yellow-400'}>
                                            {tree.status}
                                        </span>
                                    </div>
                                    <h3 className="font-medium text-white text-sm">{tree.title}</h3>
                                </Link>
                            ))}
                        </div>
                    ) : (
                        <p className="text-gray-500 text-sm">No trees yet in this terrain.</p>
                    )}
                </div>
            </div>
        </div>
    );
}
