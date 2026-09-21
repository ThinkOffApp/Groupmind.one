/**
 * Fixture fleets for the dev-only /dev/fleet route.
 *
 * WHY THIS EXISTS. /intent requires a signed-in session on production and on a
 * local stack, so no agent working on this repo has ever LOOKED at the fleet
 * dashboard - only at the JSON the API returns. A 2 GB placeholder model name
 * shipped as the first thing the owner saw because reading the JSX is not the
 * same as seeing the render.
 *
 * These fixtures deliberately lead with the UGLY cases, because the happy path
 * is not what breaks a layout: a 60+ character model name, a box at 95%
 * memory, a dozen offline chips, an agent publishing no model at all, a device
 * whose last heartbeat is months old, and the claudeMB/claudemb case-duplicate
 * from the counts fix so its effect is visible rather than only asserted.
 *
 * Timestamps are computed relative to now, so a fixture never quietly rots into
 * "reporting, 4 months ago".
 */

export type FixtureSlot = Record<string, unknown> & { updated_at: string; ttl_sec: number };

export type FixtureState = {
    schema_version: number;
    user_id: string;
    devices: Record<string, FixtureSlot>;
    agents: Record<string, FixtureSlot>;
    stale_devices: string[];
    stale_agents: string[];
    derived: {
        urgency_mode: string;
        available_modalities: string[];
        preferred_device: string | null;
        suppress_audio: boolean;
        overall_state: string;
        reachability_mode: string;
        computed_at: string;
    };
};

const MINUTE = 60_000;

function ago(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
}

/** A model path long enough to test truncation rather than confirm it is short. */
const LONG_MODEL_NAME =
    '/models/unsloth/Qwen3-Coder-480B-A35B-Instruct-GGUF/Qwen3-Coder-480B-A35B-Instruct-UD-Q3_K_XL-00001-of-00005.gguf';

function device(id: string, over: Partial<FixtureSlot> = {}): [string, FixtureSlot] {
    return [
        id,
        {
            name: id,
            updated_at: ago(20_000),
            ttl_sec: 90,
            source_device: id,
            load_pct: 22,
            mem_total_gb: 64,
            mem_available_gb: 41,
            temp_c: 48,
            host: { machine: id },
            ...over,
        } as FixtureSlot,
    ];
}

function agent(id: string, over: Partial<FixtureSlot> = {}): [string, FixtureSlot] {
    return [
        id,
        {
            name: id,
            updated_at: ago(2 * MINUTE),
            ttl_sec: 300,
            source_device: id,
            status: 'active',
            host: { machine: id, load_pct: 14, mem_total_gb: 32, mem_available_gb: 19 },
            ...over,
        } as FixtureSlot,
    ];
}

function derived(over: Partial<FixtureState['derived']> = {}): FixtureState['derived'] {
    return {
        urgency_mode: 'normal',
        available_modalities: ['read', 'listen', 'speak'],
        preferred_device: 'mb',
        suppress_audio: false,
        overall_state: 'working',
        reachability_mode: 'desktop',
        computed_at: new Date().toISOString(),
        ...over,
    };
}

/**
 * The fleet as the live API actually returned it on 2026-09-20, duplicates and
 * placeholders included, so the roster fix is demonstrated rather than assumed:
 * 7 raw reporting agents fold to 6 cards, 9 raw offline ids fold to 7 chips.
 */
function measured(): FixtureState {
    return {
        schema_version: 1,
        user_id: 'fixture',
        devices: Object.fromEntries([
            device('asus1', { load_pct: 71, temp_c: 74, watts_w: 310, mem_total_gb: 128, mem_available_gb: 44 }),
            device('asus2', { load_pct: 64, temp_c: 69, watts_w: 298, mem_total_gb: 128, mem_available_gb: 51 }),
            device('m5', { load_pct: 12, temp_c: 41, mem_total_gb: 128, mem_available_gb: 106, model: LONG_MODEL_NAME }),
            device('mb', { load_pct: 34, temp_c: 58, active_app: 'Terminal', context: 'working', lan_ip: '192.168.1.24' }),
            device('mini', { load_pct: 8, temp_c: 44, mem_total_gb: 64, mem_available_gb: 58 }),
            device('vadelma', { load_pct: 3, temp_c: 39, mem_total_gb: 8, mem_available_gb: 6 }),
        ]),
        agents: Object.fromEntries([
            // ONE agent, two capitalisations: POST /api/v1/messages writes the
            // DB handle's casing, the uik-daemon writes INTENT_AGENT_HANDLE's.
            agent('claudeMB', { updated_at: ago(30_000), status: 'active', task: 'fleet counts' }),
            agent('claudemb', { updated_at: ago(4 * MINUTE), status: 'idle' }),
            agent('claudemm', { task: 'web lane' }),
            agent('codexmb', { task: 'PR review' }),
            agent('eclass'),
            agent('hermes'),
            agent('qwenm5'),
        ]),
        stale_devices: ['clawwatch', 'macbook', 'macmini', 'phone-noteair5c', 'phone-sm-f976b', 'vta439'],
        // `agent` is the daemon fallback handle, `zz-probe-nonexistent` a test
        // probe; `petrus` is a human and is deliberately NOT special-cased.
        stale_agents: ['agent', 'antigravity', 'deepseek', 'gle', 'grok', 'kimi3', 'petrus', 'vta', 'zz-probe-nonexistent'],
        derived: derived(),
    };
}

/** Everything that has ever made this layout look wrong, on one screen. */
function crowded(): FixtureState {
    const base = measured();
    return {
        ...base,
        devices: Object.fromEntries([
            ...Object.entries(base.devices),
            // A box at 95% memory: the meter must read as alarming, not full-and-fine.
            device('gpu-server-01', {
                load_pct: 98,
                temp_c: 91,
                temp_limit_c: 104.8,
                watts_w: 642,
                mem_total_gb: 512,
                mem_available_gb: 25.6,
                model: LONG_MODEL_NAME,
                active_app: 'llama-server',
                context: 'serving',
            }),
            // A last-seen months in the past, still inside its own (absurd) TTL.
            device('attic-pi', {
                updated_at: ago(140 * 24 * 60 * MINUTE),
                ttl_sec: 60 * 60 * 24 * 365,
                load_pct: 1,
                temp_c: 31,
                mem_total_gb: 4,
                mem_available_gb: 3.6,
            }),
            device('phone-sm-f976b', {
                updated_at: ago(45_000),
                load_pct: 17,
                temp_c: 36,
                mem_total_gb: 12,
                mem_available_gb: 3.1,
                context: 'transit',
            }),
        ]),
        agents: Object.fromEntries([
            ...Object.entries(base.agents),
            // No model, no host vitals: the card must not collapse or show NaN.
            agent('bare-agent', { host: undefined, status: undefined, name: undefined }),
            agent('a-very-long-agent-handle-that-nobody-would-choose-but-someone-did'),
            agent('kimi3', { updated_at: ago(60_000) }),
        ]),
        // ~12 offline chips, to see how the row wraps.
        stale_devices: [
            'clawwatch', 'macbook', 'macmini', 'phone-noteair5c', 'vta439',
            'garage-pi', 'berlin-spark-a', 'berlin-spark-b', 'old-imac',
            'kitchen-display', 'car-head-unit', 'test-rig-07',
        ],
        stale_agents: [
            'agent', 'antigravity', 'deepseek', 'gle', 'grok', 'petrus', 'vta',
            'zz-probe-nonexistent', 'zz-probe-two',
            // Negative control, visible on screen: real ids that merely look
            // like placeholders and must still be listed.
            'agentic', 'zzprobe', 'probe-runner',
        ],
        derived: derived({ urgency_mode: 'text-only', suppress_audio: true, available_modalities: ['read'] }),
    };
}

/** Only the case-duplicate, so the counts fix can be read at a glance. */
function duplicates(): FixtureState {
    const base = measured();
    return {
        ...base,
        devices: Object.fromEntries([device('mb'), device('mini')]),
        agents: Object.fromEntries([
            agent('claudeMB', { updated_at: ago(30_000), status: 'active', task: 'the fresher row' }),
            agent('claudemb', { updated_at: ago(9 * MINUTE), status: 'idle', task: 'the staler row' }),
            agent('CLAUDEMM', { updated_at: ago(8 * MINUTE), status: 'idle' }),
            agent('claudemm', { updated_at: ago(40_000), status: 'active' }),
        ]),
        stale_devices: [],
        stale_agents: ['claudemb', 'agent', 'zz-probe-nonexistent', 'agentic'],
        derived: derived({ preferred_device: 'mb' }),
    };
}

/** Nothing at all, which draws the Getting Started panel. */
function empty(): FixtureState {
    return {
        schema_version: 1,
        user_id: 'fixture',
        devices: {},
        agents: {},
        stale_devices: [],
        stale_agents: [],
        derived: derived({ overall_state: 'resting', reachability_mode: 'available', preferred_device: null }),
    };
}

export const FLEET_FIXTURE_SCENARIOS = {
    measured,
    crowded,
    duplicates,
    empty,
} satisfies Record<string, () => FixtureState>;

export type FleetFixtureScenario = keyof typeof FLEET_FIXTURE_SCENARIOS;

export const DEFAULT_FLEET_FIXTURE_SCENARIO: FleetFixtureScenario = 'measured';

export function isFleetFixtureScenario(value: unknown): value is FleetFixtureScenario {
    return typeof value === 'string' && value in FLEET_FIXTURE_SCENARIOS;
}

export function fleetFixtureState(scenario: string | undefined): FixtureState {
    const key = isFleetFixtureScenario(scenario) ? scenario : DEFAULT_FLEET_FIXTURE_SCENARIO;
    return FLEET_FIXTURE_SCENARIOS[key]();
}

/** A profile, so the dashboard's profile panel renders too. */
export function fleetFixtureProfile(scenario: string | undefined) {
    if (scenario === 'empty') {
        return {
            schema_version: 1,
            user_id: 'fixture',
            personal: {},
            preferences: {},
            agent_prefs: {},
            updated_at: new Date().toISOString(),
        };
    }
    return {
        schema_version: 1,
        user_id: 'fixture',
        personal: { name: 'Fixture User', home: 'Helsinki' },
        preferences: { response_style: 'concise', units: 'metric' },
        agent_prefs: { quiet_hours: { start: '23:00', end: '07:00', timezone: 'Europe/Helsinki' } },
        updated_at: new Date().toISOString(),
    };
}

/** Sparkline history for the cards that show one. */
export function fleetFixtureHistory(scenario: string | undefined) {
    const state = fleetFixtureState(scenario);
    const series: Record<string, Array<Record<string, unknown>>> = {};
    const ids: Array<[string, string]> = [
        ...Object.keys(state.devices).map((id) => ['device', id] as [string, string]),
        ...Object.keys(state.agents).map((id) => ['agent', id] as [string, string]),
    ];
    for (const [type, id] of ids) {
        const points: Array<Record<string, unknown>> = [];
        for (let i = 11; i >= 0; i--) {
            // Deterministic wobble, so two screenshots of one scenario match.
            const seed = (id.charCodeAt(0) + i * 7) % 40;
            points.push({
                at: ago(i * 5 * MINUTE),
                load_pct: 20 + seed,
                mem_pct: 30 + ((seed * 3) % 50),
            });
        }
        series[`${type}:${id}`] = points;
    }
    return { schema_version: 1, user_id: 'fixture', hours: 24, series };
}
