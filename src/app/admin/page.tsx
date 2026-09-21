// SPDX-License-Identifier: AGPL-3.0-only
// Unified ThinkOff admin — overview of every app with headline numbers.
// Apps are declared in src/lib/admin-apps.ts; click a card to dive in at
// /admin/<id>. All pages share one password gate (cookie path /admin).

import Link from 'next/link';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE_NAME, verifyAdminCookie } from '@/lib/admin-auth';
import {
    ADMIN_APPS,
    getAppStats,
    type AdminApp,
    type AppStatsResult,
} from '@/lib/admin-apps';
import { AdminHeader, LoginForm, fmtDateTime, fmtStatValue } from './ui';

export const dynamic = 'force-dynamic';

function AppCard({ app, result }: { app: AdminApp; result: AppStatsResult }) {
    return (
        <Link
            href={`/admin/${app.id}`}
            className="block bg-white/5 border border-white/10 rounded-2xl p-6 hover:border-[var(--primary)]/50 hover:bg-white/[0.07] transition-colors"
        >
            <div className="flex items-baseline justify-between gap-4">
                <h2 className="text-lg font-semibold text-white">{app.name}</h2>
                <span className="text-xs text-gray-500">
                    {result.status === 'ok' && result.stats.generatedAt
                        ? `${fmtDateTime(result.stats.generatedAt)} UTC`
                        : ''}
                </span>
            </div>
            <p className="text-sm text-gray-400 mt-1">{app.description}</p>

            {result.status === 'ok' ? (
                <div className="grid grid-cols-2 gap-3 mt-4">
                    {result.stats.headline.map(stat => (
                        <div key={stat.label} className="bg-black/30 rounded-xl p-3">
                            <div className="text-xs text-gray-500">{stat.label}</div>
                            <div className="text-xl font-semibold text-white tabular-nums">
                                {fmtStatValue(stat.value)}
                            </div>
                            {stat.hint && (
                                <div className="text-[10px] text-gray-600 mt-0.5">{stat.hint}</div>
                            )}
                        </div>
                    ))}
                </div>
            ) : (
                <div className="mt-4 bg-black/30 border border-dashed border-white/10 rounded-xl p-4 text-sm text-gray-500">
                    {result.status === 'awaiting' ? 'Awaiting stats endpoint' : 'Stats unavailable'}
                    <div className="text-xs text-gray-600 mt-1">{result.detail}</div>
                </div>
            )}
        </Link>
    );
}

export default async function AdminOverviewPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const [cookieStore, params] = await Promise.all([cookies(), searchParams]);
    const authed = verifyAdminCookie(cookieStore.get(ADMIN_COOKIE_NAME)?.value);

    if (!authed) {
        // Admin data is never fetched (let alone rendered) without a valid cookie.
        return <LoginForm error={params.error === '1'} next="/admin" />;
    }

    const cards = await Promise.all(
        ADMIN_APPS.map(async app => ({ app, result: await getAppStats(app) }))
    );

    return (
        <div className="max-w-5xl mx-auto px-6 pb-16 space-y-8">
            <AdminHeader
                title="ThinkOff admin"
                subtitle="All apps at a glance — click a card to dive in."
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {cards.map(({ app, result }) => (
                    <AppCard key={app.id} app={app} result={result} />
                ))}
            </div>
        </div>
    );
}
