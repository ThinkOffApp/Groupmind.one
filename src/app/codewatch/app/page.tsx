// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CodeWatchMode } from '@/components/CodeWatchMode';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase-browser';

// CodeWatch palette (kept inline so this route reads as CodeWatch, not GroupMind).
const C = {
    bg: '#16181c',
    panel: '#1e2127',
    text: '#f2f3f5',
    muted: '#a9adb6',
    orange: '#ff9900',
    green: '#99dd00',
    border: 'rgba(255,255,255,0.08)',
};

type Room = {
    id: string;
    name: string;
    slug: string;
    is_public: boolean;
    last_preview?: string | null;
    last_from?: string | null;
};

type Pairing = { code: string; expires_at: string } | null;

type Member = {
    agent_id: string | null;
    user_id: string | null;
    handle: string | null;
    name: string | null;
    is_agent: boolean;
};

export default function CodeWatchWebApp() {
    const { user, loading, signInWithGoogle } = useAuth();
    const [rooms, setRooms] = useState<Room[]>([]);
    const [roomsLoading, setRoomsLoading] = useState(false);
    const [pairing, setPairing] = useState<Pairing>(null);
    const [pairingBusy, setPairingBusy] = useState(false);
    const [pairingError, setPairingError] = useState<string | null>(null);
    const pairTriggered = useRef(false);

    // Room members management.
    const [membersRoom, setMembersRoom] = useState<Room | null>(null);
    const [members, setMembers] = useState<Member[]>([]);
    const [membersBusy, setMembersBusy] = useState(false);
    const [membersError, setMembersError] = useState<string | null>(null);
    const [addHandle, setAddHandle] = useState('');

    const loadRooms = useCallback(async () => {
        if (!user) return;
        setRoomsLoading(true);
        try {
            const supabase = createClient();
            const { data } = await supabase
                .from('room_members')
                .select('room:rooms(id, name, slug, is_public)')
                .eq('user_id', user.id);

            const list = ((data ?? []) as Array<{ room: Room | null }>)
                .map((d) => d.room)
                .filter((r): r is Room => !!r);

            setRooms(list);
            setRoomsLoading(false);

            // Best-effort last-message preview per room.
            const withPreview = await Promise.all(
                list.map(async (room) => {
                    try {
                        const res = await fetch(
                            `/api/v1/rooms/${encodeURIComponent(room.slug)}/messages?limit=1`,
                            { cache: 'no-store' }
                        );
                        if (!res.ok) return room;
                        const payload = await res.json();
                        const latest = payload?.messages?.[0];
                        return {
                            ...room,
                            last_preview: latest?.body ?? null,
                            last_from: latest?.from_name ?? latest?.from ?? null,
                        };
                    } catch {
                        return room;
                    }
                })
            );
            setRooms(withPreview);
        } catch {
            setRoomsLoading(false);
        }
    }, [user]);

    useEffect(() => {
        if (user) loadRooms();
    }, [user, loadRooms]);

    const showPairingQr = async () => {
        setPairingBusy(true);
        setPairingError(null);
        try {
            const res = await fetch('/api/v1/relay/pair', { method: 'POST' });
            if (!res.ok) {
                setPairingError('Could not create a pairing code. Try again.');
                setPairingBusy(false);
                return;
            }
            const data = await res.json();
            setPairing({ code: data.code, expires_at: data.expires_at });
        } catch {
            setPairingError('Network error creating the pairing code.');
        }
        setPairingBusy(false);
    };

    // Deep link: codewatch.app/app?pair=1 opens the pairing QR straight away
    // (after Google sign-in if needed), so "Show pairing QR" works from the
    // main site without first hunting through My rooms.
    useEffect(() => {
        if (!user || pairTriggered.current) return;
        if (typeof window === 'undefined') return;
        const wantsPair = new URLSearchParams(window.location.search).get('pair') === '1';
        if (wantsPair) {
            pairTriggered.current = true;
            showPairingQr();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);

    const openMembers = async (room: Room) => {
        setMembersRoom(room);
        setMembers([]);
        setMembersError(null);
        setAddHandle('');
        setMembersBusy(true);
        try {
            const res = await fetch(`/api/v1/rooms/${encodeURIComponent(room.slug)}/members`, { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                setMembers(data.members || []);
            } else {
                setMembersError('Could not load members.');
            }
        } catch {
            setMembersError('Network error loading members.');
        }
        setMembersBusy(false);
    };

    const addAgent = async () => {
        if (!membersRoom || !addHandle.trim()) return;
        setMembersBusy(true);
        setMembersError(null);
        try {
            const res = await fetch(`/api/v1/rooms/${encodeURIComponent(membersRoom.slug)}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handle: addHandle.trim() }),
            });
            if (res.ok) {
                setAddHandle('');
                await openMembers(membersRoom);
                return;
            }
            const err = await res.json().catch(() => ({}));
            setMembersError(err.error || 'Could not add that agent.');
        } catch {
            setMembersError('Network error adding agent.');
        }
        setMembersBusy(false);
    };

    const removeAgent = async (agentId: string) => {
        if (!membersRoom) return;
        setMembersBusy(true);
        setMembersError(null);
        try {
            const res = await fetch(
                `/api/v1/rooms/${encodeURIComponent(membersRoom.slug)}/members?agent_id=${encodeURIComponent(agentId)}`,
                { method: 'DELETE' }
            );
            if (res.ok) {
                await openMembers(membersRoom);
                return;
            }
            setMembersError('Could not remove that agent.');
        } catch {
            setMembersError('Network error removing agent.');
        }
        setMembersBusy(false);
    };

    const wrap: React.CSSProperties = {
        background: C.bg,
        color: C.text,
        minHeight: '70vh',
        margin: '-2rem auto 0',
        maxWidth: 760,
        padding: '0 20px 48px',
        fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    };

    return (
        <div style={wrap}>
            <CodeWatchMode />
            <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '24px 0' }}>
                <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.5px' }}>
                    <span style={{ color: '#fff' }}>code</span>
                    <span style={{ color: C.orange }}>watch</span>
                </span>
                <a href="https://codewatch.app/download" style={{ color: C.muted, textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
                    Download
                </a>
            </header>

            {loading ? (
                <p style={{ color: C.muted }}>Loading...</p>
            ) : !user ? (
                <section
                    style={{
                        background: C.panel,
                        border: `1px solid ${C.border}`,
                        borderRadius: 16,
                        padding: 28,
                        textAlign: 'center',
                        marginTop: 32,
                    }}
                >
                    <div
                        style={{
                            width: 72,
                            height: 72,
                            borderRadius: '50%',
                            border: `5px solid ${C.orange}`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 28,
                            fontWeight: 700,
                            margin: '0 auto 20px',
                        }}
                    >
                        &lt;/&gt;
                    </div>
                    <h1 style={{ fontSize: 24, marginBottom: 10, letterSpacing: '-0.5px' }}>Your rooms</h1>
                    <p style={{ color: C.muted, marginBottom: 22 }}>
                        Sign in with Google to see your CodeWatch rooms, follow conversations, and pair another device.
                    </p>
                    <button
                        onClick={() => signInWithGoogle()}
                        style={{
                            background: C.green,
                            color: '#0c1200',
                            fontWeight: 700,
                            fontSize: 16,
                            border: 'none',
                            borderRadius: 12,
                            padding: '14px 26px',
                            cursor: 'pointer',
                        }}
                    >
                        Sign in with Google
                    </button>
                </section>
            ) : (
                <section>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
                        <h1 style={{ fontSize: 24, letterSpacing: '-0.5px' }}>My rooms</h1>
                        <button
                            onClick={showPairingQr}
                            disabled={pairingBusy}
                            style={{
                                background: C.orange,
                                color: '#0c1200',
                                fontWeight: 700,
                                fontSize: 14,
                                border: 'none',
                                borderRadius: 10,
                                padding: '10px 16px',
                                cursor: pairingBusy ? 'default' : 'pointer',
                                opacity: pairingBusy ? 0.7 : 1,
                            }}
                        >
                            {pairingBusy ? 'Creating...' : 'Show pairing QR'}
                        </button>
                    </div>

                    {pairingError && <p style={{ color: '#ff6b6b', marginBottom: 14 }}>{pairingError}</p>}

                    {/* Primary onboarding: a new user has no agents yet, so connecting one comes first. */}
                    <div
                        style={{
                            background: C.panel,
                            border: `1px solid ${C.border}`,
                            borderRadius: 14,
                            padding: 18,
                            marginBottom: 16,
                        }}
                    >
                        <h2 style={{ fontSize: 17, marginBottom: 6 }}>Connect your coding agent</h2>
                        <p style={{ fontSize: 14, color: C.muted, lineHeight: 1.55, marginBottom: 14 }}>
                            Agents are the AI coding tools you want to watch from your phone, like Claude Code,
                            Codex, or Cursor. Connect one on your computer and it shows up here, then you can follow
                            it and approve its requests from anywhere.
                        </p>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                            <a
                                href="https://codewatch.app/download"
                                style={{
                                    background: C.green,
                                    color: '#0c1200',
                                    fontWeight: 700,
                                    fontSize: 14,
                                    borderRadius: 10,
                                    padding: '10px 16px',
                                    textDecoration: 'none',
                                }}
                            >
                                Set up on your computer
                            </a>
                            <a
                                href="https://codewatch.app/download"
                                style={{
                                    background: 'transparent',
                                    color: C.text,
                                    border: `1px solid ${C.border}`,
                                    fontWeight: 600,
                                    fontSize: 14,
                                    borderRadius: 10,
                                    padding: '10px 16px',
                                    textDecoration: 'none',
                                }}
                            >
                                Other ways to connect
                            </a>
                        </div>
                        <p style={{ fontSize: 12, color: C.muted, marginTop: 12, marginBottom: 0 }}>
                            On a Mac, get the one-click app:{' '}
                            <a href="https://codewatch.app/CodeWatchHelper.dmg" style={{ color: C.green, textDecoration: 'none' }}>Download for Mac</a>.
                            On other systems, use the short setup command (Set up on your computer).
                        </p>
                    </div>

                    {/* Secondary/advanced: dropping an already-registered agent into a room by handle. */}
                    <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 16 }}>
                        <strong style={{ color: C.muted }}>Advanced:</strong> already have agents? Tap{' '}
                        <span style={{ color: C.text }}>Members</span> on a room you own to add an existing one by
                        handle (like <span style={{ color: C.text }}>@ether</span>). Most people can skip this.
                    </p>

                    {roomsLoading && rooms.length === 0 ? (
                        <p style={{ color: C.muted }}>Loading your rooms...</p>
                    ) : rooms.length === 0 ? (
                        <p style={{ color: C.muted }}>
                            No rooms yet. Open the CodeWatch app or GroupMind to join or create one.
                        </p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {rooms.map((room) => (
                                <div
                                    key={room.id}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 12,
                                        background: C.panel,
                                        border: `1px solid ${C.border}`,
                                        borderRadius: 14,
                                        padding: 18,
                                    }}
                                >
                                    <Link
                                        href={`/messages/room/${encodeURIComponent(room.slug)}`}
                                        style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: C.text }}
                                    >
                                        <div style={{ fontWeight: 600, marginBottom: 4 }}>{room.name || room.slug}</div>
                                        <div style={{ fontSize: 13, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {room.last_preview
                                                ? `${room.last_from ? room.last_from + ': ' : ''}${room.last_preview}`
                                                : `/${room.slug}`}
                                        </div>
                                    </Link>
                                    <button
                                        onClick={() => openMembers(room)}
                                        style={{
                                            background: 'transparent',
                                            color: C.muted,
                                            border: `1px solid ${C.border}`,
                                            borderRadius: 8,
                                            padding: '8px 12px',
                                            fontSize: 13,
                                            cursor: 'pointer',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        Members
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            )}

            {pairing && (
                <div
                    onClick={() => setPairing(null)}
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0,0,0,0.6)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 20,
                        zIndex: 50,
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: C.panel,
                            border: `1px solid ${C.border}`,
                            borderRadius: 16,
                            padding: 28,
                            maxWidth: 360,
                            width: '100%',
                            textAlign: 'center',
                        }}
                    >
                        <h2 style={{ fontSize: 18, marginBottom: 8 }}>Pair a device</h2>
                        <p style={{ color: C.muted, fontSize: 14, marginBottom: 18 }}>
                            Scan this in the CodeWatch app on another phone, watch, or Mac to sign that device into your account.
                        </p>
                        <div style={{ background: '#fff', padding: 16, borderRadius: 12, display: 'inline-block' }}>
                            <QRCodeSVG value={pairing.code} size={196} />
                        </div>
                        <p style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 22, letterSpacing: 3, margin: '18px 0 6px' }}>
                            {pairing.code}
                        </p>
                        <p style={{ color: C.muted, fontSize: 12 }}>
                            Or enter this code manually. Expires in about 5 minutes.
                        </p>
                        <button
                            onClick={() => setPairing(null)}
                            style={{
                                marginTop: 18,
                                background: 'transparent',
                                color: C.text,
                                border: `1px solid ${C.border}`,
                                borderRadius: 10,
                                padding: '10px 18px',
                                cursor: 'pointer',
                                fontSize: 14,
                            }}
                        >
                            Done
                        </button>
                    </div>
                </div>
            )}

            {membersRoom && (
                <div
                    onClick={() => setMembersRoom(null)}
                    style={{
                        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 50,
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16,
                            padding: 24, maxWidth: 420, width: '100%',
                        }}
                    >
                        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Members</h2>
                        <p style={{ color: C.muted, fontSize: 13, marginBottom: 16 }}>
                            {membersRoom.name || membersRoom.slug}
                        </p>

                        {membersError && <p style={{ color: '#ff6b6b', fontSize: 13, marginBottom: 12 }}>{membersError}</p>}

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18, maxHeight: 260, overflowY: 'auto' }}>
                            {members.length === 0 && !membersBusy ? (
                                <p style={{ color: C.muted, fontSize: 13 }}>No members listed.</p>
                            ) : (
                                members.map((m, i) => (
                                    <div key={(m.agent_id || m.user_id || i) + ''} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <span style={{ color: m.is_agent ? C.green : C.text, fontSize: 14 }}>
                                                {m.is_agent
                                                    ? (m.handle || 'agent')
                                                    : (m.user_id && m.user_id === user?.id ? 'you' : 'member')}
                                            </span>
                                            {m.name && <span style={{ color: C.muted, fontSize: 12, marginLeft: 8 }}>{m.name}</span>}
                                        </div>
                                        {m.is_agent && m.agent_id && (
                                            <button
                                                onClick={() => removeAgent(m.agent_id as string)}
                                                disabled={membersBusy}
                                                style={{ background: 'transparent', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
                                            >
                                                Remove
                                            </button>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>

                        <div style={{ display: 'flex', gap: 8 }}>
                            <input
                                value={addHandle}
                                onChange={(e) => setAddHandle(e.target.value)}
                                placeholder="agent handle, e.g. claudemb"
                                style={{
                                    flex: 1, background: C.bg, color: C.text, border: `1px solid ${C.border}`,
                                    borderRadius: 8, padding: '10px 12px', fontSize: 14,
                                }}
                            />
                            <button
                                onClick={addAgent}
                                disabled={membersBusy || !addHandle.trim()}
                                style={{
                                    background: C.green, color: '#0c1200', fontWeight: 700, border: 'none',
                                    borderRadius: 8, padding: '10px 16px', fontSize: 14,
                                    cursor: membersBusy || !addHandle.trim() ? 'default' : 'pointer',
                                    opacity: membersBusy || !addHandle.trim() ? 0.6 : 1,
                                }}
                            >
                                Add
                            </button>
                        </div>

                        <button
                            onClick={() => setMembersRoom(null)}
                            style={{
                                marginTop: 16, background: 'transparent', color: C.text, border: `1px solid ${C.border}`,
                                borderRadius: 10, padding: '10px 18px', cursor: 'pointer', fontSize: 14, width: '100%',
                            }}
                        >
                            Done
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
