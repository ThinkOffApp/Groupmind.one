// SPDX-License-Identifier: AGPL-3.0-only
// Unit test for how the GitHub token is stored.
// Run: npx tsx src/lib/github-session.test.mts
//
// The cookie codec and the cookie flags are the token-storage decision in
// code: httpOnly so page JavaScript can never read it, and bound to the
// signed-in user so a shared browser does not hand person B person A's
// ability to merge.

import {
    GITHUB_TOKEN_COOKIE,
    cookieOptions,
    decodeDeviceCookie,
    decodeTokenCookie,
    encodeDeviceCookie,
    encodeTokenCookie,
} from './github-session';

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

const TOKEN = 'ghu_example_token_value';

console.log('\nThe cookie flags ARE the storage decision');
{
    const prod = process.env.NODE_ENV;
    const opts = cookieOptions(60);
    assert(opts.httpOnly === true, 'httpOnly - page JavaScript can never read the token');
    assert(opts.sameSite === 'lax', 'SameSite=lax - a cross-site page cannot make the browser spend it');
    assert(opts.path === '/', 'scoped to the whole app, which is where the API routes live');
    assert(opts.maxAge === 60, 'maxAge is whatever the caller asked for');

    // `secure` is dropped outside production so `next dev` over http works.
    (process.env as any).NODE_ENV = 'production';
    assert(cookieOptions(60).secure === true, 'Secure in production');
    (process.env as any).NODE_ENV = 'development';
    assert(cookieOptions(60).secure === false, 'not Secure in development, so next dev over http still works');
    (process.env as any).NODE_ENV = prod;
}

console.log('\nThe token cookie is bound to one user');
{
    const raw = encodeTokenCookie({ token: TOKEN, userId: 'user-a' });
    const back = decodeTokenCookie(raw);
    assert(back?.token === TOKEN && back?.userId === 'user-a', 'round-trips the token and the user it belongs to');
    assert(
        !raw.includes(TOKEN),
        'the cookie value is not the bare token, so a casual glance at a cookie jar does not read as a credential'
    );
    assert(GITHUB_TOKEN_COOKIE === 'gm_gh_token', 'the cookie has a stable name');
}

console.log('\nA malformed cookie is no cookie');
{
    assert(decodeTokenCookie(undefined) === null, 'missing -> null');
    assert(decodeTokenCookie('') === null, 'empty -> null');
    assert(decodeTokenCookie('not-base64-json') === null, 'junk -> null');
    assert(decodeTokenCookie(Buffer.from('"a string"').toString('base64url')) === null, 'a non-object -> null');
    assert(decodeTokenCookie(Buffer.from('{"t":"x"}').toString('base64url')) === null, 'a token with no user -> null');
    assert(decodeTokenCookie(Buffer.from('{"u":"user-a"}').toString('base64url')) === null, 'a user with no token -> null');
    assert(decodeTokenCookie(Buffer.from('{"t":"","u":"user-a"}').toString('base64url')) === null, 'an empty token -> null');
}

console.log('\nThe device cookie behaves the same way');
{
    const raw = encodeDeviceCookie({ deviceCode: 'dev-123', userId: 'user-a' });
    const back = decodeDeviceCookie(raw);
    assert(back?.deviceCode === 'dev-123' && back?.userId === 'user-a', 'round-trips the device code and its user');
    assert(decodeDeviceCookie('junk') === null, 'junk -> null');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
