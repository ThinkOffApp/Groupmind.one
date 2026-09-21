// Generic dive-in page for registry apps without a bespoke dashboard
// (remote-sourced apps). Renders whatever headline tiles and sections the
// app's stats endpoint returns — see the JSON contract in src/lib/admin-apps.ts.
// Static segments (e.g. /admin/codewatch) take precedence over this route.

import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ADMIN_COOKIE_NAME, verifyAdminCookie } from '@/lib/admin-auth';
import {
    getAdminApp,
    getAppStats,
    type HeadlineStat,
    type StatsSection,
} from '@/lib/admin-apps';
import { AdminHeader, LoginForm, StatTile, fmtDateTime, fmtStatValue } from '../ui';
import { Tabs, type TabSpec } from '../Tabs';

export const dynamic = 'force-dynamic';

/** How many rows of each section the dashboard previews before saying "and N more". */
const SUMMARY_ROWS = 4;

/**
 * The landing tab: headline tiles plus the top of every other tab.
 *
 * It deliberately shows the FIRST rows of each section rather than trying to
 * pick interesting ones. The service decides its own ordering, and a dashboard
 * that silently reorders its source is a dashboard that can hide the row that
 * mattered.
 */
function SummaryTab({
    headline,
    sections,
}: {
    headline: HeadlineStat[];
    sections: StatsSection[];
}) {
    return (
        <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {headline.map(stat => (
                    <StatTile key={stat.label} label={stat.label} value={stat.value} hint={stat.hint} />
                ))}
            </div>

            {sections.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {sections.map(section => {
                        const shown = section.rows.slice(0, SUMMARY_ROWS);
                        const rest = section.rows.length - shown.length;
                        return (
                            <div
                                key={section.title}
                                className="bg-white/5 border border-white/10 rounded-2xl p-5"
                            >
                                <h3 className="text-sm font-medium text-gray-300 mb-3">
                                    {section.title}
                                </h3>
                                {shown.length === 0 ? (
                                    <p className="text-sm text-gray-500">No data.</p>
                                ) : (
                                    <table className="w-full text-sm table-fixed">
                                        <tbody>
                                            {shown.map(([label, value], i) => (
                                                <tr key={`${label}-${i}`} className="border-b border-white/5">
                                                    <td className="py-1.5 pr-4 text-gray-400 align-top w-2/5 break-words">
                                                        {label}
                                                    </td>
                                                    <td
                                                        className={
                                                            'py-1.5 text-right text-white align-top break-words ' +
                                                            (isNumericish(value) ? 'tabular-nums' : '')
                                                        }
                                                    >
                                                        {fmtStatValue(value)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                                {rest > 0 && (
                                    <p className="text-xs text-gray-500 mt-3">
                                        and {rest} more in the {section.title} tab
                                    </p>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/**
 * Tabular figures line numbers up in a column, but the same font feature widens
 * the hyphen, so a model id renders as "claude - opus - 5". Apply it only to
 * values that are actually numeric (allowing a currency prefix or a % suffix).
 */
function isNumericish(value: string | number): boolean {
    if (typeof value === 'number') return true;
    return /^[\s$€£+-]*[\d][\d.,\s/]*%?$/.test(value);
}

/** Section titles come from the remote service, so the hash slug is derived, not trusted. */
function slugify(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
}

function SectionTable({ section }: { section: StatsSection }) {
    return (
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            {/* No heading here: the tab label already names the section. */}
            {section.rows.length === 0 ? (
                <p className="text-sm text-gray-500">No data.</p>
            ) : (
                <div className="overflow-x-auto">
                    {/* table-fixed with an explicit split: without it a long
                        status string (a provider's failure reason) pushes the
                        value column off the card on a phone, and a hyphenated
                        model id wraps one character per line. */}
                    <table className="w-full text-sm table-fixed">
                        <tbody>
                            {section.rows.map(([label, value], i) => (
                                <tr key={`${label}-${i}`} className="border-b border-white/5">
                                    <td className="py-2 pr-4 text-gray-400 align-top w-2/5 break-words">
                                        {label}
                                    </td>
                                    <td
                                        className={
                                            'py-2 text-right text-white align-top break-words ' +
                                            (isNumericish(value) ? 'tabular-nums' : '')
                                        }
                                    >
                                        {fmtStatValue(value)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

export default async function AdminAppPage({
    params,
    searchParams,
}: {
    params: Promise<{ app: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const [{ app: appId }, sp, cookieStore] = await Promise.all([
        params,
        searchParams,
        cookies(),
    ]);

    const app = getAdminApp(appId);
    if (!app) notFound();

    const authed = verifyAdminCookie(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
    if (!authed) {
        // Admin data is never fetched (let alone rendered) without a valid cookie.
        return <LoginForm error={sp.error === '1'} next={`/admin/${app.id}`} />;
    }

    const result = await getAppStats(app);

    return (
        <div className="max-w-5xl mx-auto px-6 pb-16 space-y-8">
            <AdminHeader
                title={app.name}
                subtitle={
                    result.status === 'ok' && result.stats.generatedAt
                        ? `Generated ${fmtDateTime(result.stats.generatedAt)} UTC`
                        : app.description
                }
                backHref="/admin"
            />

            {result.status !== 'ok' ? (
                <div className="bg-white/5 border border-dashed border-white/10 rounded-2xl p-8 text-center">
                    <p className="text-gray-400">
                        {result.status === 'awaiting'
                            ? 'Awaiting stats endpoint'
                            : 'Stats unavailable'}
                    </p>
                    <p className="text-sm text-gray-500 mt-2">{result.detail}</p>
                </div>
            ) : (
                <>
                    {/* First tab is a dashboard summarising every other tab,
                        then one tab per section. The owner asked: "the first tab should be
                        a dash / summary of all the other tabs, showing the most
                        important info from each". Sections arrive already ordered
                        by the service, so "most important" is its first rows. */}
                    <Tabs
                        storageKey={app.id}
                        tabs={[
                            {
                                id: 'dashboard',
                                label: 'Dashboard',
                                content: (
                                    <SummaryTab
                                        headline={result.stats.headline}
                                        sections={result.stats.sections ?? []}
                                    />
                                ),
                            },
                            ...(result.stats.sections ?? []).map<TabSpec>(section => ({
                                id: slugify(section.title),
                                label: section.title,
                                badge: section.rows.length || undefined,
                                content: <SectionTable section={section} />,
                            })),
                        ]}
                    />
                </>
            )}
        </div>
    );
}
