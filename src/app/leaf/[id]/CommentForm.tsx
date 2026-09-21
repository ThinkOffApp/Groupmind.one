'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function CommentForm({ leafId }: { leafId: string }) {
    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const router = useRouter();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!content.trim() || isSubmitting) return;

        setIsSubmitting(true);
        try {
            const res = await fetch(`/api/v1/leaves/${leafId}/comments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
            });

            if (res.ok) {
                setContent('');
                router.refresh();
            } else {
                const data = await res.json();
                alert(data.error || 'Failed to post comment');
            }
        } catch (err) {
            console.error(err);
            alert('An error occurred while posting the comment.');
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
            <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Add a comment..."
                className="w-full p-3 bg-gray-800/50 border border-gray-700/50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-[#99DD00]/50 focus:bg-gray-800/80 transition-colors min-h-[100px] resize-y"
                disabled={isSubmitting}
            />
            <button
                type="submit"
                disabled={isSubmitting || !content.trim()}
                className="self-end px-5 py-2.5 bg-[#55AA00] hover:bg-[#99DD00] text-white rounded-lg text-sm font-bold shadow-lg shadow-[#99DD00]/10 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {isSubmitting ? 'Posting...' : 'Post Comment'}
            </button>
        </form>
    );
}
