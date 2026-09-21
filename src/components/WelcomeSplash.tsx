// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState, useEffect } from 'react';

interface WelcomeSplashProps {
    service: string;
    tagline: string;
    emoji: string;
    durationMs?: number;
}

export function WelcomeSplash({ service, tagline, emoji, durationMs = 2800 }: WelcomeSplashProps) {
    const [visible, setVisible] = useState(false);
    const [fadeOut, setFadeOut] = useState(false);

    useEffect(() => {
        const key = `thinkoff-splash-${service}`;
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');
        setVisible(true);

        const fadeTimer = setTimeout(() => setFadeOut(true), durationMs - 400);
        const hideTimer = setTimeout(() => setVisible(false), durationMs);
        return () => { clearTimeout(fadeTimer); clearTimeout(hideTimer); };
    }, [service, durationMs]);

    if (!visible) return null;

    return (
        <div
            className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center transition-opacity duration-400 ${fadeOut ? 'opacity-0' : 'opacity-100'}`}
            style={{ background: 'linear-gradient(135deg, #000000 0%, #0a1a0a 50%, #000000 100%)' }}
        >
            <div className="text-center space-y-4 px-8">
                <div className="text-6xl mb-2 animate-bounce">{emoji}</div>
                <div className="text-sm font-semibold tracking-[0.2em] uppercase opacity-60" style={{ color: 'var(--primary)' }}>
                    ThinkOff Ecosystem
                </div>
                <h1 className="text-4xl md:text-5xl font-black text-white">{service}</h1>
                <p className="text-lg text-gray-400 font-light">{tagline}</p>
                <div className="flex justify-center gap-1.5 pt-4">
                    {[0, 1, 2].map(i => (
                        <div
                            key={i}
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ background: 'var(--primary)', animation: `pulse 1s ease-in-out ${i * 0.2}s infinite` }}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
