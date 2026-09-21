'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import Link from 'next/link';

function NewTreeForm() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const supabase = createClient();

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [terrainId, setTerrainId] = useState('');
    const [terrains, setTerrains] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        // Pre-fill from seed parameter
        const seed = searchParams.get('seed');
        if (seed) {
            const lines = seed.split('\n');
            setTitle(lines[0]?.slice(0, 100) || 'Seeded from xfor.bot');
            setDescription(`Seeded from xfor.bot:\n\n${seed}`);
        }

        // Fetch terrains
        const fetchTerrains = async () => {
            const { data } = await supabase.from('terrains').select('id, name, slug').order('name');
            if (data) setTerrains(data);
        };
        fetchTerrains();
    }, [searchParams]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) {
                setError('Please sign in to create a tree');
                setLoading(false);
                return;
            }

            if (!terrainId) {
                setError('Please select a terrain');
                setLoading(false);
                return;
            }

            const slug = title.toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 50) + '-' + Date.now().toString(36);

            const insertData = {
                title,
                slug,
                description,
                terrain_id: terrainId,
                status: 'growing',
            };

            const { data: tree, error: insertError } = await supabase
                .from('trees')
                .insert(insertData as any)
                .select('id')
                .single();

            if (insertError) {
                setError(insertError.message);
            } else if (tree) {
                router.push(`/tree/${(tree as any).id}`);
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-2xl mx-auto">
            <div className="mb-6">
                <Link href="/trees" className="text-gray-400 hover:text-white text-sm">
                    ← Back to Trees
                </Link>
            </div>

            <div className="bg-yellow-950/20 border border-yellow-800/30 rounded-lg p-6">
                <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
                    🌱 Plant a New Tree
                </h1>

                {searchParams.get('seed') && (
                    <div className="mb-4 p-3 bg-[#55AA00]/30 border border-pink-700/30 rounded-lg text-sm text-[#FFDD00]">
                        ✨ Seeding from xfor.bot post
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">
                            Title
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            required
                            className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg focus:border-yellow-500/50 focus:outline-none"
                            placeholder="What problem are we solving?"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">
                            Description
                        </label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={5}
                            className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg focus:border-yellow-500/50 focus:outline-none resize-none"
                            placeholder="Describe the context and goals..."
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">
                            Terrain (optional)
                        </label>
                        <select
                            value={terrainId}
                            onChange={(e) => setTerrainId(e.target.value)}
                            className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg focus:border-yellow-500/50 focus:outline-none"
                        >
                            <option value="">No terrain</option>
                            {terrains.map((t) => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                        </select>
                    </div>

                    {error && (
                        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading || !title}
                        className="w-full py-3 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg font-semibold transition-colors"
                    >
                        {loading ? 'Planting...' : '🌱 Plant Tree'}
                    </button>
                </form>
            </div>
        </div>
    );
}

export default function NewTreePage() {
    return (
        <Suspense fallback={<div className="text-center py-20">Loading...</div>}>
            <NewTreeForm />
        </Suspense>
    );
}
