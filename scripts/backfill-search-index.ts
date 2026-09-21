/**
 * One-off backfill for the blind search index.
 *
 * Walks room messages oldest-first, decrypts each body, and writes the keyed
 * word hashes. Safe to re-run and safe to interrupt: rows are upserted on
 * (message_id, token_hash), so a second run continues rather than duplicating.
 *
 *   npx tsx scripts/backfill-search-index.ts [--room <slug>] [--batch 500]
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
 * ROOM_ENCRYPTION_KEY from the environment or .env.local.
 */
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import fs from 'fs';

if (fs.existsSync('.env.local')) {
    for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const encHex = process.env.ROOM_ENCRYPTION_KEY?.trim();
if (!url || !key) { console.error('Missing Supabase env'); process.exit(2); }
if (!encHex || encHex.length !== 64) { console.error('ROOM_ENCRYPTION_KEY missing or not 64 hex chars'); process.exit(2); }

const supabase = createClient(url, key);
const encKey = Buffer.from(encHex, 'hex');
const indexKey = crypto.createHmac('sha256', encKey).update('search-index-v1').digest();

function decrypt(v: unknown): string {
    if (typeof v !== 'string' || !v.startsWith('ENC:v1:')) return typeof v === 'string' ? v : '';
    try {
        const raw = Buffer.from(v.slice(7), 'base64');
        const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
        const d = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(data), d.final()]).toString('utf8');
    } catch { return ''; }
}
const tokenize = (t: string): string[] => {
    const s = new Set<string>();
    for (const w of (t || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 2) s.add(w);
    return [...s].slice(0, 400);
};
const hash = (w: string): string => '\\x' + crypto.createHmac('sha256', indexKey).update(w).digest().subarray(0, 12).toString('hex');

const args = process.argv.slice(2);
const roomSlug = args.includes('--room') ? args[args.indexOf('--room') + 1] : null;
const BATCH = args.includes('--batch') ? Number(args[args.indexOf('--batch') + 1]) : 500;

let roomId: string | null = null;
if (roomSlug) {
    const { data } = await supabase.from('rooms').select('id').eq('slug', roomSlug).single();
    if (!data) { console.error('room not found:', roomSlug); process.exit(2); }
    roomId = data.id;
}

let cursor = '1970-01-01T00:00:00Z', done = 0, rows = 0;
for (;;) {
    let q = supabase.from('messages')
        .select('id, room_id, body, created_at')
        .not('room_id', 'is', null)
        .gt('created_at', cursor)
        .order('created_at', { ascending: true })
        .limit(BATCH);
    if (roomId) q = q.eq('room_id', roomId);

    const { data, error } = await q;
    if (error) { console.error(error.message); process.exit(1); }
    if (!data || data.length === 0) break;

    const payload = [];
    for (const m of data) {
        for (const w of tokenize(decrypt(m.body))) {
            payload.push({ message_id: m.id, room_id: m.room_id, token_hash: hash(w), created_at: m.created_at });
        }
    }
    for (let i = 0; i < payload.length; i += 1000) {
        const { error: e } = await supabase.from('message_search_tokens')
            .upsert(payload.slice(i, i + 1000), { onConflict: 'message_id,token_hash', ignoreDuplicates: true });
        if (e) { console.error('insert failed:', e.message); process.exit(1); }
    }
    rows += payload.length;
    done += data.length;
    cursor = data[data.length - 1].created_at;
    console.log(`${done} messages, ${rows} token rows, at ${cursor}`);
    if (data.length < BATCH) break;
}
console.log(`done: ${done} messages, ${rows} token rows`);
