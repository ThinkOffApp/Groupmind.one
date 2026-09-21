// SPDX-License-Identifier: AGPL-3.0-only
'use client';

/**
 * The owner's queue, driven by three buttons.
 *
 * Button 3 cycles, button 1 is yes, button 2 is no. Cycling changes the item
 * and the item defines the verb, so THE CARD STATES WHAT YES WILL DO before
 * anything is pressed - that sentence is the safety property of this screen,
 * not decoration. A person who cycled twice and looked away has to be able to
 * glance back and know what they are about to authorise.
 *
 * Everything else lives in `queue-keys.ts` (the reducer and its guards) and
 * `queue-items.ts` (the verbs). This file renders them and nothing more, so
 * the rules are testable without a DOM.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    CONFIRM_ARM_MS,
    KEY_BINDINGS,
    currentId,
    initialQueueState,
    legendFor,
    reduceAction,
    reduceKey,
    releaseKeys,
    syncQueue,
    type QueueAction,
    type QueueState,
} from '@/lib/queue-keys';
import { verbsFor, writesSomewhereElse, type QueueItem } from '@/lib/queue-items';

type ConnectState =
    | { kind: 'loading' }
    | { kind: 'signed-out' }
    | { kind: 'unconfigured' }
    | { kind: 'disconnected' }
    | { kind: 'connecting'; userCode: string; verificationUri: string; note: string }
    | { kind: 'ready'; githubConnected: boolean; scope: string };

const API = '/api/v1';

export default function QueueReview() {
    const [connect, setConnect] = useState<ConnectState>({ kind: 'loading' });
    const [items, setItems] = useState<QueueItem[]>([]);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [queue, setQueue] = useState<QueueState>(() => initialQueueState([]));

    const stageRef = useRef<HTMLDivElement | null>(null);
    const confirmRef = useRef<HTMLDivElement | null>(null);

    const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
    const current = currentId(queue) ? byId.get(currentId(queue)!) ?? null : null;
    const confirmItem = queue.confirmFor ? byId.get(queue.confirmFor.id) ?? null : null;

    const refreshStatus = useCallback(async () => {
        try {
            const res = await fetch(`${API}/github/session`, { cache: 'no-store' });
            const body = await res.json();
            if (res.status === 401 || body.signed_in === false) setConnect({ kind: 'signed-out' });
            else if (!body.configured) setConnect({ kind: 'unconfigured' });
            else setConnect({ kind: 'ready', githubConnected: !!body.connected, scope: body.scope || '' });
        } catch {
            setConnect({ kind: 'signed-out' });
        }
    }, []);

    const loadQueue = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const res = await fetch(`${API}/queue`, { cache: 'no-store' });
            const body = await res.json();
            if (!res.ok) {
                setItems([]);
                setLoadError(body?.error || 'Could not read your queue');
                if (body?.reason === 'no-session') setConnect({ kind: 'signed-out' });
                return;
            }
            const next: QueueItem[] = Array.isArray(body.items) ? body.items : [];
            setItems(next);
            setWarnings(Array.isArray(body.warnings) ? body.warnings : []);
            setQueue((q) => syncQueue(q, next));
        } catch {
            setItems([]);
            setLoadError('Could not reach this server');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refreshStatus();
    }, [refreshStatus]);

    // The key gate only opens on a real release. This listens at the window
    // because the element focused when the key went down may be gone by the
    // time it comes up - the confirmation unmounts mid-press, which is exactly
    // the bouncing-button case.
    useEffect(() => {
        const onUp = () => setQueue(releaseKeys);
        window.addEventListener('keyup', onUp);
        window.addEventListener('blur', onUp);
        return () => {
            window.removeEventListener('keyup', onUp);
            window.removeEventListener('blur', onUp);
        };
    }, []);

    useEffect(() => {
        if (connect.kind === 'ready') loadQueue();
    }, [connect.kind, loadQueue]);

    useEffect(() => {
        if (queue.phase === 'confirm') confirmRef.current?.focus();
        else stageRef.current?.focus();
    }, [queue.phase, queue.order[0]]);

    const commit = useCallback(
        async (id: string, action: 'yes' | 'no') => {
            const item = byId.get(id);
            if (!item) return;
            setBusy(true);
            try {
                const payload: Record<string, unknown> = {
                    kind: item.kind,
                    action,
                    // What was on screen: the head commit, or the row's
                    // last-write time. The server refuses if it moved.
                    fingerprint: item.fingerprint,
                };
                if (item.kind === 'pull_request') {
                    payload.owner = item.owner;
                    payload.repo = item.repo;
                    payload.number = item.number;
                    payload.draft = !!item.blocked;
                } else {
                    payload.intent_id = item.intentId;
                }

                const res = await fetch(`${API}/queue/decide`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const body = await res.json();
                setQueue((q) => ({
                    ...q,
                    notice: res.ok && body.committed ? body.message || 'Done' : body?.reason || body?.error || 'Nothing was done',
                }));
                await loadQueue();
            } catch {
                setQueue((q) => ({ ...q, notice: 'Could not reach this server - nothing was done' }));
            } finally {
                setBusy(false);
            }
        },
        [byId, loadQueue]
    );

    const runEffect = useCallback(
        (effect: ReturnType<typeof reduceAction>['effect']) => {
            if (!effect) return;
            if (effect.type === 'refresh') loadQueue();
            if (effect.type === 'commit') commit(effect.id, effect.action);
        },
        [loadQueue, commit]
    );

    /** Pointer path: no arming window, a tap is already deliberate. */
    const dispatch = useCallback(
        (action: QueueAction) => {
            setQueue((q) => {
                const r = reduceAction(q, action, items, { enforceArm: false, now: Date.now() });
                runEffect(r.effect);
                return r.state;
            });
        },
        [items, runEffect]
    );

    /** Keyboard path: same reducer, plus the gate, the arming window and repeats. */
    const onKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            const probe = reduceKey(queue, e as unknown as KeyboardEvent, items, Date.now());
            if (!probe.handled) return;
            e.preventDefault();
            e.stopPropagation();
            setQueue((q) => {
                const r = reduceKey(q, e as unknown as KeyboardEvent, items, Date.now());
                runEffect(r.effect);
                return r.state;
            });
        },
        [queue, items, runEffect]
    );

    // ── GitHub device flow ──────────────────────────────────────────────

    const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (pollTimer.current) clearTimeout(pollTimer.current);
        },
        []
    );

    const pollOnce = useCallback(
        async (intervalSec: number) => {
            try {
                const res = await fetch(`${API}/github/device/poll`, { method: 'POST' });
                const body = await res.json();
                if (body.status === 'connected') {
                    await refreshStatus();
                    return;
                }
                if (body.status === 'denied' || body.status === 'expired' || body.status === 'error') {
                    setLoadError(body.message || 'GitHub did not complete the connection');
                    await refreshStatus();
                    return;
                }
                const next = body.status === 'slow_down' ? body.interval_sec || intervalSec + 5 : intervalSec;
                setConnect((c) =>
                    c.kind === 'connecting'
                        ? {
                              ...c,
                              note:
                                  body.status === 'slow_down'
                                      ? 'Waiting (GitHub asked us to slow down)'
                                      : 'Waiting for you to enter the code',
                          }
                        : c
                );
                pollTimer.current = setTimeout(() => pollOnce(next), next * 1000);
            } catch {
                pollTimer.current = setTimeout(() => pollOnce(intervalSec), intervalSec * 1000);
            }
        },
        [refreshStatus]
    );

    const startConnect = useCallback(async () => {
        setLoadError(null);
        try {
            const res = await fetch(`${API}/github/device/start`, { method: 'POST' });
            const body = await res.json();
            if (!res.ok) {
                setLoadError(body?.error || 'Could not start the GitHub connection');
                return;
            }
            setConnect({
                kind: 'connecting',
                userCode: body.user_code,
                verificationUri: body.verification_uri,
                note: 'Waiting for you to enter the code',
            });
            pollTimer.current = setTimeout(() => pollOnce(body.interval_sec || 5), (body.interval_sec || 5) * 1000);
        } catch {
            setLoadError('Could not reach this server');
        }
    }, [pollOnce]);

    const disconnect = useCallback(async () => {
        await fetch(`${API}/github/session`, { method: 'DELETE' });
        await refreshStatus();
        await loadQueue();
    }, [refreshStatus, loadQueue]);

    // ── Render ──────────────────────────────────────────────────────────

    return (
        <div className="max-w-3xl mx-auto py-10 px-5">
            <h1 className="mb-2 flex items-center gap-3 text-3xl font-bold text-white">
                <span aria-hidden="true">🗳️</span> Your queue
            </h1>
            <p className="mb-6 text-white/60">
                Everything waiting on you, one item at a time, three buttons. Button 3 cycles; buttons 1 and 2
                answer whatever is showing. A normal keyboard works too.
            </p>

            <ThreeButtonTable />

            <div aria-live="polite" className="sr-only">
                {queue.notice || ''}
            </div>

            {queue.notice && (
                <div className="my-4 rounded-xl border border-[#FF9900]/40 bg-[#FF9900]/10 px-4 py-3 text-[#FFCE7A]">
                    {queue.notice}
                </div>
            )}
            {loadError && (
                <div className="my-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-red-300">
                    {loadError}
                </div>
            )}

            {connect.kind === 'loading' && <p className="text-white/50">Loading…</p>}

            {connect.kind === 'signed-out' && (
                <div className="rounded-xl border border-white/10 bg-white/5 p-6 text-white/70">
                    Sign in to GroupMind to see your queue.
                </div>
            )}

            {connect.kind === 'unconfigured' && (
                <div className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-6 text-white/70">
                    <p className="font-semibold text-white">This deployment has no GitHub client id.</p>
                    <p>
                        Approvals still work. For pull requests, register a GitHub App with device flow enabled and
                        set <code className="font-mono text-[#FF77FF]">GITHUB_DEVICE_CLIENT_ID</code>. There is no
                        client secret and no callback URL to configure.
                    </p>
                </div>
            )}

            {connect.kind === 'connecting' && (
                <div className="space-y-4 rounded-xl border border-[#FF77FF]/40 bg-[#FF77FF]/10 p-6">
                    <p className="text-white/80">On any signed-in device, open this page and enter this code:</p>
                    <p className="select-all font-mono text-4xl tracking-[0.3em] text-white">{connect.userCode}</p>
                    <p className="text-white/70">
                        <a
                            href={connect.verificationUri}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded text-[#FF77FF] underline focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FF77FF]/60"
                        >
                            {connect.verificationUri}
                        </a>
                    </p>
                    <p className="text-white/50">{connect.note}…</p>
                </div>
            )}

            {connect.kind === 'ready' && (
                <div
                    ref={stageRef}
                    tabIndex={-1}
                    onKeyDown={onKeyDown}
                    className="rounded-2xl outline-none focus-visible:ring-4 focus-visible:ring-[#FF77FF]/30"
                >
                    {loading && <p className="py-6 text-white/50">Reading your queue…</p>}

                    {!loading && !current && (
                        <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
                            <p className="mb-2 text-xl text-white">Nothing is waiting on you.</p>
                            <p className="mb-6 text-white/50">
                                {queue.done.length > 0
                                    ? `${queue.done.length} answered this sitting.`
                                    : 'No open pull requests and no pending approvals.'}
                            </p>
                            <button
                                type="button"
                                data-action="refresh"
                                onClick={() => dispatch('refresh')}
                                className="rounded-lg border border-white/20 px-5 py-3 text-white/80 hover:bg-white/10 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FF77FF]/60"
                            >
                                Reload (any of your three buttons)
                            </button>
                        </div>
                    )}

                    {current && (
                        <>
                            <div className="mb-3 flex items-baseline justify-between text-sm text-white/40">
                                <span>
                                    {queue.order.length} waiting
                                    {queue.done.length > 0 ? ` · ${queue.done.length} answered` : ''}
                                </span>
                                <span className="rounded bg-white/10 px-2 py-0.5 text-xs uppercase tracking-wide text-white/60">
                                    {verbsFor(current).kindLabel}
                                </span>
                            </div>

                            <div className="rounded-2xl border-2 border-[#FF77FF] bg-[#FF77FF]/10 p-6 ring-4 ring-[#FF77FF]/20">
                                <p className="font-mono text-white/60">{current.subtitle}</p>
                                <h2 className="mt-2 text-2xl font-semibold text-white">{current.title}</h2>
                                <p className="mt-2 font-mono text-xs text-white/40">{current.detail}</p>
                                {current.url && (
                                    <p className="mt-2">
                                        <a
                                            href={current.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="rounded text-sm text-[#FF77FF] underline focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FF77FF]/60"
                                        >
                                            Open on GitHub
                                        </a>
                                    </p>
                                )}

                                {/* THE SAFETY PROPERTY OF THIS SCREEN. The verb
                                    changes with the item, so it is stated here,
                                    in full, before any button is pressed. */}
                                <div className="mt-5 space-y-2 rounded-xl border border-white/15 bg-black/30 p-4">
                                    <p className="text-sm text-white">
                                        <span className="font-mono text-[#55DD55]">y</span>{' '}
                                        <span className="font-semibold">{verbsFor(current).yesVerb}</span> -{' '}
                                        {verbsFor(current).yesSentence}
                                    </p>
                                    <p className="text-sm text-white/70">
                                        <span className="font-mono text-white/60">n</span>{' '}
                                        <span className="font-semibold">{verbsFor(current).noVerb}</span> -{' '}
                                        {verbsFor(current).noSentence}
                                    </p>
                                    {current.blocked && (
                                        <p className="text-sm text-[#FF9900]">{current.blocked}</p>
                                    )}
                                </div>
                            </div>

                            <div className="mt-5 grid gap-3 sm:grid-cols-3">
                                <ActionButton
                                    data-action="yes"
                                    onClick={() => dispatch('yes')}
                                    tone="yes"
                                    top={verbsFor(current).yesVerb}
                                    sub={writesSomewhereElse(current, 'yes') ? 'asks once more first' : ''}
                                    hint="y · button 1"
                                    disabled={busy}
                                />
                                <ActionButton
                                    data-action="no"
                                    onClick={() => dispatch('no')}
                                    tone="no"
                                    top={verbsFor(current).noVerb}
                                    sub={writesSomewhereElse(current, 'no') ? 'asks once more first' : 'changes nothing elsewhere'}
                                    hint="n · button 2"
                                    disabled={busy}
                                />
                                <ActionButton
                                    data-action="next"
                                    onClick={() => dispatch('next')}
                                    tone="next"
                                    top="Next"
                                    sub="cycle without answering"
                                    hint="m · button 3"
                                />
                            </div>

                            <div className="mt-4 flex items-center gap-3">
                                <button
                                    type="button"
                                    data-action="refresh"
                                    onClick={() => dispatch('refresh')}
                                    className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-sm text-white/70 hover:bg-white/10 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FF77FF]/60"
                                >
                                    ⟳ Reload
                                </button>
                                {connect.githubConnected ? (
                                    <button
                                        type="button"
                                        onClick={disconnect}
                                        className="ml-auto rounded-lg border border-white/15 px-4 py-2 text-sm text-white/50 hover:text-white/80 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FF77FF]/60"
                                    >
                                        Disconnect GitHub
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={startConnect}
                                        className="ml-auto rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70 hover:bg-white/10 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FF77FF]/60"
                                    >
                                        Connect GitHub for pull requests
                                    </button>
                                )}
                            </div>
                        </>
                    )}

                    {!connect.githubConnected && !loading && (
                        <p className="mt-4 text-xs text-white/35">
                            GitHub is not connected, so pull requests are not in this queue yet.
                        </p>
                    )}

                    {warnings.length > 0 && (
                        <ul className="mt-4 space-y-1 text-xs text-white/40">
                            {warnings.map((w) => (
                                <li key={w}>{w}</li>
                            ))}
                        </ul>
                    )}

                    <KeyLegend phase={queue.phase} />
                </div>
            )}

            {queue.phase === 'confirm' && confirmItem && queue.confirmFor && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-5"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="confirm-title"
                >
                    <div
                        ref={confirmRef}
                        tabIndex={-1}
                        onKeyDown={onKeyDown}
                        className="w-full max-w-lg rounded-2xl border-2 border-[#FF77FF] bg-[#121212] p-6 outline-none ring-4 ring-[#FF77FF]/30"
                    >
                        <h2 id="confirm-title" className="mb-1 text-xl font-bold text-white">
                            {queue.confirmFor.action === 'yes'
                                ? verbsFor(confirmItem).yesVerb
                                : verbsFor(confirmItem).noVerb}
                            : {confirmItem.subtitle}?
                        </h2>
                        <p className="mb-3 text-white/80">{confirmItem.title}</p>
                        <p className="mb-1 font-mono text-sm text-white/50">
                            pinned to {confirmItem.fingerprint.slice(0, 16)}
                        </p>
                        <p className="mb-5 text-sm text-white/50">
                            {queue.confirmFor.action === 'yes'
                                ? verbsFor(confirmItem).yesConsequence
                                : verbsFor(confirmItem).noSentence}
                        </p>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <ActionButton
                                data-action="yes"
                                onClick={() => dispatch('yes')}
                                tone="yes"
                                top={busy ? 'Working…' : 'Yes, do it'}
                                sub={
                                    queue.confirmFor.action === 'yes'
                                        ? verbsFor(confirmItem).yesVerb.toLowerCase()
                                        : verbsFor(confirmItem).noVerb.toLowerCase()
                                }
                                hint="y · button 1"
                                disabled={busy}
                            />
                            <ActionButton
                                data-action="no"
                                onClick={() => dispatch('no')}
                                tone="no"
                                top="Back out"
                                sub="do nothing"
                                hint="n · button 2"
                            />
                            <ActionButton
                                data-action="next"
                                onClick={() => dispatch('next')}
                                tone="next"
                                top="Back out, next"
                                sub="do nothing, cycle on"
                                hint="m · button 3"
                            />
                        </div>
                        <p className="mt-4 text-xs text-white/30">
                            Yes is ignored for the first {CONFIRM_ARM_MS}ms and until the button is released, so a
                            held or bouncing button cannot answer this. If anything cycles or reloads underneath,
                            this is cancelled rather than applied to something else.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}

function ActionButton({
    'data-action': dataAction,
    onClick,
    tone,
    top,
    sub,
    hint,
    disabled,
}: {
    /** Written literally at each call site: it is the pointer twin of a key. */
    'data-action': string;
    onClick: () => void;
    tone: 'yes' | 'no' | 'next';
    top: string;
    sub: string;
    hint: string;
    disabled?: boolean;
}) {
    const tones = {
        yes: 'border-[#55AA00] bg-[#55AA00]/15 hover:bg-[#55AA00]/25 text-white',
        no: 'border-white/25 bg-white/5 hover:bg-white/10 text-white/80',
        next: 'border-[#FF9900] bg-[#FF9900]/15 hover:bg-[#FF9900]/25 text-white',
    }[tone];
    return (
        <button
            type="button"
            data-action={dataAction}
            onClick={onClick}
            disabled={disabled}
            className={`rounded-xl border-2 px-4 py-4 text-left transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#FF77FF]/60 ${tones}`}
        >
            <span className="flex items-baseline justify-between gap-2">
                <span className="text-lg font-semibold">{top}</span>
                <span className="rounded bg-black/40 px-2 py-0.5 font-mono text-xs text-white/70">{hint}</span>
            </span>
            {sub && <span className="mt-1 block text-sm opacity-70">{sub}</span>}
        </button>
    );
}

/**
 * The three keys, published. We ship no configuration UI on purpose: the
 * gadget's own side decides what its buttons emit, so our job is to name three
 * keys plainly and listen for them.
 */
function ThreeButtonTable() {
    return (
        <div className="rounded-xl border border-[#FF77FF]/30 bg-[#FF77FF]/5 p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
                Map your buttons to these three keys
            </h2>
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left text-white/40">
                        <th className="pb-2 font-normal">Button</th>
                        <th className="pb-2 font-normal">Key</th>
                        <th className="pb-2 font-normal">What it does</th>
                    </tr>
                </thead>
                <tbody className="text-white/80">
                    <tr>
                        <td className="py-1">1 · yes</td>
                        <td className="py-1 font-mono text-[#FF77FF]">y</td>
                        <td className="py-1">answer yes to the item showing. The card says what that means.</td>
                    </tr>
                    <tr>
                        <td className="py-1">2 · no</td>
                        <td className="py-1 font-mono text-[#FF77FF]">n</td>
                        <td className="py-1">answer no to the item showing.</td>
                    </tr>
                    <tr>
                        <td className="py-1">3 · next</td>
                        <td className="py-1 font-mono text-[#FF77FF]">m</td>
                        <td className="py-1">cycle to the next item without answering. This is how you defer.</td>
                    </tr>
                </tbody>
            </table>
            <p className="mt-3 text-xs text-white/35">
                Send the bare character, no modifiers. Yes and no mean different things on different items, so the
                card always states the verb before you press. On a normal keyboard, Enter and the arrows work too.
            </p>
        </div>
    );
}

function KeyLegend({ phase }: { phase: 'review' | 'confirm' | 'empty' }) {
    return (
        <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">Keys right now</h2>
            <ul className="space-y-1 text-sm text-white/70">
                {legendFor(phase).map((b) => (
                    <li key={`${b.phase}-${b.action}-${b.keys[0]}`} className="flex gap-3">
                        <span className="min-w-[10rem] font-mono text-[#FF77FF]">{b.keys.map(keyLabel).join(' or ')}</span>
                        <span>{b.label}</span>
                    </li>
                ))}
            </ul>
            <p className="mt-3 text-xs text-white/35">
                Anything that writes somewhere else asks a second time, so one press can never commit.{' '}
                {KEY_BINDINGS.filter((b) => b.threeKey).length} of the bindings are on the three buttons.
            </p>
        </div>
    );
}

function keyLabel(key: string): string {
    if (key === 'ArrowDown') return '↓';
    if (key === 'ArrowUp') return '↑';
    if (key === 'ArrowLeft') return '←';
    if (key === 'ArrowRight') return '→';
    if (key === 'Escape') return 'Esc';
    return key;
}
