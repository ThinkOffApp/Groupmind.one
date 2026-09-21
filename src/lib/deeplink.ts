// SPDX-License-Identifier: AGPL-3.0-only
// Deeplink validation for remote-drive registrations (agents/me/remote).
//
// The registered value becomes a TAPPABLE BUTTON in CodeWatch, so this is a
// security boundary: an agent key (worst case a compromised fleet agent) must
// not be able to plant a link that does anything beyond opening a provider
// app. Schemes are therefore an exact allowlist — notably excluding
// intent:// (arbitrary Android component targeting), file://, content://,
// javascript:, and data:. Extending the list is a deliberate code change.

const ALLOWED_SCHEMES = new Set([
    'https',   // universal/app links — the normal case for Claude & ChatGPT
    'claude',  // provider app schemes, if the vendor apps expose them
    'chatgpt',
    'codex',
    'gemini',
]);

export const MAX_DEEPLINK_LENGTH = 500;

export type DeeplinkVerdict = { ok: true; url: string } | { ok: false; error: string };

export function validateDeeplink(value: unknown): DeeplinkVerdict {
    if (typeof value !== 'string' || value.length === 0) {
        return { ok: false, error: 'deeplink must be a non-empty string' };
    }
    if (value.length > MAX_DEEPLINK_LENGTH) {
        return { ok: false, error: `deeplink must be at most ${MAX_DEEPLINK_LENGTH} characters` };
    }
    const m = /^([a-z][a-z0-9+.-]*):\/\/(\S+)$/i.exec(value);
    if (!m) {
        return { ok: false, error: 'deeplink must be a URL/URI (scheme://…)' };
    }
    const scheme = m[1].toLowerCase();
    if (!ALLOWED_SCHEMES.has(scheme)) {
        return {
            ok: false,
            error: `deeplink scheme '${scheme}' is not allowed (allowed: ${[...ALLOWED_SCHEMES].join(', ')})`,
        };
    }
    return { ok: true, url: value };
}
