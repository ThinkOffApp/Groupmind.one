'use client';

import { useEffect, useState, type ReactNode } from 'react';

export interface TabSpec {
    /** Stable slug used in the URL hash. */
    id: string;
    label: string;
    /** Optional small number shown beside the label. */
    badge?: string | number;
    content: ReactNode;
}

/**
 * Tab strip for the admin pages.
 *
 * The owner's requirement, in their words: service selection first, then tabs, "not
 * a huge single scrolling page". The service selection already exists at
 * /admin; this supplies the second half so each service's detail is grouped
 * rather than stacked.
 *
 * `content` arrives as already-rendered server nodes, so every tab's data is
 * fetched once on the server and switching tabs costs no round trip. The cost
 * is that all tabs ship in the payload, which is the right trade for a handful
 * of small tables and keeps the page usable on a phone with a bad connection.
 *
 * The active tab is mirrored into the URL hash so a reload, a bookmark or the
 * back button lands where the user was rather than resetting to the first tab.
 */
export function Tabs({ tabs, storageKey }: { tabs: TabSpec[]; storageKey?: string }) {
    const [active, setActive] = useState(0);

    // Restore from the hash (shareable) or, failing that, the last tab this
    // browser used. Runs after mount so the server and client first paint
    // agree; picking a tab during render would be a hydration mismatch.
    useEffect(() => {
        const fromHash = window.location.hash.replace(/^#/, '');
        let idx = tabs.findIndex(t => t.id === fromHash);
        if (idx < 0 && storageKey) {
            try {
                const saved = window.localStorage.getItem(`admin-tab:${storageKey}`);
                if (saved) idx = tabs.findIndex(t => t.id === saved);
            } catch {
                // Private windows and blocked site data throw here. A forgotten
                // tab is not worth failing the page over.
            }
        }
        if (idx >= 0) setActive(idx);
        // Tab identities are fixed for a given page render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function select(idx: number) {
        setActive(idx);
        const id = tabs[idx]?.id;
        if (!id) return;
        try {
            window.history.replaceState(null, '', `#${id}`);
            if (storageKey) window.localStorage.setItem(`admin-tab:${storageKey}`, id);
        } catch {
            // Same rationale as above: navigation state is a convenience.
        }
    }

    if (tabs.length === 0) return null;
    const current = tabs[Math.min(active, tabs.length - 1)];

    return (
        <div>
            <div
                role="tablist"
                aria-label="Sections"
                className="flex gap-1 overflow-x-auto border-b border-white/10 -mx-6 px-6 md:mx-0 md:px-0"
            >
                {tabs.map((tab, i) => {
                    const selected = i === active;
                    return (
                        <button
                            key={tab.id}
                            role="tab"
                            id={`tab-${tab.id}`}
                            aria-selected={selected}
                            aria-controls={`panel-${tab.id}`}
                            onClick={() => select(i)}
                            className={
                                'whitespace-nowrap px-4 py-2.5 text-sm rounded-t-lg border-b-2 transition-colors ' +
                                (selected
                                    ? 'border-white text-white bg-white/5'
                                    : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-white/5')
                            }
                        >
                            {tab.label}
                            {tab.badge !== undefined && (
                                <span className="ml-2 text-xs text-gray-500 tabular-nums">
                                    {tab.badge}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            <div
                role="tabpanel"
                id={`panel-${current.id}`}
                aria-labelledby={`tab-${current.id}`}
                className="pt-6 space-y-6"
            >
                {current.content}
            </div>
        </div>
    );
}
