// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from './AuthProvider';
import { createClient } from '@/lib/supabase-browser';

// Handles we want a slot for even when they are not publishing, so a silent
// agent is visibly silent rather than absent. These must match the ids the
// publishers actually use (e.g. "codexmb" publishes under that name, not
// "codex"), so the order comes from this install's own configuration
// instead of a hardcoded fleet: selfhost/gen-env.sh writes the operator's
// agent handles into NEXT_PUBLIC_AGENT_HANDLES (same list, comma-separated,
// as GROUPMIND_AGENT_HANDLES/ADMIN_AGENT_HANDLES). An unconfigured instance
// gets an empty list, so unknown handles simply get no priority ordering.
const PRIORITY: string[] = (process.env.NEXT_PUBLIC_AGENT_HANDLES || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
const MAX_SLOTS = 6;
const POLL_MS = 30_000;

/** Publishers disagree about case and the leading "@"; match on neither. */
function normalizeHandle(handle: string): string {
    return handle.replace(/^@/, '').toLowerCase();
}

type AgentEntry = {
    updated_at?: string;
    ttl_sec?: number;
    [key: string]: unknown;
};

type IntentState = {
    agents?: Record<string, AgentEntry>;
    stale_agents?: string[];
};

function ageMinutes(updatedAt?: string): number {
    if (!updatedAt) return Infinity;
    const t = Date.parse(updatedAt);
    if (isNaN(t)) return Infinity;
    return (Date.now() - t) / 60_000;
}

function colorForAge(minutes: number, isStale: boolean): string {
    if (minutes === Infinity && !isStale) return '#3f3f46'; // grey for inactive
    if (isStale || minutes >= 30) return '#dc2626'; // red
    if (minutes >= 5) return '#eab308'; // yellow
    return '#22c55e'; // green
}

function ageLabel(minutes: number): string {
    if (!Number.isFinite(minutes)) return 'never';
    if (minutes < 1) return `${Math.round(minutes * 60)}s`;
    if (minutes < 60) return `${Math.round(minutes)}m`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / (60 * 24))}d`;
}

export function IntentLeds() {
    const { user } = useAuth();
    const [handle, setHandle] = useState<string | null>(null);
    const [state, setState] = useState<IntentState | null>(null);
    // 0 = show "age ago", 1 = show focus_area. Alternates every 3s so each
    // active LED's tooltip flickers between presence and "working on".
    const [blinkPhase, setBlinkPhase] = useState<0 | 1>(0);

    useEffect(() => {
        const t = setInterval(() => setBlinkPhase((p) => (p === 0 ? 1 : 0)), 3000);
        return () => clearInterval(t);
    }, []);

    // Resolve the user's GroupMind handle. The /api/v1/intent/{id} endpoint
    // is keyed by the publisher's chosen identifier (typically handle, e.g.
    // "alice", not the auth UUID), so we need the handle to find the agents
    // that ClawWatch and other clients publish under. Falls back to the
    // auth UUID if there is no profile row.
    useEffect(() => {
        if (!user?.id) {
            setHandle(null);
            return;
        }
        const supabase = createClient();
        let cancelled = false;
        supabase
            .from('user_profiles')
            .select('handle')
            .eq('user_id', user.id)
            .single()
            .then(({ data }: { data: { handle?: string } | null }) => {
                if (cancelled) return;
                const h = data?.handle?.replace(/^@/, '') || user.id;
                setHandle(h);
            });
        return () => {
            cancelled = true;
        };
    }, [user?.id]);

    useEffect(() => {
        if (!handle) return;
        let cancelled = false;

        async function pull() {
            try {
                const res = await fetch(`/api/v1/intent/${handle}`, { credentials: 'include' });
                if (!res.ok) return;
                const data = (await res.json()) as IntentState;
                if (!cancelled) setState(data);
            } catch {
                // silent — LEDs are decoration, do not surface fetch errors
            }
        }

        pull();
        const t = setInterval(pull, POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, [handle]);

    // Continue rendering even if not logged in (will show inactive LEDs)

    const agents = state?.agents || {};
    const staleSet = new Set(state?.stale_agents || []);

    // Agents are looked up by normalised handle: a publisher writing "@grok"
    // or "ClaudeMB" must resolve to the same slot as "grok" or "claudemb",
    // otherwise a live agent silently renders as "never".
    const byHandle = new Map<string, string>(); // normalised handle -> agent id
    for (const [id, entry] of Object.entries(agents)) {
        for (const alias of [id, entry?.handle, entry?.name]) {
            if (typeof alias === 'string' && alias) {
                const key = normalizeHandle(alias);
                if (!byHandle.has(key)) byHandle.set(key, id);
            }
        }
    }

    // Order: agents that are actually publishing come first, then stale ones,
    // then priority handles with no presence at all. A configured-but-absent
    // agent must never take a slot from one that is genuinely reporting —
    // that is what hid a live agent behind two permanently-silent names.
    const seen = new Set<string>();
    const ordered: string[] = [];
    const push = (handle: string) => {
        const key = normalizeHandle(handle);
        if (seen.has(key)) return;
        seen.add(key);
        ordered.push(handle);
    };

    for (const h of PRIORITY) {
        if (byHandle.has(normalizeHandle(h))) push(h);
    }
    for (const h of Object.keys(agents)) push(h);
    for (const h of staleSet) push(h);
    for (const h of PRIORITY) push(h);



    const slots = ordered.slice(0, MAX_SLOTS);
    const overflow = Math.max(0, ordered.length - MAX_SLOTS);

    // Build per-agent rows for the hover dashboard
    const dashRows = ordered.map((handle) => {
        let entry = agents[handle];
        let isStale = staleSet.has(handle);
        if (!entry && !isStale) {
            for (const [id, e] of Object.entries(agents)) {
                if (e.name === handle || e.handle === handle || (typeof e.name === 'string' && e.name.toLowerCase() === handle.toLowerCase())) {
                    entry = e; void id; break;
                }
            }
        }
        const minutes = ageMinutes(entry?.updated_at);
        const color = colorForAge(minutes, isStale);
        const focus = typeof entry?.focus_area === 'string' ? entry.focus_area : null;
        const host = typeof entry?.host === 'string' ? entry.host : null;
        const source = typeof entry?.source === 'string' ? entry.source : null;
        return { handle, color, minutes, isStale, focus, host, source };
    });

    return (
        <div className="hidden md:block relative group">
        <Link
            href="/intent"
            className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/5 transition-colors"
            title="Agent activity (hover for breakdown)"
        >
            {slots.map((handle) => {
                // Try to find the agent by exact ID first
                let entry = agents[handle];
                let isStale = staleSet.has(handle);
                let actualId = handle;

                // If not found, try to find by name or handle in active agents
                if (!entry && !isStale) {
                    for (const [id, e] of Object.entries(agents)) {
                        if (e.name === handle || e.handle === handle || (typeof e.name === 'string' && e.name.toLowerCase() === handle.toLowerCase())) {
                            entry = e;
                            actualId = id;
                            break;
                        }
                    }
                }

                const minutes = ageMinutes(entry?.updated_at);
                const color = colorForAge(minutes, isStale);
                const isActive = !isStale && minutes < 30;
                const focus = typeof entry?.focus_area === 'string' && entry.focus_area
                    ? entry.focus_area
                    : null;
                // Phase 0 = solid filled active dot. Phase 1 = "working on" dot
                // with a brighter inner highlight + thicker glow, signalling
                // the agent is actively doing something. Inactive dots ignore
                // the phase and stay solid.
                const isWorkingPhase = isActive && blinkPhase === 1;
                const bg = isWorkingPhase
                    ? `radial-gradient(circle at 30% 30%, #ffffff 0%, ${color} 70%)`
                    : color;
                const glow = isWorkingPhase
                    ? `0 0 10px ${color}, 0 0 4px #ffffff80`
                    : `0 0 6px ${color}99`;
                const tickTitle = blinkPhase === 0 || !focus
                    ? `@${handle} • ${ageLabel(minutes)}`
                    : `@${handle} • working on ${focus}`;
                return (
                    <span
                        key={handle}
                        title={tickTitle}
                        aria-label={`${handle} ${ageLabel(minutes)} ago${focus ? `, ${focus}` : ''}`}
                        className="w-2.5 h-2.5 rounded-full inline-block transition-all duration-300"
                        style={{ background: bg, boxShadow: glow }}
                    />
                );
            })}
            {overflow > 0 && (
                <span className="text-xs text-gray-400 ml-1">+{overflow}</span>
            )}
        </Link>
        {/* Hover dashboard: full breakdown of every agent we know about */}
        <div className="invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity duration-150 absolute left-0 top-full mt-2 z-50 min-w-[280px] max-w-[360px] rounded-lg border border-white/10 bg-[#0a0a0a]/95 backdrop-blur-xl p-3 shadow-2xl">
            <div className="text-xs text-gray-400 font-medium mb-2 px-1">Agent activity</div>
            <ul className="space-y-1.5">
                {dashRows.map((row) => (
                    <li key={row.handle} className="flex items-start gap-2 text-sm px-1">
                        <span
                            className="mt-1.5 w-2.5 h-2.5 rounded-full inline-block flex-shrink-0"
                            style={{ backgroundColor: row.color, boxShadow: `0 0 6px ${row.color}99` }}
                        />
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-white font-medium truncate">@{row.handle}</span>
                                <span className="text-xs text-gray-500 flex-shrink-0">{ageLabel(row.minutes)}</span>
                            </div>
                            {row.focus && (
                                <div className="text-xs text-gray-400 truncate">working on {row.focus}</div>
                            )}
                            {(row.host || row.source) && (
                                <div className="text-[10px] text-gray-600 truncate">{[row.host, row.source].filter(Boolean).join(' · ')}</div>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
            <Link href="/intent" className="block text-xs text-[#99DD00] hover:underline mt-2 px-1">
                Open fleet dashboard →
            </Link>
        </div>
        </div>
    );
}
