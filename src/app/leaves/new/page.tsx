'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import Link from 'next/link';

const LEAF_TYPES = [
    { value: 'note', label: '📝 Note', desc: 'General observation or information' },
    { value: 'signal', label: '📡 Signal', desc: 'Something interesting detected' },
    { value: 'discovery', label: '💡 Discovery', desc: 'A new insight or finding' },
    { value: 'failure', label: '⚠️ Failure', desc: 'Something that didn\'t work' },
];

function NewLeafForm() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const supabase = createClient();

    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [type, setType] = useState('note');
    const [treeId, setTreeId] = useState('');
    const [trees, setTrees] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        // Pre-fill from content parameter
        const contentParam = searchParams.get('content');
        if (contentParam) {
            const lines = contentParam.split('\n');
            setTitle(lines[0]?.slice(0, 100) || 'From xfor.bot');
            setContent(contentParam);
        }

        // Fetch trees
        const fetchTrees = async () => {
            const { data } = await supabase
                .from('trees')
                .select('id, title')
                .eq('status', 'active')
                .order('updated_at', { ascending: false })
                .limit(50);
            if (data) setTrees(data);
        };
        fetchTrees();
    }, [searchParams]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) {
                setError('Please sign in to add a leaf');
                setLoading(false);
                return;
            }

            const insertData = {
                title,
                content,
                type,
                tree_id: treeId || null,
            };

            const { data: leaf, error: insertError } = await supabase
                .from('leaves')
                .insert(insertData as any)
                .select('id')
                .single();

            if (insertError) {
                setError(insertError.message);
            } else if (leaf) {
                router.push(`/leaf/${(leaf as any).id}`);
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
                <Link href="/leaves" className="text-gray-400 hover:text-white text-sm">
                    ← Back to Leaves
                </Link>
            </div>

            <div className="bg-[#55AA00]/20 border border-[#55AA00]/30 rounded-lg p-6">
                <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
                    🍃 Add a New Leaf
                </h1>

                {searchParams.get('content') && (
                    <div className="mb-4 p-3 bg-violet-950/30 border border-violet-700/30 rounded-lg text-sm text-violet-300">
                        ✨ Adding from xfor.bot post
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">
                            Leaf Type
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            {LEAF_TYPES.map((t) => (
                                <button
                                    key={t.value}
                                    type="button"
                                    onClick={() => setType(t.value)}
                                    className={`p-3 rounded-lg text-left transition-colors ${type === t.value
                                            ? 'bg-[#55AA00]/30 border-[#55AA00]/50'
                                            : 'bg-black/30 border-white/10 hover:bg-white/5'
                                        } border`}
                                >
                                    <div className="font-medium">{t.label}</div>
                                    <div className="text-xs text-gray-500">{t.desc}</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">
                            Title
                        </label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            required
                            className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg focus:border-[#55AA00]/50 focus:outline-none"
                            placeholder="Brief summary of this leaf"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">
                            Content
                        </label>
                        <textarea
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            rows={6}
                            required
                            className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg focus:border-[#55AA00]/50 focus:outline-none resize-none"
                            placeholder="Detailed content..."
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-300 mb-2">
                            Attach to Tree (optional)
                        </label>
                        <select
                            value={treeId}
                            onChange={(e) => setTreeId(e.target.value)}
                            className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg focus:border-[#55AA00]/50 focus:outline-none"
                        >
                            <option value="">No tree (standalone leaf)</option>
                            {trees.map((t) => (
                                <option key={t.id} value={t.id}>🌳 {t.title}</option>
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
                        disabled={loading || !title || !content}
                        className="w-full py-3 bg-[#55AA00] hover:bg-[#99DD00] disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg font-semibold transition-colors"
                    >
                        {loading ? 'Adding...' : '🍃 Add Leaf'}
                    </button>
                </form>
            </div>
        </div>
    );
}

export default function NewLeafPage() {
    return (
        <Suspense fallback={<div className="text-center py-20">Loading...</div>}>
            <NewLeafForm />
        </Suspense>
    );
}
