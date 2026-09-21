import crypto from 'crypto';

/**
 * Blind index for message search.
 *
 * Private-room bodies are encrypted at rest, so search used to decrypt and scan
 * every row — 27 s for a rare word. Here each distinct word of a message is
 * stored as a KEYED HASH, never as text: a database dump still reveals no
 * message content, while an exact-word lookup becomes one indexed query.
 *
 * The key is derived from ROOM_ENCRYPTION_KEY rather than being a new secret,
 * so there is nothing extra to generate, store or rotate. Deriving (rather than
 * reusing directly) keeps the index key useless for decrypting messages.
 */

const INDEX_INFO = 'search-index-v1';
const HASH_BYTES = 12;          // 96 bits: collision-safe here, keeps the table small
const MIN_TOKEN = 2;
const MAX_TOKENS_PER_MESSAGE = 400;   // a runaway paste should not write 50k rows

let cachedKey: Buffer | null | undefined;

function indexKey(): Buffer | null {
    if (cachedKey !== undefined) return cachedKey;
    const hex = process.env.ROOM_ENCRYPTION_KEY?.trim();
    if (!hex || hex.length !== 64) {
        // Same posture as lib/crypto: no key means the feature is off, not that
        // we silently fall back to something weaker.
        console.warn('[SearchIndex] ROOM_ENCRYPTION_KEY missing or wrong length – blind index disabled');
        cachedKey = null;
        return null;
    }
    cachedKey = crypto.createHmac('sha256', Buffer.from(hex, 'hex')).update(INDEX_INFO).digest();
    return cachedKey;
}

export function isIndexEnabled(): boolean {
    return indexKey() !== null;
}

/**
 * Words as a human would search for them. Unicode-aware, so Finnish and Swedish
 * letters survive: splitting on /\W/ would cut "sääasema" into pieces.
 */
export function tokenize(text: string): string[] {
    if (!text) return [];
    const seen = new Set<string>();
    for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (raw.length < MIN_TOKEN) continue;
        seen.add(raw);
        if (seen.size >= MAX_TOKENS_PER_MESSAGE) break;
    }
    return [...seen];
}

/** Keyed hash of one word, as the `\x…` hex literal Postgres wants for bytea. */
export function hashToken(token: string): string | null {
    const key = indexKey();
    if (!key) return null;
    const mac = crypto.createHmac('sha256', key).update(token).digest().subarray(0, HASH_BYTES);
    return '\\x' + mac.toString('hex');
}

export function hashTokens(tokens: string[]): string[] {
    const key = indexKey();
    if (!key) return [];
    return tokens.map(t => hashToken(t)!).filter(Boolean);
}

/**
 * Whether the blind index can answer this query at all.
 *
 * The index holds whole words. A query with punctuation, spaces or a partial
 * word is NOT answerable from it, and the caller must fall back to scanning —
 * returning index-only results for those would silently lose matches.
 */
export function isIndexableQuery(q: string): boolean {
    const t = tokenize(q);
    return t.length === 1 && t[0] === q.trim().toLowerCase();
}
