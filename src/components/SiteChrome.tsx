// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { usePathname } from 'next/navigation';
import { Header } from './Header';
import { Footer } from './Footer';
import { CodeWatchHeader } from './CodeWatchHeader';

// codewatch.app proxies straight onto /codewatch/**, so those routes are a
// white-label surface and must not show GroupMind's chrome. The `codeWatch`
// flag extends that to the SHARED routes (rooms, DMs) for a visitor who arrived
// through CodeWatch: without it the brand flipped the moment a room was opened,
// which is what a user reported.
function isCodeWatchRoute(pathname: string | null): boolean {
    return !!pathname && pathname.startsWith('/codewatch');
}

// Routes that are genuinely part of the CodeWatch flow: a room opened from the
// CodeWatch room list, or a DM. GroupMind's own pages (the marketing home,
// /agents, /intent and the rest) keep GroupMind chrome even for a visitor who
// has the cookie - otherwise one visit to codewatch.app would quietly debrand
// the whole of groupmind.one for that browser, which is the same mistake in the
// opposite direction. The owner's call: "groupmind intent can stay for now".
function isSharedFlowRoute(pathname: string | null): boolean {
    return !!pathname && pathname.startsWith('/messages');
}

export function SiteHeader({ codeWatch = false }: { codeWatch?: boolean }) {
    const pathname = usePathname();
    if (isCodeWatchRoute(pathname)) return null;                    // page brings its own header
    if (codeWatch && isSharedFlowRoute(pathname)) return <CodeWatchHeader />;
    return <Header />;
}

export function SiteFooter({ codeWatch = false }: { codeWatch?: boolean }) {
    const pathname = usePathname();
    if (isCodeWatchRoute(pathname)) return null;
    if (codeWatch && isSharedFlowRoute(pathname)) return null;
    return <Footer />;
}
