// SPDX-License-Identifier: AGPL-3.0-only
// Run: cd antfarm && npx tsx src/lib/intent-action-command.test.ts
import { intentActionCommand } from './intent-action-command';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string) {
    if (cond) { console.log(`  ✅ ${name}`); passed++; } else { console.log(`  ❌ ${name}`); failed++; }
}
const ID = '4153315f';

console.log('\nTHE BUG: arbitrary labels used to be dropped in silence');
assert(intentActionCommand(ID, 'claude-opus-5') === `/choose ${ID} claude-opus-5`, 'a model name becomes /choose (was: silently nothing)');
assert(intentActionCommand(ID, 'Restart the gateway') === `/choose ${ID} Restart the gateway`, 'a label with spaces is carried through whole');
{
    // The pre-fix client logic, inline, to show these inputs really were dropped.
    const old = (id: string, a: string) => {
        const d = a.toLowerCase().startsWith('approve') ? 'approve' : a.toLowerCase().startsWith('deny') ? 'deny' : null;
        return d ? `/${d} ${id}` : null;
    };
    assert(old(ID, 'claude-opus-5') === null, 'OLD logic returned null for a model name — the silent drop was real');
}

console.log('\nNO REGRESSION on the pair that already worked');
assert(intentActionCommand(ID, 'Approve') === `/approve ${ID}`, 'Approve');
assert(intentActionCommand(ID, 'approve and run') === `/approve ${ID}`, 'approve-prefix still maps to /approve');
assert(intentActionCommand(ID, 'Deny') === `/deny ${ID}`, 'Deny');
assert(intentActionCommand(ID, 'DENY') === `/deny ${ID}`, 'case-insensitive');

console.log('\nDECLARED SPELLING is preserved for choices');
assert(intentActionCommand(ID, 'Claude-Opus-5') === `/choose ${ID} Claude-Opus-5`, 'mixed case posted verbatim, not lowercased');
assert(intentActionCommand(ID, '  claude-sonnet-5  ') === `/choose ${ID} claude-sonnet-5`, 'surrounding whitespace trimmed');

console.log('\nNOTHING TO POST -> null, and the caller writes no state');
assert(intentActionCommand(null, 'claude-opus-5') === null, 'no intent id');
assert(intentActionCommand('', 'claude-opus-5') === null, 'empty intent id');
assert(intentActionCommand(ID, '') === null, 'empty label');
assert(intentActionCommand(ID, '   ') === null, 'whitespace-only label');
assert(intentActionCommand(ID, null) === null, 'null label');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
