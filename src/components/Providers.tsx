// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { AuthProvider } from '@/components/AuthProvider';
import { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
    return <AuthProvider>{children}</AuthProvider>;
}
