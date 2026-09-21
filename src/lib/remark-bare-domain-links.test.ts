// SPDX-License-Identifier: AGPL-3.0-only
// Unit test for bare-domain linkification (petrus's dead-link report, 2026-07-21).
// Run: cd antfarm && npx tsx src/lib/remark-bare-domain-links.test.ts

import { splitBareDomains } from './remark-bare-domain-links';

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

// Render a split result back to plain segments for easy assertion: [text, [url, text], text...]
function segments(value: string): (string | [string, string])[] {
    return splitBareDomains(value).map((n) =>
        n.type === 'link' ? [n.url, (n.children[0] as { value: string }).value] : n.value
    );
}

console.log('Bare domains linkify:');
assert(
    JSON.stringify(segments('open console.cloud.google.com/cloud-resource-manager now')) ===
        JSON.stringify(['open ', ['https://console.cloud.google.com/cloud-resource-manager', 'console.cloud.google.com/cloud-resource-manager'], ' now']),
    'petrus case: schemeless console URL with path'
);
assert(
    JSON.stringify(segments('see groupmind.one/messages')) ===
        JSON.stringify(['see ', ['https://groupmind.one/messages', 'groupmind.one/messages']]),
    'groupmind.one with path'
);
assert(
    JSON.stringify(segments('check codewatch.app/delete-account and vercel.app')) ===
        JSON.stringify(['check ', ['https://codewatch.app/delete-account', 'codewatch.app/delete-account'], ' and ', ['https://vercel.app', 'vercel.app']]),
    'multiple domains in one string'
);
assert(
    JSON.stringify(segments('ports example.com:8443/x works')) ===
        JSON.stringify(['ports ', ['https://example.com:8443/x', 'example.com:8443/x'], ' works']),
    'optional port kept'
);

console.log('Sentence punctuation stays outside the link:');
assert(
    JSON.stringify(segments('try (groupmind.one/x).')) ===
        JSON.stringify(['try (', ['https://groupmind.one/x', 'groupmind.one/x'], ').']),
    'trailing ). stripped'
);
assert(
    JSON.stringify(segments('a example.com, b')) ===
        JSON.stringify(['a ', ['https://example.com', 'example.com'], ', b']),
    'trailing comma stripped'
);

console.log('Never linkify:');
assert(JSON.stringify(segments('mail me at user@gmail.com')) === JSON.stringify(['mail me at user@gmail.com']), 'email left alone');
assert(JSON.stringify(segments('run post_room.sh then read_room.sh')) === JSON.stringify(['run post_room.sh then read_room.sh']), '.sh filenames left alone');
assert(JSON.stringify(segments('libnative.so and notes.txt')) === JSON.stringify(['libnative.so and notes.txt']), '.so/.txt left alone');
assert(JSON.stringify(segments('version v0.10.94 is out')) === JSON.stringify(['version v0.10.94 is out']), 'version numbers left alone');
assert(JSON.stringify(segments('plain text, no dots here')) === JSON.stringify(['plain text, no dots here']), 'no-dot text untouched');

console.log('Scheme/www URLs pass through unchanged (remark-gfm owns those upstream):');
assert(
    JSON.stringify(segments('go https://x.com/a now')) === JSON.stringify(['go https://x.com/a now']),
    'scheme URL untouched by this splitter'
);
assert(
    JSON.stringify(segments('see www.example.com here')) === JSON.stringify(['see ', ['https://www.example.com', 'www.example.com'], ' here']),
    'www domain still linkified as fallback (idempotent with gfm)'
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
