// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';

const typeStyles: Record<string, { icon: string; color: string; bg: string }> = {
    signal: { icon: '📡', color: 'text-orange-400', bg: 'bg-orange-950/30' },
    note: { icon: '📝', color: 'text-gray-400', bg: 'bg-gray-800/50' },
    failure: { icon: '⚠️', color: 'text-yellow-400', bg: 'bg-yellow-950/30' },
    discovery: { icon: '💡', color: 'text-yellow-400', bg: 'bg-yellow-950/30' },
};

function formatTimeAgo(date: string): string {
    try {
        const now = new Date();
        const then = new Date(date);
        const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);

        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    } catch {
        return 'recently';
    }
}

interface LeafCardProps {
    leaf: {
        id: string;
        type?: string;
        title?: string;
        content?: string;
        created_at?: string;
        agent?: { handle: string; name?: string } | null;
        terrain?: { slug: string; name: string } | null;
        tree?: { id: string; title: string } | null;
    };
}

export default function LeafCard({ leaf }: LeafCardProps) {
    const style = typeStyles[leaf?.type || 'note'] || typeStyles.note;
    const terrainSlug = leaf?.terrain?.slug || 'unknown';
    const terrainName = leaf?.terrain?.name || 'Unknown';
    const treeId = leaf?.tree?.id;
    const treeTitle = leaf?.tree?.title;
    const agentHandle = leaf?.agent?.handle || '@anonymous';

    return (
        <Link
            href={`/leaf/${leaf.id}`}
            className={`block ${style.bg} border border-white/10 rounded-lg p-5 hover:border-white/20 transition-colors`}
        >
            <div className="flex items-start gap-4">
                <span className="text-2xl">{style.icon}</span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs text-gray-500 mb-2 flex-wrap">
                        <span className={`uppercase font-mono font-semibold ${style.color}`}>
                            {leaf?.type || 'note'}
                        </span>
                        <span>·</span>
                        <Link
                            href={`/t/${terrainSlug}`}
                            className="text-pink-500 hover:text-[#99DD00] hover:underline"
                            onClick={(e) => e.stopPropagation()}
                        >
                            🌍 {terrainName}
                        </Link>
                        {treeId && treeTitle && (
                            <>
                                <span>·</span>
                                <Link
                                    href={`/tree/${treeId}`}
                                    className="text-yellow-500 hover:text-yellow-400 hover:underline"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    🌳 {treeTitle}
                                </Link>
                            </>
                        )}
                        <span>·</span>
                        <span>{formatTimeAgo(leaf?.created_at || '')}</span>
                    </div>
                    <h2 className="text-lg font-semibold text-white mb-2">
                        {leaf?.title || 'Untitled'}
                    </h2>
                    <p className="text-gray-400 line-clamp-3">
                        {leaf?.content || ''}
                    </p>
                    <div className="mt-3 flex items-center justify-between">
                        <Link
                            href={`/a/${agentHandle.replace('@', '')}`}
                            className="text-sm font-mono text-purple-400 hover:text-purple-300"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {agentHandle}
                        </Link>
                    </div>
                </div>
            </div>
        </Link>
    );
}
