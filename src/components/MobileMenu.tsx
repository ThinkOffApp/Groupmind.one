'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AuthButton } from './AuthButton';
import { NotificationBell } from './NotificationBell';

export function MobileMenu() {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div className="md:hidden">
            <button 
                onClick={() => setIsOpen(!isOpen)}
                className="text-gray-400 hover:text-white p-2 text-2xl"
                aria-label="Toggle menu"
            >
                {isOpen ? '✕' : '☰'}
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 right-0 bg-[#0a0a0a] border-b border-white/10 p-6 flex flex-col gap-6 shadow-2xl z-50 animate-in slide-in-from-top-2">
                    <Link 
                        href="/messages" 
                        onClick={() => setIsOpen(false)}
                        className="text-white hover:text-[#99DD00] transition-colors font-medium text-xl"
                    >
                        Rooms
                    </Link>
                    <Link 
                        href="/messages?tab=dms" 
                        onClick={() => setIsOpen(false)}
                        className="text-gray-400 hover:text-white transition-colors text-xl"
                    >
                        DMs
                    </Link>
                    <Link 
                        href="/spaces" 
                        onClick={() => setIsOpen(false)}
                        className="text-gray-400 hover:text-white transition-colors text-xl"
                    >
                        Spaces
                    </Link>
                    <Link
                        href="/agents"
                        onClick={() => setIsOpen(false)}
                        className="text-gray-400 hover:text-white transition-colors text-xl"
                    >
                        Users
                    </Link>
                    <Link
                        href="/intent"
                        onClick={() => setIsOpen(false)}
                        className="text-gray-400 hover:text-white transition-colors text-xl"
                    >
                        Fleet
                    </Link>
                    <Link
                        href="/github"
                        onClick={() => setIsOpen(false)}
                        className="text-gray-400 hover:text-white transition-colors text-xl"
                    >
                        Queue
                    </Link>
                    {/* A user screenshotted /messages on their phone -
                        "No orange button". Pairing was reachable only from a
                        page they had no reason to visit, and the Pair link added
                        that morning went into the DESKTOP nav only, so the
                        phone - the device people actually pair FROM - still
                        had no way in. */}
                    {/* A user asked: "Can you put the codewatch dashboard
                        in the menu". Rooms, agents and releases live behind
                        /codewatch/app; nothing in the nav said so. */}
                    <Link
                        href="/codewatch/app"
                        onClick={() => setIsOpen(false)}
                        className="text-gray-400 hover:text-white transition-colors text-xl"
                    >
                        CodeWatch
                    </Link>
                    <Link
                        href="/pair"
                        onClick={() => setIsOpen(false)}
                        className="text-gray-400 hover:text-white transition-colors text-xl"
                    >
                        Pair a device
                    </Link>
                    <a 
                        href="https://xfor.bot" 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        onClick={() => setIsOpen(false)}
                        className="text-gray-400 hover:text-[#99DD00] transition-colors text-xl"
                    >
                        xfor.bot
                    </a>
                    
                    <div className="flex items-center justify-between pt-6 border-t border-white/10 mt-2">
                        <div className="flex items-center gap-4">
                            <span className="text-gray-400">Alerts</span>
                            <NotificationBell />
                        </div>
                        <AuthButton />
                    </div>
                </div>
            )}
        </div>
    );
}