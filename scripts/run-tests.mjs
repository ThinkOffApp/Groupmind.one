#!/usr/bin/env node
/**
 * Runs the repo's tests.
 *
 * The tests here are plain tsx scripts, not a framework suite: each one counts
 * its own assertions, prints them, and calls process.exit(1) when any failed.
 * This runner is the missing piece -- it FINDS them and turns "any file
 * failed" into a non-zero exit code, so CI can see a regression.
 *
 * Discovery is by filename, so a future `src/**\/*.test.ts` is picked up with
 * no change here:
 *   *.test.ts / *.test.mts            unit tests
 *   *.integration.test.mts            route-level tests; these mock ES modules,
 *                                     which needs an extra node flag
 *
 * Usage:
 *   node scripts/run-tests.mjs              every test
 *   node scripts/run-tests.mjs unit         unit tests only
 *   node scripts/run-tests.mjs integration  integration tests only
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_ROOT = join(ROOT, 'src');

// Module mocking (node:test's `mock.module`) is still behind a flag. Only the
// integration tests use it, so only they pay the warning.
const MODULE_MOCK_FLAG = '--experimental-test-module-mocks';

const isTest = (name) => /\.test\.m?ts$/.test(name);
const isIntegration = (name) => /\.integration\.test\.m?ts$/.test(name);

function findTests(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...findTests(full));
        else if (entry.isFile() && isTest(entry.name)) found.push(full);
    }
    return found.sort();
}

/** Resolve the locally installed tsx CLI, so this never depends on `npx`
 * reaching the network to fetch an unpinned copy. */
function tsxCli() {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('tsx/package.json', { paths: [ROOT] });
    const pkg = require(pkgPath);
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.tsx;
    return join(dirname(pkgPath), bin);
}

const mode = process.argv[2] ?? 'all';
if (!['all', 'unit', 'integration'].includes(mode)) {
    console.error(`unknown mode "${mode}" (expected: all | unit | integration)`);
    process.exit(2);
}

let files;
try {
    files = findTests(SEARCH_ROOT);
} catch (err) {
    console.error(`could not read ${SEARCH_ROOT}: ${err.message}`);
    process.exit(2);
}
if (mode === 'unit') files = files.filter((f) => !isIntegration(f));
if (mode === 'integration') files = files.filter((f) => isIntegration(f));

// An empty run must not look like a green run: a glob that silently matches
// nothing is exactly how a test suite stops running without anyone noticing.
if (files.length === 0) {
    console.error(`No ${mode === 'all' ? '' : mode + ' '}test files found under src/ -- expected at least one *.test.ts`);
    process.exit(2);
}

const cli = tsxCli();
const failed = [];

for (const file of files) {
    const rel = relative(ROOT, file);
    console.log(`\n[1m=== ${rel} ===[0m`);
    const args = [cli];
    if (isIntegration(file)) args.push(MODULE_MOCK_FLAG);
    args.push(file);
    const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    // A crash before the summary (signal, import error, thrown exception) is a
    // failure too -- status is null when the child died on a signal.
    const ok = res.error === undefined && res.status === 0;
    if (!ok) {
        failed.push(rel);
        const why = res.error ? res.error.message : res.signal ? `killed by ${res.signal}` : `exit ${res.status}`;
        console.log(`[31mFAILED[0m ${rel} (${why})`);
    }
}

console.log(`\n${'='.repeat(60)}`);
if (failed.length > 0) {
    console.log(`[31m${failed.length} of ${files.length} test files FAILED:[0m`);
    for (const f of failed) console.log(`  - ${f}`);
    process.exit(1);
}
console.log(`[32mAll ${files.length} test files passed.[0m`);
