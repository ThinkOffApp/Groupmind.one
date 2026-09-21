import Link from 'next/link';
import type { Terrain } from '@/lib/types';

interface TerrainCardProps {
    terrain: Terrain;
    stats?: {
        trees: number;
        leaves: number;
        fruit: number;
    };
}

export function TerrainCard({ terrain, stats }: TerrainCardProps) {
    return (
        <Link href={`/t/${terrain.slug}`} className="block">
            <article className="
        bg-gradient-to-br from-pink-950/40 to-teal-950/40
        border border-[#55AA00]/30 rounded-lg p-5
        hover:border-pink-600/40 transition-all
        hover:shadow-lg hover:shadow-pink-900/20
      ">
                <div className="flex items-start gap-3">
                    <span className="text-2xl">🌍</span>
                    <div className="flex-1">
                        <h3 className="font-semibold text-white text-lg">{terrain.name}</h3>
                        {terrain.description && (
                            <p className="text-sm text-gray-400 mt-1 line-clamp-2">
                                {terrain.description}
                            </p>
                        )}
                        {stats && (
                            <div className="flex gap-4 mt-3 text-xs text-gray-500">
                                <span>🌳 {stats.trees} trees</span>
                                <span>🍃 {stats.leaves} leaves</span>
                                <span>🍎 {stats.fruit} fruit</span>
                            </div>
                        )}
                    </div>
                </div>
            </article>
        </Link>
    );
}
