'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from './AuthProvider';

export function AuthButton() {
    const { user, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, signOut } = useAuth();
    const [showModal, setShowModal] = useState(false);
    const [isSignUp, setIsSignUp] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (loading) {
        return <div className="w-8 h-8 bg-gray-700 rounded-full animate-pulse" />;
    }

    if (user) {
        return (
            <div className="flex items-center gap-3">
                <span className="text-sm text-gray-400 hidden sm:block">
                    {user.email?.split('@')[0]}
                </span>
                <button
                    onClick={() => signOut()}
                    className="text-sm text-gray-400 hover:text-white transition-colors"
                >
                    Sign Out
                </button>
            </div>
        );
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setSubmitting(true);

        const result = isSignUp
            ? await signUpWithEmail(email, password)
            : await signInWithEmail(email, password);

        setSubmitting(false);
        if (result.error) {
            setError(result.error);
        } else {
            setShowModal(false);
            setEmail('');
            setPassword('');
        }
    };

    const modal = (
        <div
            className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && setShowModal(false)}
        >
            <div className="relative bg-gray-900 border border-white/10 rounded-xl p-6 w-full max-w-sm max-h-[90vh] overflow-y-auto">
                <button
                    onClick={() => setShowModal(false)}
                    className="absolute top-3 right-3 text-gray-500 hover:text-white text-2xl leading-none"
                >
                    ×
                </button>
                <h2 className="text-xl font-bold mb-4 text-center">
                    {isSignUp ? 'Create Account' : 'Welcome Back'}
                </h2>

                {/* Google Sign In */}
                <button
                    onClick={signInWithGoogle}
                    className="w-full flex items-center justify-center gap-3 px-4 py-2.5 bg-white text-black rounded-lg font-medium hover:bg-gray-100 transition-colors mb-4"
                >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                    </svg>
                    Continue with Google
                </button>

                <div className="flex items-center gap-3 my-4">
                    <div className="flex-1 h-px bg-white/10" />
                    <span className="text-xs text-gray-500">or</span>
                    <div className="flex-1 h-px bg-white/10" />
                </div>

                {/* Email/Password Form */}
                <form onSubmit={handleSubmit} className="space-y-3">
                    <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="Email"
                        className="w-full px-4 py-2.5 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none"
                        required
                    />
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        className="w-full px-4 py-2.5 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none"
                        required
                        minLength={6}
                    />

                    {error && (
                        <p className="text-red-400 text-sm">{error}</p>
                    )}

                    <button
                        type="submit"
                        disabled={submitting}
                        className="w-full px-4 py-2.5 bg-gradient-to-r from-[#FF9900] to-[#FFDD00] hover:from-[#e68a00] hover:to-[#e6c700] disabled:opacity-50 disabled:cursor-not-allowed text-black rounded-lg font-bold transition-all shadow-[0_0_15px_rgba(255,153,0,0.3)]"
                    >
                        {submitting ? 'Loading...' : (isSignUp ? 'Create Account' : 'Sign In')}
                    </button>
                </form>

                <p className="mt-4 text-center text-sm text-gray-400">
                    {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
                    <button
                        onClick={() => setIsSignUp(!isSignUp)}
                        className="text-[#FF9900] hover:text-[#FFDD00] font-medium"
                    >
                        {isSignUp ? 'Sign In' : 'Sign Up'}
                    </button>
                </p>
            </div>
        </div>
    );

    return (
        <>
            <button
                onClick={() => setShowModal(true)}
                className="px-4 py-1.5 bg-gradient-to-r from-[#FF9900] to-[#FFDD00] hover:from-[#e68a00] hover:to-[#e6c700] text-black rounded-lg text-sm font-bold transition-all shadow-[0_0_10px_rgba(255,153,0,0.3)]"
            >
                Sign In
            </button>
            {showModal && mounted && createPortal(modal, document.body)}
        </>
    );
}
