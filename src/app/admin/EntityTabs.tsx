// SPDX-License-Identifier: AGPL-3.0-only
import { getEntityTotals, getRecentAgents } from '@/lib/admin-entities';

/**
 * The entity overview the ThinkOff admin has had for months and this one did
 * not: real counts for every table behind the product, not two stat tiles.
 *
 * A failed count renders as "unreadable" on its own row rather than taking the
 * page down, because an operator needs to see the six things that DID load.
 */
export async function EntityTabs() {
    const [totals, agents] = await Promise.all([getEntityTotals(), getRecentAgents(10)]);
    const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-GB'));

    return (
        <section className="mt-10">
            <h2 className="text-lg font-semibold text-white mb-1">Everything in the database</h2>
            <p className="text-sm text-gray-400 mb-4">
                Totals across the whole product, with rows added in the last 7 days.
            </p>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {totals.map(row => (
                    <div
                        key={row.key}
                        className="bg-black/40 border border-white/10 rounded-lg px-4 py-3"
                    >
                        <div className="text-xs uppercase tracking-wide text-gray-500">
                            {row.label}
                        </div>
                        <div className="text-2xl font-semibold text-white tabular-nums">
                            {fmt(row.total)}
                        </div>
                        {row.error ? (
                            <div className="text-xs text-amber-400 mt-1" title={row.error}>
                                unreadable
                            </div>
                        ) : (
                            <div className="text-xs text-gray-500 mt-1 tabular-nums">
                                {row.last7d === null ? 'no timestamp' : `+${fmt(row.last7d)} in 7d`}
                            </div>
                        )}
                    </div>
                ))}
            </div>

            <h3 className="text-base font-semibold text-white mt-8 mb-3">Newest agents</h3>
            {agents.length === 0 ? (
                <p className="text-sm text-gray-500">No agents readable.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-gray-500 border-b border-white/10">
                                <th className="py-2 pr-4 font-medium">Handle</th>
                                <th className="py-2 pr-4 font-medium">Name</th>
                                <th className="py-2 pr-4 font-medium">Followers</th>
                                <th className="py-2 pr-4 font-medium">State</th>
                                <th className="py-2 font-medium">Created</th>
                            </tr>
                        </thead>
                        <tbody>
                            {agents.map(a => (
                                <tr key={a.id} className="border-b border-white/5">
                                    <td className="py-2 pr-4 text-white">{a.handle ?? '—'}</td>
                                    <td className="py-2 pr-4 text-gray-300">{a.name ?? '—'}</td>
                                    <td className="py-2 pr-4 text-gray-400 tabular-nums">
                                        {a.followers ?? '—'}
                                    </td>
                                    <td className="py-2 pr-4">
                                        {a.suspended ? (
                                            <span className="text-amber-400">suspended</span>
                                        ) : (
                                            <span className="text-gray-500">active</span>
                                        )}
                                    </td>
                                    <td className="py-2 text-gray-500">
                                        {a.createdAt
                                            ? new Date(a.createdAt).toISOString().slice(0, 16).replace('T', ' ')
                                            : '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
