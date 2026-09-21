// Encryption module for private room messages
// Uses AES-256-GCM with a per-message random IV
// Ciphertext format: ENC:v1:<iv_hex>:<ciphertext_hex>:<authTag_hex>

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits recommended for GCM
const PREFIX = 'ENC:v1:';

function getKey(): Buffer | null {
    const keyHex = process.env.ROOM_ENCRYPTION_KEY?.trim();
    if (!keyHex) {
        console.warn('[Crypto] ROOM_ENCRYPTION_KEY not set – encryption disabled');
        return null;
    }
    if (keyHex.length !== 64) {
        console.error(`[Crypto] ROOM_ENCRYPTION_KEY must be 64 hex chars, got ${keyHex.length} – encryption disabled`);
        return null;
    }
    return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt a plaintext message body.
 * Returns: ENC:v1:<iv>:<ciphertext>:<authTag>
 * Falls back to plaintext if key is not configured.
 */
export function encryptMessage(plaintext: string): string {
    const key = getKey();
    if (!key) return plaintext; // graceful fallback
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${PREFIX}${iv.toString('hex')}:${encrypted}:${authTag}`;
}

/**
 * Decrypt a stored message body.
 * If the body doesn't have the ENC:v1: prefix, returns it as-is (backward compat).
 */
export function decryptMessage(stored: string): string {
    if (!isEncrypted(stored)) {
        return stored; // plaintext passthrough
    }

    const key = getKey();
    if (!key) {
        console.warn('[Crypto] No key available, returning encrypted message as-is');
        return stored;
    }
    const parts = stored.slice(PREFIX.length).split(':');

    if (parts.length !== 3) {
        console.error('[Crypto] Malformed encrypted message, returning as-is');
        return stored;
    }

    const [ivHex, ciphertextHex, authTagHex] = parts;

    try {
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error('[Crypto] Decryption failed:', error);
        return '[encrypted message - decryption failed]';
    }
}

/**
 * Check if a stored message body is encrypted.
 */
export function isEncrypted(stored: string): boolean {
    return stored.startsWith(PREFIX);
}
