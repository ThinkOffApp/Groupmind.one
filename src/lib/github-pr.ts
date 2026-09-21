// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Listing and merging GitHub pull requests, ported from CodeWatch's
 * `DashboardRepository` (`OpenPr`, `fetchOpenPrs`, `listOpenPrs`, `mergePr`).
 *
 * The decision worth carrying over intact is the head-SHA guard. A merge
 * request sends the head commit that was ON SCREEN when the list was built.
 * If the branch received commits since then, GitHub answers 409 instead of
 * merging a revision nobody looked at. That came out of a review on
 * CodeWatch#75 and it is the difference between "merge what I read" and
 * "merge whatever is there now".
 *
 * `fetchImpl` is injectable on every call so the whole module is testable
 * without a GitHub token.
 *
 * Nothing here logs. The token appears in exactly one place: the
 * Authorization header of a request to api.github.com.
 */

import type { FetchImpl } from './github-device-flow';

const API = 'https://api.github.com';

/**
 * A listing costs 1 repo call + one pulls call per repo. Capping the repo
 * fan-out keeps a page load well inside the 5000/h authenticated quota.
 */
const MAX_PR_REPOS = 12;
const MAX_PRS_PER_REPO = 10;
/** Mergeability needs a per-PR call; only the freshest PRs get enriched. */
const MAX_PR_DETAIL = 20;

export interface OpenPr {
    owner: string;
    repo: string;
    number: number;
    title: string;
    author: string;
    url: string;
    draft: boolean;
    /**
     * Head commit as of this listing. Sent back as the merge endpoint's `sha`
     * so a branch that moved after the person looked cannot be merged blind.
     */
    headSha: string | null;
    headRef: string | null;
    updatedAt: string | null;
    /** GitHub's own answer; null means it has not computed one yet. */
    mergeable: boolean | null;
    mergeableState: string | null;
}

export interface GithubCallOptions {
    token: string;
    fetchImpl?: FetchImpl;
}

export type MergeOutcome =
    | { merged: true; message: string }
    | { merged: false; reason: string; status: number | null };

function headers(token: string): Record<string, string> {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'groupmind-web',
    };
}

async function getJson(
    path: string,
    opts: GithubCallOptions
): Promise<{ ok: boolean; status: number; body: unknown }> {
    const res = await (opts.fetchImpl ?? fetch)(`${API}${path}`, {
        method: 'GET',
        headers: headers(opts.token),
        cache: 'no-store',
    });
    const text = await res.text();
    let body: unknown = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = null;
    }
    return { ok: res.ok, status: res.status, body };
}

interface RepoRef {
    owner: string;
    name: string;
    fullName: string;
    pushedMs: number;
    openIssues: number;
}

const s = (o: any, k: string): string => (typeof o?.[k] === 'string' ? o[k] : '');
const ms = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
};

/** `/user/repos` rows -> [RepoRef]s, archived dropped, newest push first. */
export function parseUserRepos(rows: unknown): RepoRef[] {
    if (!Array.isArray(rows)) return [];
    const out: RepoRef[] = [];
    for (const row of rows) {
        const name = s(row, 'name');
        const owner = s((row as any)?.owner, 'login');
        if (!name || !owner || (row as any)?.archived === true) continue;
        out.push({
            owner,
            name,
            fullName: `${owner}/${name}`,
            pushedMs: ms(s(row, 'pushed_at')),
            openIssues: typeof (row as any)?.open_issues_count === 'number' ? (row as any).open_issues_count : 0,
        });
    }
    return out.sort((a, b) => b.pushedMs - a.pushedMs);
}

/** A `/pulls` row -> [OpenPr]. Mergeability is not in the list response. */
export function parsePullRow(row: unknown, owner: string, repo: string): OpenPr | null {
    const number = typeof (row as any)?.number === 'number' ? (row as any).number : 0;
    if (!number) return null;
    const head = (row as any)?.head ?? {};
    const sha = s(head, 'sha');
    return {
        owner,
        repo,
        number,
        title: s(row, 'title').trim(),
        author: s((row as any)?.user, 'login'),
        url: s(row, 'html_url') || `https://github.com/${owner}/${repo}/pull/${number}`,
        draft: (row as any)?.draft === true,
        headSha: sha || null,
        headRef: s(head, 'ref') || null,
        updatedAt: s(row, 'updated_at') || null,
        mergeable: null,
        mergeableState: null,
    };
}

export interface ListResult {
    prs: OpenPr[];
    /** Repos that could not be read. One bad repo must not sink the list. */
    warnings: string[];
}

/**
 * Open PRs across the repos this token can reach, newest activity first.
 *
 * Matches CodeWatch: list the token's repos, skip the ones with no open
 * issues at all, then pull each remaining one. A single repo failing
 * (renamed, permissions) is a warning, not an empty page. An auth failure
 * on the repo listing is not - it means every call would fail the same way,
 * so it is thrown.
 */
export async function listOpenPrs(opts: GithubCallOptions): Promise<ListResult> {
    const repoRes = await getJson(
        '/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=50',
        opts
    );
    if (!repoRes.ok) {
        throw new Error(
            repoRes.status === 401 || repoRes.status === 403
                ? 'GitHub rejected the connection - reconnect your account'
                : `GitHub could not list your repositories (HTTP ${repoRes.status})`
        );
    }

    const repos = parseUserRepos(repoRes.body)
        .filter((r) => r.openIssues > 0)
        .slice(0, MAX_PR_REPOS);

    const warnings: string[] = [];
    const prs: OpenPr[] = [];

    const perRepo = await Promise.all(
        repos.map(async (repo) => {
            try {
                const res = await getJson(
                    `/repos/${repo.fullName}/pulls?state=open&per_page=${MAX_PRS_PER_REPO}`,
                    opts
                );
                if (!res.ok) return { repo, rows: null as unknown[] | null, status: res.status };
                return { repo, rows: Array.isArray(res.body) ? res.body : [], status: res.status };
            } catch {
                return { repo, rows: null as unknown[] | null, status: 0 };
            }
        })
    );

    for (const { repo, rows, status } of perRepo) {
        if (rows === null) {
            warnings.push(`${repo.fullName}: could not read pull requests (HTTP ${status || 'network error'})`);
            continue;
        }
        for (const row of rows) {
            const pr = parsePullRow(row, repo.owner, repo.name);
            if (pr) prs.push(pr);
        }
    }

    prs.sort((a, b) => ms(b.updatedAt || '') - ms(a.updatedAt || ''));

    // Mergeability only exists on the single-PR response, so it costs one
    // call each. Enrich the freshest few and leave the rest as "unknown"
    // rather than spending the whole quota on a page nobody scrolls.
    await Promise.all(
        prs.slice(0, MAX_PR_DETAIL).map(async (pr) => {
            try {
                const res = await getJson(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, opts);
                if (!res.ok) return;
                const body = res.body as any;
                pr.mergeable = typeof body?.mergeable === 'boolean' ? body.mergeable : null;
                pr.mergeableState = s(body, 'mergeable_state') || null;
                // The detail response is fresher than the list; if the branch
                // moved between the two calls, the guard should pin to what we
                // are about to show, not to a SHA already stale on arrival.
                const sha = s(body?.head, 'sha');
                if (sha) pr.headSha = sha;
            } catch {
                // leave it unknown
            }
        })
    );

    return { prs, warnings };
}

export interface MergeRequest {
    owner: string;
    repo: string;
    number: number;
    /** The head commit the person was shown. Required - see the module note. */
    headSha: string;
    draft?: boolean;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Merge one PR. Never throws for an HTTP-level refusal: the caller shows the
 * outcome either way, because silence is the failure mode this does not ship.
 *
 * Two refusals happen before GitHub is contacted at all:
 *  - a draft PR, because a draft is by definition not ready and GitHub's own
 *    405 for it reads like a conflict;
 *  - a missing or malformed head SHA, because merging without the guard is
 *    the exact thing the guard exists to prevent. It is not optional and
 *    there is no "merge anyway" path.
 */
export async function mergePr(req: MergeRequest, opts: GithubCallOptions): Promise<MergeOutcome> {
    if (req.draft) {
        return {
            merged: false,
            reason: `${req.repo} #${req.number} is a draft - mark it ready on GitHub first`,
            status: null,
        };
    }
    if (!req.headSha || !SHA_RE.test(req.headSha)) {
        return {
            merged: false,
            reason: 'Refusing to merge without the head commit you were shown',
            status: null,
        };
    }

    let res: Response;
    let text = '';
    try {
        res = await (opts.fetchImpl ?? fetch)(
            `${API}/repos/${req.owner}/${req.repo}/pulls/${req.number}/merge`,
            {
                method: 'PUT',
                headers: { ...headers(opts.token), 'Content-Type': 'application/json' },
                // `sha` is the guard: GitHub refuses with 409 if the head
                // branch moved since the listing (CodeWatch#75).
                body: JSON.stringify({ merge_method: 'merge', sha: req.headSha }),
            }
        );
        text = await res.text();
    } catch (e) {
        const message = e instanceof Error ? e.message : 'unknown';
        return { merged: false, reason: `Network error: ${message}`, status: null };
    }

    let apiMessage = '';
    try {
        const parsed = text ? JSON.parse(text) : null;
        apiMessage = s(parsed, 'message');
    } catch {
        apiMessage = '';
    }

    if (res.ok) {
        return { merged: true, message: `Merged ${req.repo} #${req.number}` };
    }

    const why =
        res.status === 401 || res.status === 403
            ? 'GitHub rejected the connection'
            : res.status === 404
              ? `Not found - the connection may lack access to ${req.owner}/${req.repo}`
              : res.status === 405
                ? 'GitHub refuses: not mergeable (conflicts or checks)'
                : res.status === 409
                  ? 'Head branch changed since you looked - refresh and read it again'
                  : `GitHub said no (HTTP ${res.status})`;

    return {
        merged: false,
        reason: apiMessage ? `${why}: ${apiMessage}` : why,
        status: res.status,
    };
}
