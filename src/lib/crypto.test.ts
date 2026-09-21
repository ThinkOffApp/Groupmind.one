// SPDX-License-Identifier: AGPL-3.0-only
// Unit test for crypto module
// Run: cd antfarm && ROOM_ENCRYPTION_KEY=$(openssl rand -hex 32) npx tsx src/lib/crypto.test.ts

import { encryptMessage, decryptMessage, isEncrypted } from './crypto';

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

// Set a test key if not provided
if (!process.env.ROOM_ENCRYPTION_KEY) {
    process.env.ROOM_ENCRYPTION_KEY = 'a'.repeat(64);
}

console.log('🔐 Crypto module tests\n');

// Test 1: Roundtrip
const original = 'Hello, this is a secret message! 🔐';
const encrypted = encryptMessage(original);
const decrypted = decryptMessage(encrypted);
assert(decrypted === original, 'Roundtrip: encrypt → decrypt produces original');

// Test 2: Encrypted format
assert(encrypted.startsWith('ENC:v1:'), 'Ciphertext starts with ENC:v1: prefix');
assert(encrypted.split(':').length === 5, 'Ciphertext has 5 colon-separated parts');

// Test 3: isEncrypted
assert(isEncrypted(encrypted), 'isEncrypted returns true for ciphertext');
assert(!isEncrypted('hello world'), 'isEncrypted returns false for plaintext');

// Test 4: Unique IVs (same plaintext → different ciphertext)
const encrypted2 = encryptMessage(original);
assert(encrypted !== encrypted2, 'Same plaintext produces different ciphertext (unique IV)');
assert(decryptMessage(encrypted2) === original, 'Second encryption also decrypts correctly');

// Test 5: Plaintext passthrough (backward compat)
assert(decryptMessage('plain text message') === 'plain text message', 'Plaintext passthrough works');
assert(decryptMessage('') === '', 'Empty string passthrough works');

// Test 6: Unicode and emoji
const unicode = 'Héllo Wörld! 🐜🔥💀 日本語テスト';
const encUnicode = encryptMessage(unicode);
assert(decryptMessage(encUnicode) === unicode, 'Unicode and emoji roundtrip');

// Test 7: Long message
const longMsg = 'x'.repeat(4000);
const encLong = encryptMessage(longMsg);
assert(decryptMessage(encLong) === longMsg, 'Long message (4000 chars) roundtrip');

// Test 8: API key-like content
const apiKey = 'sk-ant-api03-abc123XYZ890_test-key-value';
const encKey = encryptMessage(apiKey);
assert(decryptMessage(encKey) === apiKey, 'API key content roundtrip');
assert(!encKey.includes(apiKey), 'Ciphertext does not contain plaintext API key');

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
