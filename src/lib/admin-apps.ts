// Registry of ThinkOff apps surfaced on the unified /admin overview.
//
// Adding a new app to the admin = ONE entry in ADMIN_APPS below. The overview
// renders a card per entry (headline numbers), and /admin/<id> renders the
// dive-in page. Local apps supply a loader function; remote apps supply env
// var names for their stats endpoint.
//
// ── REMOTE STATS JSON CONTRACT (v1) ─────────────────────────────────────────
// A remote app exposes ONE stats endpoint (server-to-server; never called
// from the browser). This dashboard performs:
//
//   GET <url from urlEnv>
//   X-Admin-Stats-Secret: <value of secretEnv>   (header sent when set)
//
// and expects a 200 response within 5s with JSON:
//
//   {
//     "headline": [                       // REQUIRED, 1..6 tiles
//       { "label": "Users", "value": 1234, "hint": "optional small print" }
//     ],
//     "sections": [                       // OPTIONAL, dive-in tables
//       { "title": "Signups", "rows": [["Today", 3], ["Last 7 days", 21]] }
//     ],
//     "generatedAt": "2026-07-13T12:00:00Z"  // OPTIONAL ISO timestamp
//   }
//
// "value" entries may be numbers or strings. "headline" is shown on the
// overview card and at the top of the dive-in page; each "sections" entry
// becomes a label/value table on the dive-in page. Any non-200, timeout, or
// malformed payload renders gracefully as an awaiting/unavailable state.
// The endpoint MUST verify the X-Admin-Stats-Secret header and MUST NOT
// include PII (emails, names) in labels or values.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { getGroupMindHeadline } from './admin-stats';

export interface HeadlineStat {
    label: string;
    value: string | number;
    hint?: string;
}

export interface StatsSection {
    title: string;
    rows: [string, string | number][];
}

export interface AppStats {
    headline: HeadlineStat[];
    sections?: StatsSection[];
    generatedAt?: string;
}

export type AppStatsResult =
    | { status: 'ok'; stats: AppStats }
    /** Remote endpoint not configured yet (env var unset). */
    | { status: 'awaiting'; detail: string }
    /** Configured but unreachable / errored / malformed. */
    | { status: 'error'; detail: string };

export interface AdminApp {
    /** URL segment: the dive-in page lives at /admin/<id>. */
    id: string;
    name: string;
    description: string;
    statsSource:
        | { kind: 'local'; load: () => Promise<AppStats> }
        | { kind: 'remote'; urlEnv: string; secretEnv: string };
}

export const ADMIN_APPS: AdminApp[] = [
    {
        id: 'codewatch',
        name: 'CodeWatch / GroupMind',
        description: 'Rooms, agents and messaging platform (this deployment).',
        statsSource: { kind: 'local', load: getGroupMindHeadline },
    },
    {
        id: 'thinkoff',
        name: 'ThinkOff App',
        description: 'ThinkOff concierge and mobile app.',
        statsSource: {
            kind: 'remote',
            urlEnv: 'THINKOFF_STATS_URL',
            secretEnv: 'THINKOFF_STATS_SECRET',
        },
    },
];

export function getAdminApp(id: string): AdminApp | undefined {
    return ADMIN_APPS.find(app => app.id === id);
}

const MAX_HEADLINE_TILES = 6;
const MAX_SECTIONS = 12;
const MAX_ROWS_PER_SECTION = 50;
const REMOTE_TIMEOUT_MS = 5000;

function asStatValue(v: unknown): string | number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') return v.slice(0, 200);
    return null;
}

/** Validate + clamp an untrusted remote payload into the AppStats contract. */
function normalizeStats(raw: unknown): AppStats | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;

    if (!Array.isArray(obj.headline)) return null;
    const headline: HeadlineStat[] = [];
    for (const item of obj.headline.slice(0, MAX_HEADLINE_TILES)) {
        if (typeof item !== 'object' || item === null) return null;
        const tile = item as Record<string, unknown>;
        const value = asStatValue(tile.value);
        if (typeof tile.label !== 'string' || value === null) return null;
        headline.push({
            label: tile.label.slice(0, 80),
            value,
            ...(typeof tile.hint === 'string' ? { hint: tile.hint.slice(0, 120) } : {}),
        });
    }
    if (headline.length === 0) return null;

    const sections: StatsSection[] = [];
    if (Array.isArray(obj.sections)) {
        for (const item of obj.sections.slice(0, MAX_SECTIONS)) {
            if (typeof item !== 'object' || item === null) continue;
            const sec = item as Record<string, unknown>;
            if (typeof sec.title !== 'string' || !Array.isArray(sec.rows)) continue;
            const rows: [string, string | number][] = [];
            for (const row of sec.rows.slice(0, MAX_ROWS_PER_SECTION)) {
                if (!Array.isArray(row) || row.length !== 2) continue;
                const value = asStatValue(row[1]);
                if (typeof row[0] !== 'string' || value === null) continue;
                rows.push([row[0].slice(0, 120), value]);
            }
            sections.push({ title: sec.title.slice(0, 120), rows });
        }
    }

    return {
        headline,
        ...(sections.length > 0 ? { sections } : {}),
        ...(typeof obj.generatedAt === 'string'
            ? { generatedAt: obj.generatedAt.slice(0, 40) }
            : {}),
    };
}

/**
 * Load stats for one app. Never throws — remote/config problems come back as
 * 'awaiting'/'error' results so the overview always renders every card.
 */
export async function getAppStats(app: AdminApp): Promise<AppStatsResult> {
    if (app.statsSource.kind === 'local') {
        try {
            return { status: 'ok', stats: await app.statsSource.load() };
        } catch (err) {
            console.error(`[Admin] Failed to load local stats for ${app.id}:`, err);
            return { status: 'error', detail: 'Failed to load stats. Check server logs.' };
        }
    }

    const { urlEnv, secretEnv } = app.statsSource;
    const url = process.env[urlEnv]?.trim();
    if (!url) {
        return {
            status: 'awaiting',
            detail: `Awaiting stats endpoint. Set ${urlEnv} (and ${secretEnv}) to enable.`,
        };
    }

    const secret = process.env[secretEnv]?.trim();
    try {
        const res = await fetch(url, {
            headers: secret ? { 'X-Admin-Stats-Secret': secret } : undefined,
            cache: 'no-store',
            signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
        });
        if (!res.ok) {
            return { status: 'error', detail: `Stats endpoint returned HTTP ${res.status}.` };
        }
        const stats = normalizeStats(await res.json());
        if (!stats) {
            return {
                status: 'error',
                detail: 'Stats endpoint returned a payload outside the v1 contract.',
            };
        }
        return { status: 'ok', stats };
    } catch (err) {
        console.error(`[Admin] Stats endpoint unreachable for ${app.id}:`, err);
        return { status: 'error', detail: 'Stats endpoint unreachable.' };
    }
}
