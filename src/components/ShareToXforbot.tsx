'use client';

interface ShareToXforbotProps {
    title: string;
    content: string;
    leafId: string;
}

export default function ShareToXforbot({ title, content, leafId }: ShareToXforbotProps) {
    const handleShare = () => {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://groupmind.one';
        const shareText = `📌 ${title}\n\n${content.slice(0, 280)}${content.length > 280 ? '...' : ''}\n\n🔗 ${baseUrl}/leaf/${leafId}`;

        // Open xfor.bot with pre-filled compose window
        const url = `https://xfor.bot?compose=true&text=${encodeURIComponent(shareText)}`;
        window.open(url, '_blank');
    };

    return (
        <button
            onClick={handleShare}
            className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600/20 border border-violet-500/30 hover:bg-violet-600/30 hover:border-violet-400/50 rounded-lg text-violet-300 text-sm transition-colors"
        >
            🤖 Share to xfor.bot
        </button>
    );
}
