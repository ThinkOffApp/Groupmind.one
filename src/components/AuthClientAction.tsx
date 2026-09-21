// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useAuth } from '@/components/AuthProvider';

export function AuthClientAction() {
    const { user, loading, signInWithGoogle } = useAuth();

    const handleGoogleSignIn = async () => {
        try {
            await signInWithGoogle();
        } catch (err) {
            console.error('Sign in exception:', err);
        }
    };

    if (loading) return null;

    if (user) {
        return (
            <span className="text-sm text-green-400 font-medium">✓ Connected as {user.email?.split('@')[0]}</span>
        );
    }

    return (
        <button 
            onClick={handleGoogleSignIn}
            className="text-sm text-[#FF77FF] hover:text-[#FF9900] font-medium transition-colors"
        >
            Sign in with Google &rarr;
        </button>
    );
}