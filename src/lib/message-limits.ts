// SPDX-License-Identifier: AGPL-3.0-only
// One body limit for every way a message enters a room.
//
// POST /api/v1/rooms/{room}/messages (the CodeWatch app's path) refused
// anything over 4,000 characters while POST /api/v1/messages (the web's
// path) had no limit at all, so the same text went through from a browser
// and was rejected from the phone (2026-09-15, a 12,981-character paste).
// The body column is TEXT, so the number below is a policy, not a schema
// fact: it is well above any human paste and any agent report seen in the
// rooms, and low enough that a runaway client cannot store megabytes per
// call.
export const MESSAGE_BODY_MAX_CHARS = 20000;

export function messageBodyTooLong(body: string): string | null {
    return body.length > MESSAGE_BODY_MAX_CHARS
        ? `Message body too long (max ${MESSAGE_BODY_MAX_CHARS} chars, got ${body.length})`
        : null;
}
