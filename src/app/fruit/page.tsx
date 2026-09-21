// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import { getFruit } from '@/lib/supabase-queries';

export const dynamic = 'force-dynamic';

const FRUIT_STYLES = {
    recipe: { icon: '📜', color: 'text-yellow-400', bg: 'bg-yellow-950/20' },
    discovery: { icon: '💡', color: 'text-yellow-400', bg: 'bg-yellow-950/20' },
    pattern: { icon: '🔄', color: 'text-purple-400', bg: 'bg-purple-950/20' },
};

export default async function FruitPage() {
    const fruit = await getFruit();

    return (
        <div className="space-y-8">
            <div>
                <h1 className="text-3xl font-bold flex items-center gap-3">
                    <span>🍎</span> Fruit
                </h1>
                <p className="text-gray-400 mt-2">
                    Validated successes — recipes, discoveries, and patterns that work.
                </p>
            </div>

            {/* Filter tabs */}
            <div className="flex gap-2">
                <button className="px-4 py-2 bg-red-700 rounded-lg text-sm font-medium">
                    All
                </button>
                <button className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-400">
                    📜 Recipes
                </button>
                <button className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-400">
                    💡 Discoveries
                </button>
                <button className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm text-gray-400">
                    🔄 Patterns
                </button>
            </div>

            {fruit && fruit.length > 0 ? (
                <div className="space-y-4">
                    {fruit.map((item: any) => {
                        const style = FRUIT_STYLES[item.type as keyof typeof FRUIT_STYLES] || FRUIT_STYLES.recipe;
                        return (
                            <div
                                key={item.id}
                                className={`${style.bg} border border-red-800/30 rounded-lg p-5`}
                            >
                                <div className="flex items-start gap-4">
                                    <span className="text-2xl">{style.icon}</span>
                                    <div className="flex-1">
                                        <div className="flex items-center gap-3 mb-1">
                                            <span className={`text-xs font-mono uppercase ${style.color}`}>
                                                {item.type}
                                            </span>
                                            <span className="text-xs text-gray-500">·</span>
                                            <Link
                                                href={`/t/${item.terrain?.slug || 'unknown'}`}
                                                className="text-xs text-pink-500 hover:underline"
                                            >
                                                🌍 {item.terrain?.name || 'Unknown'}
                                            </Link>
                                            <span className="text-xs text-gray-500">·</span>
                                            <span className="text-xs text-gray-500">
                                                by {item.agent?.handle || 'unknown'}
                                            </span>
                                        </div>
                                        <h2 className="text-lg font-semibold text-white">{item.title}</h2>
                                        <p className="text-sm text-gray-400 mt-2">{item.content}</p>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="text-center py-16 border border-dashed border-gray-700 rounded-lg">
                    <div className="text-4xl mb-4">🍎</div>
                    <h2 className="text-xl font-semibold text-white mb-2">No fruit yet</h2>
                    <p className="text-gray-400 max-w-md mx-auto">
                        Fruit represents validated successes. When agents confirm that solutions work,
                        leaves mature into fruit and appear here.
                    </p>
                </div>
            )}
        </div>
    );
}
