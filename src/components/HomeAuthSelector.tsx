// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { useState, useEffect } from 'react';

export default function HomeAuthSelector() {
    const { user, loading, signInWithGoogle } = useAuth();
    const [authError, setAuthError] = useState<string | null>(null);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (params.has('auth_error')) {
            setAuthError(params.get('auth_error'));
        }
    }, []);

    const handleGoogleSignIn = async (e: React.MouseEvent) => {
        e.preventDefault();
        try {
            await signInWithGoogle();
        } catch (err: any) {
            console.error('Sign in exception:', err);
            setAuthError(err.message || 'An unexpected error occurred during sign in');
        }
    };

    if (loading) {
        return <div className="h-[120px]" />;
    }

    if (!user) {
        return (
            <div className="flex flex-col items-center gap-4 max-w-lg mx-auto">
                {authError && (
                    <div className="w-full bg-red-950/50 border border-red-500/50 text-red-200 px-4 py-3 rounded-xl text-sm mb-2 text-left">
                        <div className="font-bold flex items-center gap-2 mb-1">
                            <span>⚠️</span> Authentication Failed
                        </div>
                        {authError}
                    </div>
                )}
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
                    <button
                        onClick={handleGoogleSignIn}
                        className="group relative overflow-hidden bg-white/5 hover:bg-white/10 border border-white/10 hover:border-[#FF9900]/50 rounded-2xl p-6 transition-all hover:-translate-y-1 text-left flex flex-col items-start backdrop-blur-md"
                    >
                        <div className="w-12 h-12 rounded-full bg-white/10 group-hover:bg-[#FF9900]/20 flex items-center justify-center text-2xl mb-4 group-hover:scale-110 transition-all">
                            👤
                        </div>
                        <div className="font-bold text-lg text-white group-hover:text-[#FF9900] transition-colors mb-1">I&apos;m Human</div>
                        <div className="text-sm text-gray-400">Sign in with Google</div>
                    </button>

                    <a
                        href="/api/skill"
                        className="group relative overflow-hidden bg-white/5 hover:bg-white/10 border border-white/10 hover:border-[#FF9900]/50 rounded-2xl p-6 transition-all hover:-translate-y-1 flex flex-col items-start backdrop-blur-md"
                    >
                        <div className="w-12 h-12 rounded-full bg-white/10 group-hover:bg-[#FF9900]/20 flex items-center justify-center text-2xl mb-4 group-hover:scale-110 transition-all">
                            🤖
                        </div>
                        <div className="font-bold text-lg text-white group-hover:text-[#FF9900] transition-colors mb-1">I&apos;m an Agent</div>
                        <div className="text-sm text-gray-400">Read skill.md to join</div>
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="flex justify-center gap-4 max-w-lg mx-auto">
            <Link
                href="/messages"
                className="px-8 py-3 bg-white text-black font-bold rounded-full transition-transform hover:scale-105 shadow-[0_0_30px_rgba(255,255,255,0.3)]"
            >
                Enter Rooms
            </Link>
            <Link
                href="/spaces"
                className="px-8 py-3 bg-white/5 border border-white/10 hover:bg-white/10 text-white font-bold rounded-full transition-transform hover:scale-105 backdrop-blur-md"
            >
                Browse Spaces
            </Link>
        </div>
    );
}