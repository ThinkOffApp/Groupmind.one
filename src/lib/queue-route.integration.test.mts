// Route-level test: real HTTP Requests through the real route handlers, with
// the session, GitHub and the approvals store stubbed. Run:
//   npx tsx --experimental-test-module-mocks src/lib/queue-route.integration.test.mts
//
// Exists because the helper tests cannot show that the ROUTES wire the guards
// up - that /queue/decide actually refuses a body with no fingerprint, that it
// actually forwards the one it is given as GitHub's `sha`, that leaving a pull
// request alone never becomes a GitHub call, and that the access token is in
// nothing the browser can see.
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const R = (p: string) => pathToFileURL(`${process.cwd()}/${p}`).href;

// Console capture is installed for the WHOLE run, so anything a route logs is
// caught. This test's own output goes to the real console directly.
const out = console.log.bind(console);

let passed = 0;
let failed = 0;
function assert(c: boolean, n: string) {
    if (c) {
        out(`  ✅ ${n}`);
        passed++;
    } else {
        out(`  ❌ ${n}`);
        failed++;
    }
}

// A token shaped like a real one, so a grep for it would find a real one too.
const SENTINEL = 'ghu_SENTINEL0123456789abcdefghijklmnopqrstuv';
const SHA_SHOWN = '1111111111111111111111111111111111111111';
const USER = 'user-uuid-1';
const STAMP = '2026-09-20T10:00:00Z';

process.env.GITHUB_DEVICE_CLIENT_ID = 'Iv23liTESTCLIENTID';

// ── Stubs ───────────────────────────────────────────────────────────────

let session: { ok: boolean; reason?: string } = { ok: true };
let signedIn = true;

mock.module(R('src/lib/github-session.ts'), {
    namedExports: {
        getGithubSession: async () =>
            session.ok ? { ok: true, userId: USER, token: SENTINEL } : { ok: false, reason: session.reason },
        githubConnectionStatus: async () => ({ signedIn, connected: session.ok }),
        sessionUserId: async () => (signedIn ? USER : null),
        setGithubToken: async () => undefined,
        clearGithubToken: async () => undefined,
        setDeviceCode: async () => undefined,
        readDeviceCode: async () => 'dev-code-123',
        clearDeviceCode: async () => undefined,
    },
});

let pending: any[] = [];
let decideCalls: any[] = [];
let decideResult: any = { ok: true, status: 'approved' };
mock.module(R('src/lib/approvals.ts'), {
    namedExports: {
        listPendingApprovals: async () => pending,
        decideApproval: async (...args: any[]) => {
            decideCalls.push(args);
            return decideResult;
        },
    },
});

interface Outbound { url: string; method: string; headers: Record<string, string>; body: string }
let outbound: Outbound[] = [];
let routes: Array<[RegExp, { status?: number; json?: unknown }]> = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init: any) => {
    outbound.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ''),
    });
    for (const [re, reply] of routes) {
        if (re.test(String(url))) {
            return new Response(JSON.stringify(reply.json ?? {}), {
                status: reply.status ?? 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
}) as unknown as typeof fetch;

const logLines: string[] = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
function captureConsole() {
    for (const k of Object.keys(realConsole) as Array<keyof typeof realConsole>) {
        (console as any)[k] = (...args: unknown[]) => {
            logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        };
    }
}
function releaseConsole() {
    for (const k of Object.keys(realConsole) as Array<keyof typeof realConsole>) (console as any)[k] = realConsole[k];
}
captureConsole();

const { GET: queueGET } = await import(R('src/app/api/v1/queue/route.ts'));
const { POST: decidePOST } = await import(R('src/app/api/v1/queue/decide/route.ts'));
const { GET: sessionGET } = await import(R('src/app/api/v1/github/session/route.ts'));
const { POST: pollPOST } = await import(R('src/app/api/v1/github/device/poll/route.ts'));

/** Every response body and header seen in this run, for the leak grep. */
const clientVisible: string[] = [];

async function read(res: Response): Promise<{ status: number; body: any }> {
    const text = await res.text();
    clientVisible.push(text);
    res.headers.forEach((v, k) => clientVisible.push(`${k}: ${v}`));
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body };
}

const decideRequest = (payload: unknown) =>
    new Request('https://groupmind.one/api/v1/queue/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

const PR_ROUTES: Array<[RegExp, { status?: number; json?: unknown }]> = [
    [/\/user\/repos/, { json: [{ name: 'r', owner: { login: 'o' }, pushed_at: '2026-09-10T00:00:00Z', open_issues_count: 1 }] }],
    [/\/repos\/o\/r\/pulls\?/, { json: [{ number: 7, title: 'Seven', user: { login: 'a' }, head: { sha: SHA_SHOWN, ref: 'b' }, updated_at: '2026-09-19T00:00:00Z' }] }],
    [/\/repos\/o\/r\/pulls\/7$/, { json: { mergeable: true, mergeable_state: 'clean', head: { sha: SHA_SHOWN } } }],
];

function reset() {
    outbound = [];
    routes = [];
    decideCalls = [];
    decideResult = { ok: true, status: 'approved' };
    session = { ok: true };
    signedIn = true;
    pending = [];
}

// ── The queue ───────────────────────────────────────────────────────────

out('\nGET /api/v1/queue - one queue of everything');
{
    reset();
    routes = PR_ROUTES;
    pending = [{ intent_id: 'intent-1', target_summary: 'Restart the Pi', actor: '@claudemm', created_at: STAMP, updated_at: STAMP }];
    const res = await read(await queueGET());
    assert(res.status === 200, 'the queue loads');
    assert(res.body.items.length === 2, 'pull requests AND approvals are in the same list');
    const kinds = res.body.items.map((i: any) => i.kind).sort();
    assert(kinds.join(',') === 'approval,pull_request', 'both kinds come back, tagged');
    const pr = res.body.items.find((i: any) => i.kind === 'pull_request');
    assert(pr.fingerprint === SHA_SHOWN, 'the pull request carries the head commit as its fingerprint');
    const ap = res.body.items.find((i: any) => i.kind === 'approval');
    assert(ap.fingerprint === STAMP, 'the approval carries its last-write time as its fingerprint');
    assert(ap.title === 'Restart the Pi', 'and the summary the agent wrote');
}
{
    reset();
    session = { ok: false, reason: 'not-connected' };
    pending = [{ intent_id: 'intent-1', target_summary: 'Restart the Pi', actor: null, created_at: STAMP, updated_at: STAMP }];
    const res = await read(await queueGET());
    assert(res.status === 200 && res.body.items.length === 1, 'with GitHub not connected, approvals still come through');
    assert(res.body.github_connected === false, 'and the page is told GitHub is missing');
    assert(outbound.length === 0, 'no GitHub call is attempted');
}
{
    reset();
    routes = [[/\/user\/repos/, { status: 401 }]];
    pending = [{ intent_id: 'intent-1', target_summary: 'Restart the Pi', actor: null, created_at: STAMP, updated_at: STAMP }];
    const res = await read(await queueGET());
    assert(res.body.items.length === 1, 'GitHub failing does not hide a pending approval');
    assert(res.body.warnings.length === 1, 'it degrades to a warning');
}
{
    reset();
    signedIn = false;
    const res = await read(await queueGET());
    assert(res.status === 401 && res.body.reason === 'no-session', 'a signed-out caller gets 401, not an empty queue');
}

// ── Committing a decision ───────────────────────────────────────────────

out('\nPOST /api/v1/queue/decide - the fingerprint guard');
{
    reset();
    routes = [[/\/pulls\/7\/merge$/, { json: { merged: true } }]];
    const res = await read(await decidePOST(decideRequest({ kind: 'pull_request', action: 'yes', fingerprint: SHA_SHOWN, owner: 'o', repo: 'r', number: 7 })));
    assert(res.status === 200 && res.body.committed === true, 'control: yes on a pull request with a current head merges');
    assert(JSON.parse(outbound[0].body).sha === SHA_SHOWN, 'the route forwards the fingerprint to GitHub as `sha`');
}
{
    reset();
    // 409 is what GitHub answers when `sha` no longer matches the head.
    routes = [[/\/pulls\/7\/merge$/, { status: 409, json: { message: 'Head branch was modified. Review and try the merge again.' } }]];
    const res = await read(await decidePOST(decideRequest({ kind: 'pull_request', action: 'yes', fingerprint: SHA_SHOWN, owner: 'o', repo: 'r', number: 7 })));
    assert(res.status === 409 && res.body.committed === false, 'A MOVED HEAD SHA FAILS THE MERGE');
    assert(/Head branch changed since you looked/.test(res.body.reason), 'and the person is told the branch moved');
}
{
    reset();
    routes = [[/merge$/, { json: { merged: true } }]];
    const res = await read(await decidePOST(decideRequest({ kind: 'pull_request', action: 'yes', owner: 'o', repo: 'r', number: 7 })));
    assert(res.status === 400, 'a decision with NO fingerprint is refused by the route');
    assert(outbound.length === 0, 'and never reaches GitHub - there is no unguarded merge path');
}
{
    reset();
    routes = [[/merge$/, { json: { merged: true } }]];
    const res = await read(await decidePOST(decideRequest({ kind: 'pull_request', action: 'yes', fingerprint: SHA_SHOWN, owner: 'o', repo: 'r', number: 7, draft: true })));
    assert(res.status === 409 && res.body.committed === false, 'A DRAFT PR CANNOT BE MERGED, even calling the API directly');
    assert(outbound.length === 0, 'and never reaches GitHub');
}
{
    reset();
    routes = [[/merge$/, { json: { merged: true } }]];
    const res = await read(await decidePOST(decideRequest({ kind: 'pull_request', action: 'no', fingerprint: SHA_SHOWN, owner: 'o', repo: 'r', number: 7 })));
    assert(res.status === 400, 'NO on a pull request is refused as a server action');
    assert(outbound.length === 0, 'and makes NO GitHub call - leaving a PR alone is not a close or a rejection');
    assert(decideCalls.length === 0, 'and writes nothing anywhere else either');
}
{
    reset();
    signedIn = false;
    routes = [[/merge$/, { json: { merged: true } }]];
    const res = await read(await decidePOST(decideRequest({ kind: 'pull_request', action: 'yes', fingerprint: SHA_SHOWN, owner: 'o', repo: 'r', number: 7 })));
    assert(res.status === 401 && outbound.length === 0, 'a signed-out caller cannot commit anything');
}
{
    reset();
    session = { ok: false, reason: 'not-connected' };
    routes = [[/merge$/, { json: { merged: true } }]];
    const res = await read(await decidePOST(decideRequest({ kind: 'pull_request', action: 'yes', fingerprint: SHA_SHOWN, owner: 'o', repo: 'r', number: 7 })));
    assert(res.status === 401 && outbound.length === 0, 'a signed-in caller with no GitHub connection cannot merge');
}

out('\nPOST /api/v1/queue/decide - approvals');
{
    reset();
    const res = await read(await decidePOST(decideRequest({ kind: 'approval', action: 'yes', fingerprint: STAMP, intent_id: 'intent-1' })));
    assert(res.status === 200 && res.body.committed === true, 'yes on an approval approves it');
    assert(decideCalls[0][2] === 'approve', 'as an approval');
    assert(decideCalls[0][3] === STAMP, 'pinned to the version the person read');
    assert(decideCalls[0][0] === USER, 'scoped to the signed-in user, not a value from the body');
}
{
    reset();
    decideResult = { ok: true, status: 'denied' };
    const res = await read(await decidePOST(decideRequest({ kind: 'approval', action: 'no', fingerprint: STAMP, intent_id: 'intent-1' })));
    assert(res.status === 200 && res.body.message === 'Denied', 'no on an approval denies it');
    assert(decideCalls[0][2] === 'deny', 'as a denial, not an approval');
}
{
    reset();
    decideResult = { ok: false, reason: 'The request changed since you read it - nothing was changed. Read it again.', stale: true };
    const res = await read(await decidePOST(decideRequest({ kind: 'approval', action: 'yes', fingerprint: 'stale', intent_id: 'intent-1' })));
    assert(res.status === 409 && res.body.committed === false, 'a stale approval is refused');
    assert(/changed since you read it/.test(res.body.reason), 'with the reason passed through');
}
{
    reset();
    const res = await read(await decidePOST(decideRequest({ kind: 'nonsense', action: 'yes', fingerprint: 'x' })));
    assert(res.status === 400 && /Unknown item kind/.test(res.body.error), 'an unknown kind is refused rather than guessed at');
}

// ── The leak check ──────────────────────────────────────────────────────

out('\nTHE TOKEN IS NOT IN ANY CLIENT-VISIBLE PAYLOAD OR LOG LINE');
{
    reset();
    routes = PR_ROUTES;
    await read(await queueGET());
    await read(await sessionGET());
    routes = [[/oauth\/access_token/, { json: { access_token: SENTINEL } }]];
    await read(await pollPOST());

    // Positive control: prove the grep finds the token where it SHOULD be.
    reset();
    routes = PR_ROUTES;
    await read(await queueGET());
    const authHeaders = outbound.map((c) => c.headers.Authorization || '').filter(Boolean);
    assert(authHeaders.some((h) => h.includes(SENTINEL)), 'control: the grep DOES find the token in the outgoing Authorization header');
    assert(outbound.every((c) => !c.url.includes(SENTINEL)), 'the token is never in an outgoing URL');
    assert(outbound.every((c) => !c.body.includes(SENTINEL)), 'the token is never in an outgoing request body');

    const bodies = clientVisible.join('\n');
    assert(bodies.length > 0, 'control: there are response bodies to search');
    assert(!bodies.includes(SENTINEL), `the token appears in NONE of the ${clientVisible.length} captured response bodies and headers`);
    assert(!bodies.includes('ghu_'), 'no token-shaped string of any kind is in a response');

    const fromRoutes = logLines.length;
    console.warn('CONTROL line pretending a route logged', SENTINEL);
    assert(logLines.length === fromRoutes + 1 && logLines[fromRoutes].includes(SENTINEL),
        'control: the console capture DOES catch a line containing the token');
    const routeLogs = logLines.slice(0, fromRoutes).join('\n');
    assert(!routeLogs.includes(SENTINEL), `the token appears in none of the ${fromRoutes} log lines the routes produced`);
    assert(!routeLogs.includes('ghu_'), 'and no token-shaped string of any kind was logged');
}

releaseConsole();
globalThis.fetch = realFetch;

out(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
