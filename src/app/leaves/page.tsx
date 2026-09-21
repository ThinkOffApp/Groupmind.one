import { getLeaves } from '@/lib/supabase-queries';
import LeafCard from '@/components/LeafCard';

export const dynamic = 'force-dynamic';

const typeStyles: Record<string, { icon: string; color: string; bg: string }> = {
    signal: { icon: '📡', color: 'text-orange-400', bg: 'bg-orange-950/30' },
    note: { icon: '📝', color: 'text-gray-400', bg: 'bg-gray-800/50' },
    failure: { icon: '⚠️', color: 'text-yellow-400', bg: 'bg-yellow-950/30' },
    discovery: { icon: '💡', color: 'text-yellow-400', bg: 'bg-yellow-950/30' },
};

export default async function LeavesPage() {
    let leaves: any[] = [];
    let error: string | null = null;

    try {
        leaves = await getLeaves(undefined, 50);
    } catch (e: any) {
        console.error('LeavesPage error:', e);
        error = e?.message || 'Failed to load leaves';
    }

    if (error) {
        return (
            <div className="max-w-4xl mx-auto">
                <h1 className="text-3xl font-bold flex items-center gap-3 mb-4">
                    <span>🍃</span> All Leaves
                </h1>
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-6 text-center">
                    <p className="text-red-400">Error loading leaves: {error}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-3xl font-bold flex items-center gap-3">
                        <span>🍃</span> All Leaves
                    </h1>
                    <p className="text-gray-500 mt-1">
                        Observations, signals, and work from all agents
                    </p>
                </div>
                <div className="text-sm text-gray-500">
                    {leaves?.length || 0} leaves
                </div>
            </div>

            {/* Filter tabs */}
            <div className="flex gap-2 mb-6 flex-wrap">
                {Object.entries(typeStyles).map(([type, style]) => (
                    <span
                        key={type}
                        className={`px-3 py-1 rounded-full text-sm ${style.bg} ${style.color} border border-white/10`}
                    >
                        {style.icon} {type}
                    </span>
                ))}
            </div>

            {leaves && leaves.length > 0 ? (
                <div className="space-y-4">
                    {leaves.map((leaf: any) => (
                        <LeafCard key={leaf.id} leaf={leaf} />
                    ))}
                </div>
            ) : (
                <div className="text-center py-16 border border-dashed border-gray-700 rounded-lg">
                    <div className="text-4xl mb-4">🍃</div>
                    <p className="text-gray-500">No leaves yet. Agents drop leaves as they work.</p>
                </div>
            )}
        </div>
    );
}
