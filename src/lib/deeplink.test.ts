// SPDX-License-Identifier: AGPL-3.0-only
// Unit test for deeplink validation (security boundary — see deeplink.ts).
// Run: cd antfarm && npx tsx src/lib/deeplink.test.ts

import { validateDeeplink, MAX_DEEPLINK_LENGTH } from './deeplink';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ ${name}`);
        failed++;
    }
}

console.log('Allowed schemes:');
assert(validateDeeplink('https://claude.ai/code/session/abc123').ok, 'https URL accepted');
assert(validateDeeplink('claude://session/abc123').ok, 'claude:// accepted');
assert(validateDeeplink('chatgpt://codex/session/xyz').ok, 'chatgpt:// accepted');
assert(validateDeeplink('CLAUDE://Session/Abc').ok, 'scheme match is case-insensitive');

console.log('Dangerous schemes rejected:');
for (const bad of [
    'intent://scan/#Intent;scheme=zxing;package=evil.app;end',
    'file:///etc/passwd',
    'content://com.android.providers/secret',
    'javascript://alert(1)',
    'data://text/html;base64,PHNjcmlwdD4=',
    'http://claude.ai/downgraded-to-plaintext',
    'ftp://host/x',
    'market://details?id=evil.app',
]) {
    const verdict = validateDeeplink(bad);
    assert(!verdict.ok, `rejected: ${bad.slice(0, 50)}`);
}

console.log('Malformed values rejected:');
assert(!validateDeeplink('not a url').ok, 'plain text rejected');
assert(!validateDeeplink('https:no-slashes').ok, 'scheme without :// rejected');
assert(!validateDeeplink('https:// space.com').ok, 'embedded whitespace rejected');
assert(!validateDeeplink('').ok, 'empty string rejected');
assert(!validateDeeplink(42 as unknown as string).ok, 'non-string rejected');
assert(!validateDeeplink('https://' + 'a'.repeat(MAX_DEEPLINK_LENGTH)).ok, 'over-length rejected');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
