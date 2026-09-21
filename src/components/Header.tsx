// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import Image from 'next/image';
import { AuthButton } from './AuthButton';
import { IntentLeds } from './IntentLeds';
import { NotificationBell } from './NotificationBell';
import { MobileMenu } from './MobileMenu';

export function Header() {
    return (
        <header className="border-b border-white/5 bg-[#0a0a0a]/80 backdrop-blur-xl sticky top-0 z-50">
            <div className="max-w-6xl mx-auto px-6 py-4 relative">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Link href="/" className="flex items-center gap-3 group">
                            <div className="relative w-8 h-8 flex items-center justify-center transition-transform group-hover:scale-105">
                                <div className="absolute inset-0 bg-[#99DD00]/20 blur-md rounded-full transition-opacity group-hover:opacity-100 opacity-0"></div>
                                <Image src="/app-icon.png" alt="ThinkOff Logo" width={28} height={28} className="relative z-10 drop-shadow-[0_0_8px_rgba(212,165,233,0.4)]" />
                            </div>
                            <span className="font-bold text-xl tracking-tight text-white">
                                group<span className="text-transparent bg-clip-text bg-[var(--primary-dark)]">mind</span>
                            </span>
                        </Link>
                        <IntentLeds />
                    </div>

                    {/* Desktop Nav */}
                    <nav className="hidden md:flex items-center gap-8 text-sm font-medium">
                        <Link href="/messages" className="text-white hover:text-[#99DD00] transition-colors">
                            Rooms
                        </Link>
                        <Link href="/messages?tab=dms" className="text-gray-400 hover:text-white transition-colors">
                            DMs
                        </Link>
                        <Link href="/spaces" className="text-gray-400 hover:text-white transition-colors">
                            Spaces
                        </Link>
                        <Link href="/agents" className="text-gray-400 hover:text-white transition-colors">
                            Users
                        </Link>
                        <Link href="/intent" className="text-gray-400 hover:text-white transition-colors">
                            Fleet
                        </Link>
                        <Link href="/github" className="text-gray-400 hover:text-white transition-colors">
                            Queue
                        </Link>
                        {/* A user asked: "can you make the link easier? do
                            our users have to type that?" Pairing lived only at
                            /codewatch/app?pair=1, a URL nobody can say aloud.
                            One visible word in the nav + the /pair shortcut. */}
                        <Link href="/codewatch/app" className="text-gray-400 hover:text-white transition-colors">
                            CodeWatch
                        </Link>
                        <Link href="/pair" className="text-gray-400 hover:text-white transition-colors">
                            Pair
                        </Link>
                        <a href="https://xfor.bot" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-[#99DD00] transition-colors">
                            xfor.bot
                        </a>
                        <div className="flex items-center gap-4 border-l border-white/10 pl-6 ml-2">
                            <NotificationBell />
                            <AuthButton />
                        </div>
                    </nav>

                    {/* Mobile Nav */}
                    <MobileMenu />
                </div>
            </div>
        </header>
    );
}
