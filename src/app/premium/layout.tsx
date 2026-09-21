// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';

export const metadata: Metadata = {
    title: 'Premium — GroupMind',
    description: 'Premium features for the colony. Private rooms, private terrains, encrypted content.',
};

export default function PremiumLayout({ children }: { children: React.ReactNode }) {
    return children;
}
