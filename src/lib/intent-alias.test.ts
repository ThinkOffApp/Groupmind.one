// SPDX-License-Identifier: AGPL-3.0-only
// Unit test for the intent alias resolver (API-key reads merge handle + UUID docs)
// Run: cd antfarm && npx tsx src/lib/intent-alias.test.ts

import { isUuid, resolveIntentAlias, type AliasLookup } from './intent-alias';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
    if (condition) { console.log(`  ✅ ${name}`); passed++; } else { console.log(`  ❌ ${name}`); failed++; }
}

const UUID = '3f2c1a9e-5b7d-4c8e-9a1b-2d3e4f5a6b7c';
const lookup: AliasLookup = {
    async handleForUserId(id) { return id === UUID ? '@petrus' : null; },
    async userIdForHandle(h) { return h === 'petrus' ? UUID : null; },
};

(async () => {
    console.log('intent-alias');
    assert(isUuid(UUID), 'isUuid accepts a v4-shaped uuid');
    assert(!isUuid('petrus'), 'isUuid rejects a handle');
    assert(await resolveIntentAlias('petrus', lookup) === UUID, 'handle resolves to the uuid');
    assert(await resolveIntentAlias('@petrus', lookup) === UUID, 'leading @ is stripped before the lookup');
    assert(await resolveIntentAlias(UUID, lookup) === 'petrus', 'uuid resolves to the handle without @');
    assert(await resolveIntentAlias('nobody', lookup) === null, 'unknown handle gives null');
    assert(await resolveIntentAlias('', lookup) === null, 'empty id gives null');
    const same: AliasLookup = { async handleForUserId() { return 'x'; }, async userIdForHandle() { return 'x'; } };
    assert(await resolveIntentAlias('x', same) === null, 'an alias equal to the id itself is not returned');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
