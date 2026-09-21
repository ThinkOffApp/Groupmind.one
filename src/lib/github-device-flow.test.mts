// Unit test for the GitHub device flow.
// Run: npx tsx src/lib/github-device-flow.test.mts
//
// No real token is needed and none is used: `fetchImpl` is injected, so every
// state GitHub can answer with is exercised against a stub. What has NOT run
// here is a real round trip to github.com - see the PR body.

import { pollDeviceToken, requestDeviceCode, VERIFICATION_URL } from './github-device-flow';

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

interface Call {
    url: string;
    body: string;
}

function stub(reply: { status?: number; json?: unknown; text?: string }) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: unknown, init: any) => {
        calls.push({ url: String(url), body: String(init?.body ?? '') });
        const text = reply.text ?? JSON.stringify(reply.json ?? {});
        return {
            ok: (reply.status ?? 200) >= 200 && (reply.status ?? 200) < 300,
            status: reply.status ?? 200,
            text: async () => text,
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
}

const CLIENT = 'Iv23liTESTCLIENTID';

console.log('\nrequestDeviceCode');
{
    const { calls, fetchImpl } = stub({
        json: {
            user_code: 'WDJB-MJHT',
            device_code: 'dev-code-123',
            verification_uri: 'https://github.com/login/device',
            interval: 7,
            expires_in: 899,
        },
    });
    const code = await requestDeviceCode({ clientId: CLIENT, fetchImpl });
    assert(code.userCode === 'WDJB-MJHT', 'returns the user code the person must type');
    assert(code.deviceCode === 'dev-code-123', 'returns the device code the server keeps');
    assert(code.intervalSec === 7 && code.expiresInSec === 899, 'honours GitHub interval and expiry');
    assert(calls[0].url === 'https://github.com/login/device/code', 'posts to the device-code endpoint');
    assert(calls[0].body.includes(`client_id=${CLIENT}`), 'sends the client id');
    assert(!calls[0].body.includes('scope'), 'sends NO scope by default - a GitHub App carries its own permissions');
}
{
    const { calls, fetchImpl } = stub({ json: { user_code: 'A', device_code: 'B' } });
    const code = await requestDeviceCode({ clientId: CLIENT, scope: 'public_repo', fetchImpl });
    assert(calls[0].body.includes('scope=public_repo'), 'sends a scope when one is configured (OAuth App path)');
    assert(code.verificationUri === VERIFICATION_URL, 'falls back to the documented verification URL');
    assert(code.intervalSec === 5, 'defaults the interval to 5s when GitHub omits it');
}
{
    const { fetchImpl } = stub({ status: 500, text: 'boom' });
    let threw = '';
    try {
        await requestDeviceCode({ clientId: CLIENT, fetchImpl });
    } catch (e) {
        threw = e instanceof Error ? e.message : '';
    }
    assert(threw.includes('500'), 'an HTTP failure throws with the status');
    assert(!threw.includes('boom'), 'and never echoes the response body, which is how tokens reach logs');
}
{
    const { fetchImpl } = stub({ json: { device_code: 'only-half' } });
    let threw = false;
    try {
        await requestDeviceCode({ clientId: CLIENT, fetchImpl });
    } catch {
        threw = true;
    }
    assert(threw, 'a half-formed response throws rather than showing an empty code');
}

console.log('\npollDeviceToken: all four documented waiting/failure states');
{
    const cases: Array<[string, string, Record<string, unknown>]> = [
        ['authorization_pending', 'pending', { error: 'authorization_pending' }],
        ['slow_down', 'slow_down', { error: 'slow_down', interval: 13 }],
        ['expired_token', 'expired', { error: 'expired_token' }],
        ['access_denied', 'denied', { error: 'access_denied' }],
    ];
    for (const [ghError, expected, json] of cases) {
        const { fetchImpl } = stub({ json });
        const r = await pollDeviceToken('dev-code', { clientId: CLIENT, fetchImpl });
        assert(r.status === expected, `${ghError} -> ${expected}`);
    }
    const { fetchImpl } = stub({ json: { error: 'slow_down', interval: 13 } });
    const slow = await pollDeviceToken('dev-code', { clientId: CLIENT, fetchImpl });
    assert(slow.status === 'slow_down' && slow.intervalSec === 13, 'slow_down carries GitHub’s new interval');
}
{
    const { calls, fetchImpl } = stub({ json: { access_token: 'ghu_stub_token', token_type: 'bearer' } });
    const r = await pollDeviceToken('dev-code', { clientId: CLIENT, fetchImpl });
    assert(r.status === 'token' && r.token === 'ghu_stub_token', 'a granted token comes back');
    assert(
        calls[0].body.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code'),
        'sends the device-code grant type'
    );
    assert(calls[0].body.includes('device_code=dev-code'), 'sends the device code');
}
{
    const { fetchImpl } = stub({ json: { error: 'unsupported_grant_type', error_description: 'nope' } });
    const r = await pollDeviceToken('dev-code', { clientId: CLIENT, fetchImpl });
    assert(r.status === 'error' && r.message === 'nope', 'an undocumented error surfaces its description');
}
{
    const fetchImpl = (async () => {
        throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await pollDeviceToken('dev-code', { clientId: CLIENT, fetchImpl });
    assert(r.status === 'pending', 'a network blip mid-poll is pending, not fatal - the person is walking to another device');
}

console.log('\nThe module never logs');
{
    const seen: string[] = [];
    const real = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    for (const k of Object.keys(real) as Array<keyof typeof real>) {
        (console as any)[k] = (...args: unknown[]) => seen.push(args.map(String).join(' '));
    }
    const { fetchImpl } = stub({ json: { access_token: 'ghu_secret_should_never_be_logged' } });
    await pollDeviceToken('dev-code', { clientId: CLIENT, fetchImpl });
    for (const k of Object.keys(real) as Array<keyof typeof real>) (console as any)[k] = real[k];

    assert(seen.length === 0, 'a successful poll writes nothing to the console');
    assert(
        !seen.join('\n').includes('ghu_secret_should_never_be_logged'),
        'and the token is nowhere in captured output'
    );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
