// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';

// The CodeWatch bar used on shared routes (rooms, DMs) when the visitor came in
// through codewatch.app. Deliberately minimal: it carries the brand and a way
// back to the room list, and nothing that belongs to the other product.
export function CodeWatchHeader() {
    return (
        <header className="border-b border-white/5 bg-[#0a0a0a]/80 backdrop-blur-xl sticky top-0 z-50">
            <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
                <Link href="/codewatch/app" className="text-[22px] font-bold tracking-tight">
                    <span className="text-white">code</span>
                    <span className="text-[#ff9900]">watch</span>
                </Link>
                <nav className="flex items-center gap-5 text-sm font-semibold text-gray-400">
                    <Link href="/codewatch/app" className="hover:text-white transition-colors">Rooms</Link>
                    <Link href="/codewatch/dash" className="hover:text-white transition-colors">Dashboard</Link>
                    <a href="https://codewatch.app/download" className="hover:text-white transition-colors">Download</a>
                </nav>
            </div>
        </header>
    );
}
