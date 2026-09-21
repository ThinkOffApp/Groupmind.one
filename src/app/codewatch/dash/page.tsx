// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { CodeWatchMode } from '@/components/CodeWatchMode';

// The web half of the CodeWatch dashboard (the owner asked: "dash mukaan").
//
// Local devices and Agent work come from the intent document, which is the same
// source the phone reads, so the two agree by construction. Pull requests and
// releases are NOT here: the Android app gets those from GitHub with a token it
// obtains through the device flow, and the web app holds no such token. Showing
// an empty "Pull requests" column would imply "no open PRs", which is a
// different statement from "not connected" - so the column says which it is.

const C = { bg: '#16181c', panel: '#1e2127', text: '#f2f3f5', muted: '#a9adb6', orange: '#ff9900', green: '#99dd00', border: 'rgba(255,255,255,0.08)' };

type Slot = Record<string, unknown>;

function age(updatedAt: unknown): { label: string; live: boolean } {
    if (typeof updatedAt !== 'string') return { label: '-', live: false };
    const secs = (Date.now() - new Date(updatedAt).getTime()) / 1000;
    if (!isFinite(secs)) return { label: '-', live: false };
    const live = secs < 120;
    if (secs < 60) return { label: 'now', live };
    if (secs < 3600) return { label: `${Math.round(secs / 60)}m`, live };
    if (secs < 86400) return { label: `${Math.round(secs / 3600)}h`, live };
    return { label: `${Math.round(secs / 86400)}d`, live };
}

function Card({ title, sub, when, live }: { title: string; sub?: string; when: string; live: boolean }) {
    return (
        <div style={{ border: `1px solid ${live ? 'rgba(153,221,0,0.35)' : C.border}`, borderLeft: `3px solid ${live ? C.green : C.border}`, borderRadius: 10, padding: '10px 12px', marginBottom: 8, background: C.panel }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: 14 }}>{title}</strong>
                <span style={{ fontSize: 12, color: live ? C.green : C.muted, whiteSpace: 'nowrap' }}>{live ? '● live' : '○ stale'}</span>
            </div>
            {sub && <div style={{ fontSize: 13, color: C.muted, marginTop: 4, wordBreak: 'break-word' }}>{sub}</div>}
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{when}</div>
        </div>
    );
}

export default function CodeWatchDashPage() {
    const { user, loading, signInWithGoogle } = useAuth();
    const [doc, setDoc] = useState<{ devices?: Record<string, Slot>; agents?: Record<string, Slot> } | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!user) return;
        let cancelled = false;
        const load = async () => {
            try {
                const res = await fetch(`/api/v1/intent/${encodeURIComponent(user.id)}`, { cache: 'no-store' });
                if (!res.ok) throw new Error(`intent ${res.status}`);
                const data = await res.json();
                if (!cancelled) { setDoc(data); setError(''); }
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : 'failed to load');
            }
        };
        load();
        const t = setInterval(load, 30000);   // the slots carry a 90s TTL
        return () => { cancelled = true; clearInterval(t); };
    }, [user]);

    const devices = Object.entries(doc?.devices ?? {});
    const agents = Object.entries(doc?.agents ?? {});

    return (
        <div style={{ background: C.bg, color: C.text, minHeight: '70vh', margin: '-2rem auto 0', maxWidth: 1100, padding: '0 20px 48px' }}>
            <CodeWatchMode />
            <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 0' }}>
                <h1 style={{ fontSize: 22, fontWeight: 700 }}>Dashboard</h1>
                <Link href="/codewatch/app" style={{ color: C.muted, textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>My rooms</Link>
            </header>

            {loading ? <p style={{ color: C.muted }}>Loading...</p> : !user ? (
                <section style={{ border: `1px solid ${C.border}`, borderRadius: 14, padding: 24, background: C.panel, textAlign: 'center' }}>
                    <p style={{ color: C.muted, marginBottom: 16 }}>Sign in with Google to see your devices and agents.</p>
                    <button onClick={() => signInWithGoogle()} style={{ background: C.green, color: '#111', border: 0, borderRadius: 10, padding: '12px 20px', fontWeight: 700, cursor: 'pointer' }}>Sign in with Google</button>
                </section>
            ) : (
                <>
                    {error && <p style={{ color: C.orange, marginBottom: 12 }}>Could not load the dashboard: {error}</p>}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
                        <section>
                            <h2 style={{ fontSize: 15, marginBottom: 10 }}>📡 Local devices <span style={{ color: C.muted, fontWeight: 400 }}>{devices.length}</span></h2>
                            {devices.length === 0 ? <p style={{ color: C.muted, fontSize: 13 }}>All clear</p> : devices.map(([name, d]) => {
                                const a = age((d as Slot).updated_at);
                                const bits = [d.model, d.temp_c != null ? `${d.temp_c} C` : null, d.load_1m != null ? `load ${d.load_1m}` : null, d.memory].filter(Boolean);
                                return <Card key={name} title={name} sub={bits.join(' · ') || String(d.network ?? '')} when={a.label} live={a.live} />;
                            })}
                        </section>
                        <section>
                            <h2 style={{ fontSize: 15, marginBottom: 10 }}>🤖 Agent work <span style={{ color: C.muted, fontWeight: 400 }}>{agents.length}</span></h2>
                            {agents.length === 0 ? <p style={{ color: C.muted, fontSize: 13 }}>All clear</p> : agents.map(([name, a]) => {
                                const t = age((a as Slot).updated_at);
                                return <Card key={name} title={name} sub={String(a.current_task ?? a.status ?? '')} when={t.label} live={t.live} />;
                            })}
                        </section>
                        <section>
                            <h2 style={{ fontSize: 15, marginBottom: 10 }}>🐙 Pull requests</h2>
                            <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, background: C.panel }}>
                                <p style={{ color: C.muted, fontSize: 13, margin: 0 }}>
                                    Not connected on the web yet. The phone app reads these with a GitHub token from its device-flow sign-in; this page has none, so it is showing you that rather than an empty column that would read as &quot;no open PRs&quot;.
                                </p>
                            </div>
                        </section>
                    </div>
                </>
            )}
        </div>
    );
}
