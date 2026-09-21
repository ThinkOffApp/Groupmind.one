/**
 * /dev/fleet - the real fleet dashboard, on fixtures, with no sign-in.
 *
 * The owner's point: "i think you should be screenshotting yourself to see and
 * fix UI issues". /intent needs a session on production AND on a local stack,
 * so nobody working on this repo could ever look at the page they were editing.
 * This route removes that: same component, same CSS, fixture data.
 *
 * NOT AVAILABLE IN PRODUCTION - `notFound()` before anything else runs, and the
 * fixture API behind it returns 404 on the same condition.
 *
 * Scenarios: ?scenario=measured | crowded | duplicates | empty
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { IntentDashboard } from '@/app/intent/IntentDashboard';
import { IS_DEV_ONLY_ENABLED } from '@/lib/dev-only';
import {
    DEFAULT_FLEET_FIXTURE_SCENARIO,
    FLEET_FIXTURE_SCENARIOS,
    fleetFixtureState,
    isFleetFixtureScenario,
} from '@/lib/fleet-fixtures';
import { buildFleetRoster } from '@/lib/fleet-roster';

export const dynamic = 'force-dynamic';

export default async function DevFleetPage({
    searchParams,
}: {
    searchParams: Promise<{ scenario?: string }>;
}) {
    if (!IS_DEV_ONLY_ENABLED) notFound();

    const { scenario: requested } = await searchParams;
    const scenario = isFleetFixtureScenario(requested) ? requested : DEFAULT_FLEET_FIXTURE_SCENARIO;

    // Raw fixture rows vs what the roster renders, printed next to each other so
    // a screenshot shows the counts fix working rather than only asserting it.
    const raw = fleetFixtureState(scenario);
    const roster = buildFleetRoster(raw);
    const folded = [
        `devices ${Object.keys(raw.devices).length}→${roster.devices.length} reporting`,
        `${raw.stale_devices.length}→${roster.offlineDevices.length} offline`,
        `agents ${Object.keys(raw.agents).length}→${roster.agents.length} reporting`,
        `${raw.stale_agents.length}→${roster.offlineAgents.length} offline`,
    ].join(' · ');

    return (
        <div className="max-w-[1600px] mx-auto py-6 px-4">
            <div className="mb-4 rounded-xl border border-[#FF9900]/30 bg-[#FF9900]/10 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="text-[#FF9900] text-sm font-semibold">Fixture fleet</span>
                    <span className="text-xs text-gray-400">
                        development only, no auth, no database
                    </span>
                    <div className="ml-auto flex flex-wrap gap-1.5">
                        {Object.keys(FLEET_FIXTURE_SCENARIOS).map((name) => (
                            <Link
                                key={name}
                                href={`/dev/fleet?scenario=${name}`}
                                className={`px-2.5 py-1 rounded-full border text-[11px] transition ${
                                    name === scenario
                                        ? 'border-[#99DD00]/50 bg-[#99DD00]/15 text-[#99DD00]'
                                        : 'border-white/15 text-gray-400 hover:text-white hover:border-white/30'
                                }`}
                            >
                                {name}
                            </Link>
                        ))}
                    </div>
                </div>
                <p className="mt-1.5 text-[11px] font-mono text-gray-400 tabular-nums">
                    raw fixture rows &rarr; rendered: {folded}
                </p>
            </div>

            <div className="flex items-center justify-between mb-4">
                <h1 className="text-xl font-bold text-white flex items-center gap-3">Fleet</h1>
            </div>

            <IntentDashboard userId={scenario} apiKey={null} baseUrl="/api/dev/fleet" />
        </div>
    );
}
