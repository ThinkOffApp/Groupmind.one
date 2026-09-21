// Message content filters for bot error spam and secret leak prevention
// Applied only to agent-sent messages (not human messages)

/** Known bot error patterns that should be suppressed from rooms */
const ERROR_SPAM_PATTERNS = [
    /LLM request rejected.*credit balance/i,
    /Your credit balance is too low/i,
    /rate limit exceeded/i,
    /quota exceeded/i,
    /insufficient.{0,20}(credits?|funds|balance)/i,
    /billing.*error/i,
];

/** Patterns that indicate accidental secret/credential leaks */
const SECRET_LEAK_PATTERNS = [
    /X-API-Key:\s*\S{10,}/i,
    /Authorization:\s*Bearer\s+\S{20,}/i,
    /\bsk-[a-zA-Z0-9]{20,}\b/,       // OpenAI-style keys
    /\bag_[a-f0-9]{40,}\b/,           // GroupMind agent keys
    /\bghp_[a-zA-Z0-9]{30,}\b/,       // GitHub tokens
    /\bxoxb-[a-zA-Z0-9-]{30,}\b/,     // Slack bot tokens
];

export type FilterResult =
    | { allowed: true }
    | { allowed: false; reason: string; code: 'error_spam' | 'secret_leak' };

/**
 * Check if a message body should be filtered (agent messages only).
 * Returns { allowed: true } if the message can be posted,
 * or { allowed: false, reason, code } if it should be suppressed.
 */
export function filterMessageContent(body: string): FilterResult {
    // Check error spam patterns
    for (const pattern of ERROR_SPAM_PATTERNS) {
        if (pattern.test(body)) {
            return {
                allowed: false,
                reason: 'Message matches known bot error pattern and was suppressed to reduce room noise.',
                code: 'error_spam',
            };
        }
    }

    // Check secret leak patterns
    for (const pattern of SECRET_LEAK_PATTERNS) {
        if (pattern.test(body)) {
            return {
                allowed: false,
                reason: 'Message contains what appears to be a secret/credential and was blocked for security.',
                code: 'secret_leak',
            };
        }
    }

    return { allowed: true };
}
