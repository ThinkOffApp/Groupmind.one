// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';

interface Profile {
    id: string;
    user_id: string;
    display_name: string | null;
    handle: string | null;
    email: string;
    created_at: string;
}

export default function ProfilePage() {
    const { user, loading } = useAuth();
    const [profile, setProfile] = useState<Profile | null>(null);
    const [loadingProfile, setLoadingProfile] = useState(true);
    const [displayName, setDisplayName] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    useEffect(() => {
        if (user) {
            loadProfile();
        }
    }, [user]);

    const loadProfile = async () => {
        setLoadingProfile(true);
        try {
            const res = await fetch('/api/v1/profile');
            if (res.ok) {
                const data = await res.json();
                setProfile(data);
                setDisplayName(data.display_name || '');
            }
        } catch (e) {
            console.error('Error loading profile:', e);
        }
        setLoadingProfile(false);
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setError('');
        setSuccess('');

        try {
            const res = await fetch('/api/v1/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ display_name: displayName.trim() }),
            });

            const data = await res.json();
            if (!res.ok) {
                setError(data.error || 'Failed to save');
                return;
            }

            setProfile(data);
            setSuccess('Profile saved!');
            setTimeout(() => setSuccess(''), 3000);
        } catch (e) {
            setError('Network error');
        } finally {
            setSaving(false);
        }
    };

    if (loading || loadingProfile) {
        return (
            <div className="flex items-center justify-center min-h-[50vh]">
                <div className="animate-spin w-8 h-8 border-2 border-[#55AA00] border-t-transparent rounded-full" />
            </div>
        );
    }

    if (!user) {
        return (
            <div className="max-w-lg mx-auto text-center py-16">
                <div className="text-6xl mb-6">👤</div>
                <h1 className="text-2xl font-bold mb-4">Sign in to view Profile</h1>
                <p className="text-gray-400">
                    Click "Sign In" in the top right to get started.
                </p>
            </div>
        );
    }

    return (
        <div className="max-w-2xl mx-auto">
            <div className="flex items-center gap-3 mb-6">
                <Link href="/messages" className="text-gray-400 hover:text-white">
                    ←
                </Link>
                <h1 className="text-2xl font-bold flex items-center gap-3">
                    <span>👤</span> Profile Settings
                </h1>
            </div>

            <div className="bg-gray-900/50 border border-white/10 rounded-xl p-6">
                <form onSubmit={handleSave} className="space-y-6">
                    {/* Email (read-only) */}
                    <div>
                        <label className="block text-sm text-gray-400 mb-2">Email</label>
                        <div className="px-4 py-3 bg-gray-800/50 border border-white/10 rounded-lg text-gray-300">
                            {profile?.email || user.email}
                        </div>
                        <p className="text-xs text-gray-500 mt-1">Connected via Google Sign-In</p>
                    </div>

                    {/* Display Name */}
                    <div>
                        <label className="block text-sm text-gray-400 mb-2">Display Name</label>
                        <input
                            type="text"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            placeholder="How you want to appear in chats"
                            className="w-full px-4 py-3 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none"
                            maxLength={50}
                        />
                        <p className="text-xs text-gray-500 mt-1">
                            This is how your name will appear in room messages
                        </p>
                    </div>

                    {/* Messages */}
                    {error && (
                        <div className="p-3 bg-red-950/30 border border-red-700/30 rounded-lg">
                            <p className="text-red-400 text-sm">{error}</p>
                        </div>
                    )}
                    {success && (
                        <div className="p-3 bg-[#55AA00]/30 border border-pink-700/30 rounded-lg">
                            <p className="text-[#99DD00] text-sm">{success}</p>
                        </div>
                    )}

                    {/* Save Button */}
                    <button
                        type="submit"
                        disabled={saving}
                        className="px-6 py-2.5 bg-[#55AA00] hover:bg-[#99DD00] disabled:bg-gray-700 rounded-lg font-medium transition-colors"
                    >
                        {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                </form>
            </div>

            {/* Account Info */}
            <div className="mt-6 p-4 bg-gray-900/30 border border-white/5 rounded-xl">
                <h3 className="text-sm font-medium text-gray-400 mb-2">Account Info</h3>
                <p className="text-xs text-gray-500">
                    Member since {profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : 'recently'}
                </p>
            </div>
        </div>
    );
}
