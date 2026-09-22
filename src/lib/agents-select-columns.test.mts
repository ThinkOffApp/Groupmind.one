// SPDX-License-Identifier: AGPL-3.0-only
// Unit test for the `agents` table 401 bug: PostgREST 400s the *entire*
// query when a select names a column the table doesn't have, and
// getAgentByApiKey (src/lib/auth.ts) mapped that error to null, so every
// route that asked for a nonexistent column returned 401 "Invalid API key"
// for every valid key. /agents/me asked for `status`, which does not exist
// (it lives in metadata.status); /agents/verify-bot asked for `verified_at`,
// same story.
//
// This test is a static guard, not a live DB check: it reads each route's
// source and extracts the column-list string(s) passed to getAgentByApiKey(
// and the raw `.from('agents').select(...)` calls in the same file, then
// asserts every named column is in the real schema. It fails the same way
// the production bug would have, without needing Postgres running.
//
// The constant below is the LIVE production schema (read directly from
// information_schema against the hosted `agents` table on 22 Sep 2026), not
// the migrations - the two have drifted: production also carries
// `is_suspended` and `followers_count`, which no migration file adds, and is
// MISSING `owner_user_id`, which migration 003_core_tables.sql adds but was
// never applied there. Trusting the migration files as ground truth would
// have flagged is_suspended/followers_count (src/lib/admin-entities.ts) as
// bugs when they are not, and missed that any `agents` select naming
// `owner_user_id` would 400 in production today even though it compiles
// against the migrated schema. No route currently selects `owner_user_id`
// from `agents` (src/app/a/[handle]/page.tsx reads it only via `select('*')`,
// which just comes back undefined there, not a query error) - see the PR
// description for that as a separate, not-fixed-here finding.
//
// Run: npx tsx src/lib/agents-select-columns.test.mts

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

let passed = 0;
let failed = 0;
function assert(c: boolean, n: string) {
    if (c) {
        console.log(`  ✅ ${n}`);
        passed++;
    } else {
        console.log(`  ❌ ${n}`);
        failed++;
    }
}

// The 14 columns `information_schema.columns` reports for the hosted
// `agents` table, read live on 22 Sep 2026. `status`, `verified_at`,
// `owner_user_id`, `api_key` and `auth_id` are deliberately absent - the
// first two were this bug, `owner_user_id` is the migration/production drift
// noted above (separate finding, not fixed here), and the last two are the
// already-flagged, unrelated src/app/intent/page.tsx issue.
const AGENTS_COLUMNS = new Set([
    'id', 'handle', 'name', 'api_key_hash', 'owner_id', 'credibility',
    'created_at', 'metadata', 'webhook_url', 'wallet_address',
    'followers_count', 'is_premium', 'is_suspended', 'user_visible',
]);

/** Split a PostgREST select-list string into bare column names, ignoring
 * embedded-resource syntax (`foo(bar)`) and `*`, which this codebase doesn't
 * use against `agents` with extra columns mixed in. */
function columnsIn(selectList: string): string[] {
    return selectList
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0 && s !== '*' && !s.includes('('));
}

/** Pull every `getAgentByApiKey(apiKey, '<cols>')` column-list literal out of
 * a file's source. Calls using a variable (e.g. AGENT_COLUMNS) or '*' are
 * skipped - '*' can never request a missing column, and constants are
 * exercised by their own call sites elsewhere. */
function getAgentByApiKeyColumnLists(source: string): string[][] {
    const out: string[][] = [];
    const re = /getAgentByApiKey\(\s*apiKey\s*,\s*'([^']*)'\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
        if (m[1] !== '*') out.push(columnsIn(m[1]));
    }
    return out;
}

/** Pull every `.from('agents')....select('<cols>')` column-list literal,
 * allowing the .select() to be on the same or a following line. */
function fromAgentsSelectColumnLists(source: string): string[][] {
    const out: string[][] = [];
    const re = /\.from\('agents'\)[\s\S]{0,80}?\.select\(\s*'([^']*)'\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
        if (m[1] !== '*') out.push(columnsIn(m[1]));
    }
    return out;
}

function checkFile(relPath: string) {
    const abs = join(SRC, relPath);
    const source = readFileSync(abs, 'utf8');
    const lists = [
        ...getAgentByApiKeyColumnLists(source),
        ...fromAgentsSelectColumnLists(source),
    ];
    assert(lists.length > 0, `${relPath}: found at least one agents column-list select to check`);
    for (const cols of lists) {
        const missing = cols.filter(c => !AGENTS_COLUMNS.has(c));
        assert(
            missing.length === 0,
            missing.length === 0
                ? `${relPath}: [${cols.join(', ')}] are all real agents columns`
                : `${relPath}: [${cols.join(', ')}] - missing: ${missing.join(', ')}`
        );
    }
}

console.log('\n/agents/me no longer 400s on a nonexistent `status` column');
checkFile('app/api/v1/agents/me/route.ts');
{
    const source = readFileSync(join(SRC, 'app/api/v1/agents/me/route.ts'), 'utf8');
    assert(!/getAgentByApiKey\([^)]*\bstatus\b[^)]*\)/.test(source), 'the getAgentByApiKey() call no longer names `status`');
}

console.log('\n/agents/verify-bot no longer 400s on a nonexistent `verified_at` column');
checkFile('app/api/v1/agents/verify-bot/route.ts');

console.log('\nadmin-entities getRecentAgents() is_suspended/followers_count are real production columns (not a bug - negative control against trusting migrations alone)');
checkFile('lib/admin-entities.ts');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
