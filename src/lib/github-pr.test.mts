// Unit test for listing and merging pull requests.
// Run: npx tsx src/lib/github-pr.test.mts
//
// The head-SHA guard is the point of this file. It came from a review on
// CodeWatch#75: a merge must be pinned to the commit the person was shown, so
// a branch that moved after they looked fails instead of merging unseen work.
// `fetchImpl` is injected, so none of this needs a GitHub token.

import { listOpenPrs, mergePr, parsePullRow, parseUserRepos } from './github-pr';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}`);
        failed++;
    }
}

interface Call {
    url: string;
    method: string;
    body: string;
    headers: Record<string, string>;
}

/** A stub GitHub: routes on URL, records every call. */
function github(routes: Array<[RegExp, { status?: number; json?: unknown }]>) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: unknown, init: any) => {
        const u = String(url);
        calls.push({
            url: u,
            method: init?.method ?? 'GET',
            body: String(init?.body ?? ''),
            headers: (init?.headers ?? {}) as Record<string, string>,
        });
        for (const [re, reply] of routes) {
            if (re.test(u)) {
                const status = reply.status ?? 200;
                return {
                    ok: status >= 200 && status < 300,
                    status,
                    text: async () => JSON.stringify(reply.json ?? {}),
                } as unknown as Response;
            }
        }
        return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' } as unknown as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
}

const SHA_OLD = '1111111111111111111111111111111111111111';
const SHA_NEW = '2222222222222222222222222222222222222222';
const TOKEN = 'ghu_test_token_value';

console.log('\nParsing');
{
    const repos = parseUserRepos([
        { name: 'b', owner: { login: 'o' }, pushed_at: '2026-09-01T00:00:00Z', open_issues_count: 3 },
        { name: 'a', owner: { login: 'o' }, pushed_at: '2026-09-10T00:00:00Z', open_issues_count: 1 },
        { name: 'dead', owner: { login: 'o' }, archived: true, open_issues_count: 9 },
        { name: '', owner: { login: 'o' } },
    ]);
    assert(repos.length === 2, 'archived and nameless repos are dropped');
    assert(repos[0].name === 'a', 'newest push first');
    assert(parseUserRepos('not an array').length === 0, 'a non-array body is empty, not a crash');
}
{
    const pr = parsePullRow(
        {
            number: 42,
            title: '  Fix it  ',
            user: { login: 'claudemb' },
            html_url: 'https://github.com/o/r/pull/42',
            draft: true,
            head: { sha: SHA_OLD, ref: 'claudemb/fix' },
            updated_at: '2026-09-19T10:00:00Z',
        },
        'o',
        'r'
    );
    assert(pr !== null && pr.number === 42 && pr.title === 'Fix it', 'title is trimmed');
    assert(pr!.draft === true, 'draft state survives');
    assert(pr!.headSha === SHA_OLD, 'the head SHA travels with the row - this is the guard');
    assert(pr!.author === 'claudemb', 'author survives');
    assert(pr!.mergeable === null, 'mergeability is unknown from a list response, and says so');
    assert(parsePullRow({ title: 'no number' }, 'o', 'r') === null, 'a row with no number is dropped');
}

console.log('\nlistOpenPrs');
{
    const { calls, fetchImpl } = github([
        [
            /\/user\/repos/,
            {
                json: [
                    { name: 'live', owner: { login: 'o' }, pushed_at: '2026-09-10T00:00:00Z', open_issues_count: 2 },
                    { name: 'quiet', owner: { login: 'o' }, pushed_at: '2026-09-09T00:00:00Z', open_issues_count: 0 },
                    { name: 'broken', owner: { login: 'o' }, pushed_at: '2026-09-08T00:00:00Z', open_issues_count: 5 },
                ],
            },
        ],
        [
            /\/repos\/o\/live\/pulls\?/,
            {
                json: [
                    { number: 1, title: 'One', user: { login: 'a' }, head: { sha: SHA_OLD, ref: 'x' }, updated_at: '2026-09-19T10:00:00Z' },
                    { number: 2, title: 'Two', user: { login: 'b' }, draft: true, head: { sha: SHA_NEW, ref: 'y' }, updated_at: '2026-09-20T10:00:00Z' },
                ],
            },
        ],
        [/\/repos\/o\/broken\/pulls\?/, { status: 403 }],
        [/\/repos\/o\/live\/pulls\/1$/, { json: { mergeable: true, mergeable_state: 'clean', head: { sha: SHA_OLD } } }],
        [/\/repos\/o\/live\/pulls\/2$/, { json: { mergeable: false, mergeable_state: 'dirty', head: { sha: SHA_NEW } } }],
    ]);

    const { prs, warnings } = await listOpenPrs({ token: TOKEN, fetchImpl });
    assert(prs.length === 2, 'PRs come back from the repos that answered');
    assert(prs[0].number === 2, 'newest activity first');
    assert(prs[0].draft === true && prs[1].draft === false, 'draft state is reported per PR');
    assert(prs[1].mergeable === true && prs[1].mergeableState === 'clean', 'mergeable state is filled in');
    assert(prs[0].mergeable === false && prs[0].mergeableState === 'dirty', 'and reported honestly when false');
    assert(prs.every((p) => !!p.headSha), 'every row carries a head SHA');
    assert(warnings.length === 1 && warnings[0].includes('broken'), 'one unreadable repo is a warning, not an empty page');
    assert(!calls.some((c) => c.url.includes('quiet')), 'a repo with no open issues is not fetched at all');
    assert(
        calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}`),
        'the token rides in the Authorization header and nowhere else'
    );
    assert(!calls.some((c) => c.url.includes(TOKEN)), 'the token is never in a URL');
}
{
    const { fetchImpl } = github([[/\/user\/repos/, { status: 401 }]]);
    let threw = '';
    try {
        await listOpenPrs({ token: TOKEN, fetchImpl });
    } catch (e) {
        threw = e instanceof Error ? e.message : '';
    }
    assert(threw.includes('reconnect'), 'a rejected token is thrown, not swallowed into "no PRs"');
}

console.log('\nmergePr sends the head SHA it was given');
{
    const { calls, fetchImpl } = github([[/\/pulls\/7\/merge$/, { json: { merged: true, sha: SHA_OLD } }]]);
    const out = await mergePr({ owner: 'o', repo: 'r', number: 7, headSha: SHA_OLD }, { token: TOKEN, fetchImpl });
    assert(out.merged === true, 'a clean merge succeeds');
    const sent = JSON.parse(calls[0].body);
    assert(sent.sha === SHA_OLD, 'the request pins `sha` to the commit the person was shown');
    assert(sent.merge_method === 'merge', 'and asks for a merge commit');
    assert(calls[0].method === 'PUT', 'PUT, per the GitHub merge endpoint');
}

console.log('\nA MOVED HEAD SHA FAILS THE MERGE');
{
    // GitHub answers 409 when the `sha` does not match the current head. That
    // is the whole guard: the branch moved, so nothing is merged.
    const { calls, fetchImpl } = github([
        [/\/pulls\/7\/merge$/, { status: 409, json: { message: 'Head branch was modified. Review and try the merge again.' } }],
    ]);
    const out = await mergePr({ owner: 'o', repo: 'r', number: 7, headSha: SHA_OLD }, { token: TOKEN, fetchImpl });
    assert(out.merged === false, 'a moved branch does NOT merge');
    assert(out.merged === false && out.status === 409, 'the 409 is surfaced, not flattened into a generic failure');
    assert(
        out.merged === false && out.reason.includes('Head branch changed since you looked'),
        'and the person is told the branch moved'
    );
    assert(JSON.parse(calls[0].body).sha === SHA_OLD, 'the stale SHA was what we sent - the guard did the refusing');
}
{
    // The negative control for the case above: with the CURRENT head, the same
    // stub merges. So the 409 test is measuring the SHA, not a broken stub.
    const { fetchImpl } = github([[/\/pulls\/7\/merge$/, { json: { merged: true } }]]);
    const out = await mergePr({ owner: 'o', repo: 'r', number: 7, headSha: SHA_NEW }, { token: TOKEN, fetchImpl });
    assert(out.merged === true, 'control: the same call with a current head DOES merge');
}

console.log('\nRefused before GitHub is even contacted');
{
    const { calls, fetchImpl } = github([[/merge$/, { json: { merged: true } }]]);
    const out = await mergePr({ owner: 'o', repo: 'r', number: 7, headSha: SHA_OLD, draft: true }, { token: TOKEN, fetchImpl });
    assert(out.merged === false && out.reason.includes('draft'), 'A DRAFT PR CANNOT BE MERGED');
    assert(calls.length === 0, 'and no request is made at all');
}
{
    const { calls, fetchImpl } = github([[/merge$/, { json: { merged: true } }]]);
    const missing = await mergePr({ owner: 'o', repo: 'r', number: 7, headSha: '' }, { token: TOKEN, fetchImpl });
    assert(missing.merged === false, 'a merge with no head SHA is refused');
    assert(missing.merged === false && missing.reason.includes('head commit you were shown'), 'and says why');
    const junk = await mergePr({ owner: 'o', repo: 'r', number: 7, headSha: 'not-a-sha' }, { token: TOKEN, fetchImpl });
    assert(junk.merged === false, 'a malformed head SHA is refused');
    assert(calls.length === 0, 'neither reaches GitHub - there is no "merge anyway" path');
}

console.log('\nGitHub refusals are phrased for a person');
{
    const cases: Array<[number, string]> = [
        [401, 'rejected the connection'],
        [403, 'rejected the connection'],
        [404, 'may lack access'],
        [405, 'not mergeable'],
        [500, 'HTTP 500'],
    ];
    for (const [status, phrase] of cases) {
        const { fetchImpl } = github([[/merge$/, { status, json: { message: 'gh says so' } }]]);
        const out = await mergePr({ owner: 'o', repo: 'r', number: 7, headSha: SHA_OLD }, { token: TOKEN, fetchImpl });
        assert(out.merged === false && out.reason.includes(phrase), `HTTP ${status} reads as "${phrase}"`);
    }
    const fetchImpl = (async () => {
        throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const out = await mergePr({ owner: 'o', repo: 'r', number: 7, headSha: SHA_OLD }, { token: TOKEN, fetchImpl });
    assert(out.merged === false && out.reason.includes('Network error'), 'a network failure is an outcome, never a silent success');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
