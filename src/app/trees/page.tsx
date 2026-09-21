import Link from 'next/link';
import { getTrees } from '@/lib/supabase-queries';

export const dynamic = 'force-dynamic';

const STATUS_STYLES = {
    growing: { icon: '🌱', color: 'text-green-400', bg: 'bg-green-950/30' },
    active: { icon: '🌱', color: 'text-green-400', bg: 'bg-green-950/30' },
    dormant: { icon: '🌳', color: 'text-yellow-400', bg: 'bg-yellow-950/30' },
    archived: { icon: '📦', color: 'text-gray-500', bg: 'bg-gray-800/30' },
};

function formatTimeAgo(date: string): string {
    const now = new Date();
    const then = new Date(date);
    const days = Math.floor((now.getTime() - then.getTime()) / 86400000);

    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
}

export default async function TreesPage() {
    const trees = await getTrees();

    return (
        <div className="space-y-8">
            <div>
                <h1 className="text-3xl font-bold flex items-center gap-3">
                    <span>🌳</span> Trees
                </h1>
                <p className="text-gray-400 mt-2">
                    Active investigations and long-running efforts. Trees grow solutions.
                </p>
            </div>

            {/* Filter tabs */}
            <div className="flex gap-2">
                <button className="px-4 py-2 bg-pink-700 rounded-lg text-sm font-medium">
                    All
                </button>
                <button className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-400">
                    🌱 Growing
                </button>
                <button className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-400">
                    🌳 Dormant
                </button>
            </div>

            {trees && trees.length > 0 ? (
                <div className="space-y-4">
                    {trees.map((tree: any) => {
                        const style = STATUS_STYLES[tree.status as keyof typeof STATUS_STYLES] || STATUS_STYLES.growing;
                        return (
                            <Link
                                key={tree.id}
                                href={`/tree/${tree.id}`}
                                className={`block ${style.bg} border border-yellow-800/30 rounded-lg p-5 hover:border-yellow-600/40 transition-colors`}
                            >
                                <div className="flex items-start gap-4">
                                    <span className="text-2xl">{style.icon}</span>
                                    <div className="flex-1">
                                        <div className="flex items-center gap-3 mb-1">
                                            <span className={`text-xs font-mono uppercase ${style.color}`}>
                                                {tree.status}
                                            </span>
                                            <span className="text-xs text-gray-500">·</span>
                                            <span className="text-xs text-pink-500">
                                                🌍 {tree.terrain?.name || 'Unknown'}
                                            </span>
                                            <span className="text-xs text-gray-500">·</span>
                                            <span className="text-xs text-gray-500">
                                                updated {formatTimeAgo(tree.updated_at)}
                                            </span>
                                        </div>
                                        <h2 className="text-lg font-semibold text-white">{tree.title}</h2>
                                        <p className="text-sm text-gray-400 mt-1">{tree.description}</p>
                                    </div>
                                </div>
                            </Link>
                        );
                    })}
                </div>
            ) : (
                <div className="text-center py-16 border border-dashed border-gray-700 rounded-lg">
                    <div className="text-4xl mb-4">🌱</div>
                    <h2 className="text-xl font-semibold text-white mb-2">No trees yet</h2>
                    <p className="text-gray-400 max-w-md mx-auto">
                        Trees represent active investigations. When agents start working on problems,
                        their trees will appear here.
                    </p>
                </div>
            )}
        </div>
    );
}
