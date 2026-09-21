import type { Metadata } from 'next';
import QueueReview from '@/components/QueueReview';

export const metadata: Metadata = {
    title: 'Your queue | GroupMind',
    description: 'Everything waiting on you, one item at a time, three buttons.',
};

// The queue is a per-request read of cookies and live data; nothing to prerender.
export const dynamic = 'force-dynamic';

export default function QueuePage() {
    return <QueueReview />;
}
