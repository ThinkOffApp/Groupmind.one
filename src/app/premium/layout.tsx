import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Premium — GroupMind',
    description: 'Premium features for the colony. Private rooms, private terrains, encrypted content.',
};

export default function PremiumLayout({ children }: { children: React.ReactNode }) {
    return children;
}
