// Unit test for the Apple identity token verifier
// Run: cd antfarm && npx tsx src/lib/apple-id-token.test.ts

import crypto from 'crypto';
import {
    verifyAppleIdToken, parseAudiences, APPLE_ISSUER, type AppleJwk,
    hashNonce, nonceMatches, unknownKidRefetchAllowed, resetUnknownKidRefetchGate, UNKNOWN_KID_REFETCH_COOLDOWN_MS,
} from './apple-id-token';

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

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { publicKey: otherPublic, privateKey: otherPrivate } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (key: crypto.KeyObject, kid: string): AppleJwk => {
    const j = key.export({ format: 'jwk' }) as { n: string; e: string };
    return { kty: 'RSA', kid, use: 'sig', alg: 'RS256', n: j.n, e: j.e };
};
const keys: AppleJwk[] = [jwkOf(publicKey, 'kid-1'), jwkOf(otherPublic, 'kid-2')];
const fetchKeys = async () => keys;

const NOW = 1_800_000_000;
const AUD = ['com.thinkoff.codewatch.ios'];

function sign(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: crypto.KeyObject } = {}) {
    const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'kid-1' };
    const h = b64url(JSON.stringify(header));
    const p = b64url(JSON.stringify(claims));
    const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: opts.key ?? privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
    return `${h}.${p}.${b64url(sig)}`;
}
const base = { iss: APPLE_ISSUER, aud: 'com.thinkoff.codewatch.ios', exp: NOW + 600, iat: NOW - 10, sub: '001234.abcdef.5678' };

(async () => {
    console.log('\nValid tokens');
    const full = await verifyAppleIdToken(sign({ ...base, email: 'Person@PrivateRelay.AppleID.com', email_verified: 'true', is_private_email: 'true' }), AUD, fetchKeys, NOW);
    assert(full.ok && full.identity.sub === '001234.abcdef.5678', 'good token verifies, sub returned');
    assert(full.ok && full.identity.email === 'person@privaterelay.appleid.com', 'email lower-cased');
    assert(full.ok && full.identity.emailVerified && full.identity.isPrivateEmail, 'string "true" flags accepted');
    const noEmail = await verifyAppleIdToken(sign(base), AUD, fetchKeys, NOW);
    assert(noEmail.ok && noEmail.identity.email === null && !noEmail.identity.emailVerified, 'later sign-in without email -> email null');
    const audArray = await verifyAppleIdToken(sign({ ...base, aud: ['other', 'com.thinkoff.codewatch.ios'] }), AUD, fetchKeys, NOW);
    assert(audArray.ok, 'audience as array accepted when it contains ours');
    const kid2 = await verifyAppleIdToken(sign(base, { kid: 'kid-2', key: otherPrivate }), AUD, fetchKeys, NOW);
    assert(kid2.ok, 'second key in the set works');

    console.log('\nRejected tokens');
    const err = async (t: string) => { const r = await verifyAppleIdToken(t, AUD, fetchKeys, NOW); return r.ok ? 'OK' : r.error; };
    assert(await err(sign(base, { key: otherPrivate })) === 'bad signature', 'signed by a different key under a known kid -> bad signature');
    const good = sign(base);
    const [h, p] = good.split('.');
    assert(await err(`${h}.${b64url(JSON.stringify({ ...base, sub: 'evil' }))}.${good.split('.')[2]}`) === 'bad signature', 'tampered claims -> bad signature');
    assert(await err(`${h}.${p}.`) === 'bad signature', 'empty signature -> bad signature');
    assert(await err(sign(base, { kid: 'kid-9' })) === 'unknown kid', 'unknown kid');
    assert(await err(sign(base, { alg: 'HS256' })) === 'unsupported alg HS256', 'alg other than RS256 rejected before any key use');
    assert(await err(sign({ ...base, iss: 'https://accounts.google.com' })) === 'wrong issuer', 'wrong issuer');
    assert(await err(sign({ ...base, aud: 'com.example.other' })) === 'wrong audience', 'wrong audience');
    assert(await err(sign({ ...base, exp: NOW - 1 })) === 'expired', 'expired');
    assert(await err(sign({ ...base, iat: NOW + 3600 })) === 'issued in the future', 'iat far in the future');
    assert(await err(sign({ ...base, sub: '' })) === 'missing sub', 'missing sub');
    assert(await err('not.a.jwt.at.all') === 'malformed token', 'wrong part count');
    assert(await err('x') === 'malformed token', 'garbage');
    assert(await err(`${b64url('{not json')}.${p}.${good.split('.')[2]}`) === 'malformed header', 'unparseable header');

    console.log('\nNonce binding');
    const raw = 'c3d1f0a2-random-from-the-client';
    const withNonce = await verifyAppleIdToken(sign({ ...base, nonce: hashNonce(raw) }), AUD, fetchKeys, NOW);
    assert(withNonce.ok && withNonce.identity.nonce === hashNonce(raw) && withNonce.identity.exp === NOW + 600, 'nonce claim and exp surfaced');
    assert(noEmail.ok && noEmail.identity.nonce === null, 'no nonce claim -> null');
    assert(nonceMatches(raw, hashNonce(raw)), 'raw nonce matches its SHA-256 hex claim');
    assert(nonceMatches(raw, raw), 'raw nonce passed unhashed to Apple also matches');
    assert(!nonceMatches(raw, hashNonce('other')), 'different nonce rejected');
    assert(!nonceMatches(raw, null) && !nonceMatches('', hashNonce(raw)), 'missing claim or empty raw rejected');
    assert(!nonceMatches(raw, hashNonce(raw).slice(0, 60)), 'truncated claim rejected (length differs)');

    assert(hashNonce('abc') === crypto.createHash('sha256').update('abc').digest('hex') && hashNonce('abc').length === 64, 'hashNonce is SHA-256 hex');

    console.log('\nUnknown-kid refetch cooldown');
    resetUnknownKidRefetchGate();
    const t0 = 1_800_000_000_000;
    assert(unknownKidRefetchAllowed(t0), 'first unknown kid may refetch');
    assert(!unknownKidRefetchAllowed(t0 + 1000), 'a second unknown kid 1 s later may not');
    assert(!unknownKidRefetchAllowed(t0 + UNKNOWN_KID_REFETCH_COOLDOWN_MS - 1), 'still blocked just before the cooldown ends');
    assert(unknownKidRefetchAllowed(t0 + UNKNOWN_KID_REFETCH_COOLDOWN_MS), 'allowed again once the cooldown has passed');
    assert(!unknownKidRefetchAllowed(t0 + UNKNOWN_KID_REFETCH_COOLDOWN_MS + 5), 'and the window re-arms');
    let fetches = 0;
    const countingFetch = async () => { fetches++; return keys; };
    await verifyAppleIdToken(sign(base, { kid: 'kid-9' }), AUD, countingFetch, NOW);
    await verifyAppleIdToken(sign(base, { kid: 'kid-8' }), AUD, countingFetch, NOW);
    assert(fetches === 2, 'an injected fetcher is called once per verify and never refetched for unknown kids');

    console.log('\nparseAudiences');
    assert(parseAudiences(undefined).join(',') === 'com.thinkoff.codewatch.ios', 'default audience');
    assert(parseAudiences(' com.thinkoff.codewatch.ios , com.thinkoff.codewatch.dev ').join(',') === 'com.thinkoff.codewatch.ios,com.thinkoff.codewatch.dev', 'env adds, trims, de-dupes');

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
