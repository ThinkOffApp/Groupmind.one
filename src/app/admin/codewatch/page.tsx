// SPDX-License-Identifier: AGPL-3.0-only
// CodeWatch / GroupMind dive-in: the full local dashboard (users + usage).
// Reached from the unified /admin overview; same shared password gate.

import { cookies } from 'next/headers';
import { ADMIN_COOKIE_NAME, verifyAdminCookie } from '@/lib/admin-auth';
import { getAdminStats, type AdminStats, type DailyCount } from '@/lib/admin-stats';
import { AdminHeader, LoginForm, StatTile, fmtDateTime } from '../ui';
import { Tabs } from '../Tabs';
import { EntityTabs } from '../EntityTabs';

export const dynamic = 'force-dynamic';

// Chart colors: repo accent tokens, validated for the dark surface
// (lightness band, chroma, contrast >= 3:1 vs #0A0A0A).
const SIGNUPS_COLOR = 'var(--accent-magenta)'; // #CC00CC
const MESSAGES_COLOR = 'var(--accent-green)'; // #55AA00

function fmtDay(isoDate: string): string {
    const d = new Date(`${isoDate}T00:00:00Z`);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function DailyBarChart({
    title,
    data,
    color,
}: {
    title: string;
    data: DailyCount[];
    color: string;
}) {
    const max = Math.max(1, ...data.map(d => d.count));
    const total = data.reduce((sum, d) => sum + d.count, 0);
    return (
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <div className="flex items-baseline justify-between gap-4 mb-4">
                <h3 className="text-sm font-medium text-gray-300">{title}</h3>
                <span className="text-xs text-gray-500 tabular-nums">
                    {total.toLocaleString('en-US')} total · peak {max.toLocaleString('en-US')}/day
                </span>
            </div>
            <div
                className="flex items-end gap-[2px] h-28 border-b border-white/10"
                role="img"
                aria-label={`${title}: daily counts for the last 30 days, total ${total}`}
            >
                {data.map(d => (
                    <div
                        key={d.date}
                        className="flex-1 h-full flex flex-col justify-end"
                        title={`${fmtDay(d.date)}: ${d.count.toLocaleString('en-US')}`}
                    >
                        <div
                            className="w-full rounded-t-[3px]"
                            style={{
                                background: color,
                                height: d.count === 0 ? '0' : `max(${(d.count / max) * 100}%, 3px)`,
                            }}
                        />
                    </div>
                ))}
            </div>
            <div className="flex justify-between text-[10px] text-gray-500 mt-2">
                <span>{data.length > 0 ? fmtDay(data[0].date) : ''}</span>
                <span>{data.length > 0 ? fmtDay(data[data.length - 1].date) : ''}</span>
            </div>
        </div>
    );
}

/** Rows of each section previewed on the dashboard tab. */
const SUMMARY_ROWS = 3;

/**
 * Landing tab: the totals, plus the head of every other tab.
 *
 * The owner asked: "the first tab should be a dash / summary of all the other tabs,
 * showing the most important info from each". Each block below mirrors one tab
 * and says plainly how much it is not showing, so the summary can never be
 * mistaken for the whole list.
 */
function SummaryTab({ stats }: { stats: AdminStats }) {
    const rooms = stats.topRooms.slice(0, SUMMARY_ROWS);
    const users = stats.recentUsers.slice(0, SUMMARY_ROWS);
    return (
        <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatTile label="Users" value={stats.totalUsers} />
                <StatTile label="Agents" value={stats.totalAgents} />
                <StatTile label="Rooms" value={stats.totalRooms} />
                <StatTile
                    label="Messages (30d)"
                    value={stats.messages30d}
                    hint={`${stats.messages7d.toLocaleString('en-US')} in last 7 days`}
                />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                    <h3 className="text-sm font-medium text-gray-300 mb-3">Busiest rooms (7d)</h3>
                    {rooms.length === 0 ? (
                        <p className="text-sm text-gray-500">No room messages in the last 7 days.</p>
                    ) : (
                        <table className="w-full text-sm">
                            <tbody>
                                {rooms.map(room => (
                                    <tr key={room.roomId} className="border-b border-white/5">
                                        <td className="py-1.5 pr-4 text-white">{room.name}</td>
                                        <td className="py-1.5 text-right text-white tabular-nums">
                                            {room.messages7d.toLocaleString('en-US')}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    {stats.topRooms.length > rooms.length && (
                        <p className="text-xs text-gray-500 mt-3">
                            and {stats.topRooms.length - rooms.length} more in the Rooms tab
                        </p>
                    )}
                </div>

                <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
                    <h3 className="text-sm font-medium text-gray-300 mb-3">Newest users</h3>
                    {users.length === 0 ? (
                        <p className="text-sm text-gray-500">No users yet.</p>
                    ) : (
                        <table className="w-full text-sm">
                            <tbody>
                                {users.map(user => (
                                    <tr key={user.id} className="border-b border-white/5">
                                        <td className="py-1.5 pr-4 text-white">
                                            {user.handle ? `@${user.handle}` : (user.email ?? '\u2014')}
                                        </td>
                                        <td className="py-1.5 text-right text-gray-400 tabular-nums whitespace-nowrap">
                                            {fmtDateTime(user.createdAt)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    {stats.recentUsers.length > users.length && (
                        <p className="text-xs text-gray-500 mt-3">
                            and {stats.recentUsers.length - users.length} more in the Users tab
                        </p>
                    )}
                </div>
            </div>

            {/* Entity totals are already a summary grid, so the dashboard shows
                the same component the Entities tab does rather than a reduction
                of it. */}
            <EntityTabs />
        </div>
    );
}

function Dashboard({ stats }: { stats: AdminStats }) {
    return (
        <div className="max-w-5xl mx-auto px-6 pb-16 space-y-8">
            <AdminHeader
                title="CodeWatch / GroupMind"
                subtitle={`Generated ${fmtDateTime(stats.generatedAt)} UTC`}
                backHref="/admin"
            />

            {/* Tabs rather than one long scroll. The owner asked for service selection
                first, then tabs. The tiles above stay put because they are the
                at-a-glance answer, not a section of their own. */}
            <Tabs
                storageKey="codewatch"
                tabs={[
                    {
                        id: 'dashboard',
                        label: 'Dashboard',
                        content: <SummaryTab stats={stats} />,
                    },
                    {
                        id: 'activity',
                        label: 'Activity',
                        content: (
                            <>
            {/* Daily charts */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <DailyBarChart
                    title="Signups per day (30d)"
                    data={stats.signupsPerDay}
                    color={SIGNUPS_COLOR}
                />
                <DailyBarChart
                    title="Messages per day (30d)"
                    data={stats.messagesPerDay}
                    color={MESSAGES_COLOR}
                />
            </div>
                            </>
                        ),
                    },
                    {
                        id: 'rooms',
                        label: 'Rooms',
                        badge: stats.topRooms.length || undefined,
                        content: (
                            <>
            {/* Top rooms */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                <div className="flex items-baseline justify-between gap-4 mb-4">
                    <h3 className="text-sm font-medium text-gray-300">
                        Most active rooms (messages, last 7 days)
                    </h3>
                    {stats.topRoomsSampleTruncated && (
                        <span className="text-xs text-yellow-400">
                            sampled from most recent 10k messages
                        </span>
                    )}
                </div>
                {stats.topRooms.length === 0 ? (
                    <p className="text-sm text-gray-500">No room messages in the last 7 days.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-gray-500 border-b border-white/10">
                                    <th className="py-2 pr-4 font-medium">#</th>
                                    <th className="py-2 pr-4 font-medium">Room</th>
                                    <th className="py-2 pr-4 font-medium">Slug</th>
                                    <th className="py-2 font-medium text-right">Messages</th>
                                </tr>
                            </thead>
                            <tbody>
                                {stats.topRooms.map((room, i) => (
                                    <tr key={room.roomId} className="border-b border-white/5">
                                        <td className="py-2 pr-4 text-gray-500 tabular-nums">{i + 1}</td>
                                        <td className="py-2 pr-4 text-white">{room.name}</td>
                                        <td className="py-2 pr-4 text-gray-400 font-mono text-xs">
                                            {room.slug}
                                        </td>
                                        <td className="py-2 text-right text-white tabular-nums">
                                            {room.messages7d.toLocaleString('en-US')}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
                            </>
                        ),
                    },
                    {
                        id: 'users',
                        label: 'Users',
                        badge: stats.recentUsers.length || undefined,
                        content: (
                            <>
            {/* Recent users (emails are masked at the data layer) */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                <h3 className="text-sm font-medium text-gray-300 mb-4">Recent users</h3>
                {stats.recentUsers.length === 0 ? (
                    <p className="text-sm text-gray-500">No users yet.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-gray-500 border-b border-white/10">
                                    <th className="py-2 pr-4 font-medium">Email</th>
                                    <th className="py-2 pr-4 font-medium">Handle</th>
                                    <th className="py-2 pr-4 font-medium">Signed up (UTC)</th>
                                    <th className="py-2 font-medium">Last sign-in (UTC)</th>
                                </tr>
                            </thead>
                            <tbody>
                                {stats.recentUsers.map(user => (
                                    <tr key={user.id} className="border-b border-white/5">
                                        <td className="py-2 pr-4 text-white">{user.email ?? '—'}</td>
                                        <td className="py-2 pr-4 text-gray-400">
                                            {user.handle ? `@${user.handle}` : '—'}
                                        </td>
                                        <td className="py-2 pr-4 text-gray-400 tabular-nums whitespace-nowrap">
                                            {fmtDateTime(user.createdAt)}
                                        </td>
                                        <td className="py-2 text-gray-400 tabular-nums whitespace-nowrap">
                                            {fmtDateTime(user.lastSignInAt)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
                            </>
                        ),
                    },
                    {
                        id: 'entities',
                        label: 'Entities',
                        content: <EntityTabs />,
                    },
                ]}
            />
        </div>
    );
}

export default async function CodeWatchAdminPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const [cookieStore, params] = await Promise.all([cookies(), searchParams]);
    const authed = verifyAdminCookie(cookieStore.get(ADMIN_COOKIE_NAME)?.value);

    if (!authed) {
        // Admin data is never fetched (let alone rendered) without a valid cookie.
        return <LoginForm error={params.error === '1'} next="/admin/codewatch" />;
    }

    let stats: AdminStats | null = null;
    try {
        stats = await getAdminStats();
    } catch (err) {
        console.error('[Admin] Failed to load stats:', err);
    }

    if (!stats) {
        return (
            <div className="max-w-md mx-auto px-6 py-24">
                <div className="bg-red-950/30 border border-red-500/30 rounded-2xl p-6 text-sm text-red-200">
                    Failed to load admin stats. Check server logs and Supabase configuration.
                </div>
            </div>
        );
    }

    return <Dashboard stats={stats} />;
}
