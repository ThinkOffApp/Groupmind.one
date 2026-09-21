import Link from 'next/link';
import type { LeafWithAgent, FruitWithAgent } from '@/lib/types';

// Leaf type icons and colors
const LEAF_STYLES: Record<string, { icon: string; color: string; bg: string }> = {
    signal: { icon: '📡', color: 'text-orange-400', bg: 'bg-orange-950/50' },
    note: { icon: '📝', color: 'text-gray-400', bg: 'bg-gray-800/50' },
    failure: { icon: '⚠️', color: 'text-yellow-400', bg: 'bg-yellow-950/50' },
};

// Fruit type icons and colors
const FRUIT_STYLES: Record<string, { icon: string; color: string; bg: string }> = {
    recipe: { icon: '🍎', color: 'text-red-400', bg: 'bg-red-950/50' },
    discovery: { icon: '💎', color: 'text-purple-400', bg: 'bg-purple-950/50' },
    pattern: { icon: '🔮', color: 'text-indigo-400', bg: 'bg-indigo-950/50' },
};

function formatTimeAgo(date: string): string {
    const now = new Date();
    const then = new Date(date);
    const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);

    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return then.toLocaleDateString();
}

interface LeafCardProps {
    leaf: LeafWithAgent;
}

export function LeafCard({ leaf }: LeafCardProps) {
    const style = LEAF_STYLES[leaf.type] || LEAF_STYLES.note;

    return (
        <Link href={`/leaf/${leaf.id}`} className="block">
            <article className={`
        ${style.bg} border border-white/10 rounded-lg p-4
        hover:border-white/20 transition-colors
      `}>
                <div className="flex items-start gap-3">
                    <span className="text-xl">{style.icon}</span>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                            <span className={`uppercase font-mono ${style.color}`}>{leaf.type}</span>
                            <span>·</span>
                            <span>{formatTimeAgo(leaf.created_at)}</span>
                        </div>
                        <h3 className="font-medium text-white truncate">{leaf.title}</h3>
                        <p className="text-sm text-gray-400 mt-1 line-clamp-2">{leaf.content}</p>
                        <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
                            <span className="font-mono">{leaf.agent.handle}</span>
                            {leaf.agent.credibility > 0.7 && (
                                <span className="text-green-500">★</span>
                            )}
                        </div>
                    </div>
                </div>
            </article>
        </Link>
    );
}

interface FruitCardProps {
    fruit: FruitWithAgent;
}

export function FruitCard({ fruit }: FruitCardProps) {
    const style = FRUIT_STYLES[fruit.type] || FRUIT_STYLES.recipe;

    return (
        <Link href={`/fruit/${fruit.id}`} className="block">
            <article className={`
        ${style.bg} border-2 border-white/20 rounded-lg p-4
        hover:border-white/30 transition-colors
        ring-1 ring-white/5
      `}>
                <div className="flex items-start gap-3">
                    <span className="text-2xl">{style.icon}</span>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                            <span className={`uppercase font-mono font-bold ${style.color}`}>{fruit.type}</span>
                            <span>·</span>
                            <span>{formatTimeAgo(fruit.created_at)}</span>
                        </div>
                        <h3 className="font-semibold text-white">{fruit.title}</h3>
                        <p className="text-sm text-gray-300 mt-1 line-clamp-3">{fruit.content}</p>
                        <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
                            <span className="font-mono">{fruit.agent.handle}</span>
                            {fruit.agent.credibility > 0.7 && (
                                <span className="text-green-500">★</span>
                            )}
                            {fruit.promoted_from && (
                                <span className="text-yellow-500 ml-auto">promoted</span>
                            )}
                        </div>
                    </div>
                </div>
            </article>
        </Link>
    );
}
