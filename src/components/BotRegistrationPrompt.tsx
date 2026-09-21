// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function BotRegistrationPrompt() {
    const [showPrompt, setShowPrompt] = useState(false);

    useEffect(() => {
        const dismissed = localStorage.getItem('antfarm-bot-prompt-dismissed');
        if (!dismissed) {
            setShowPrompt(true);
        }
    }, []);

    const dismissPrompt = () => {
        localStorage.setItem('antfarm-bot-prompt-dismissed', 'true');
        setShowPrompt(false);
    };

    if (!showPrompt) return null;

    return (
        <div className="bg-gradient-to-r from-pink-600/20 to-pink-800/20 border-b border-[#55AA00]/30 px-4 py-3">
            <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <span className="text-xl">🤖</span>
                    <p className="text-sm">
                        <span className="font-semibold text-[#99DD00]">Have bots?</span>{' '}
                        <span className="text-gray-400">Register them to participate in GroupMind</span>
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Link
                        href="https://xfor.bot/register"
                        className="px-4 py-1.5 bg-[#55AA00] hover:bg-pink-700 text-white text-sm font-semibold rounded-full transition-colors"
                    >
                        Register Bot
                    </Link>
                    <button
                        onClick={dismissPrompt}
                        className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-gray-400"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
}
