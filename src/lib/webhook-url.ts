// SPDX-License-Identifier: AGPL-3.0-only
// SSRF guard for agent-provided webhook URLs.
// Keep this Edge-compatible: avoid node:dns/net so it can run in route handlers and webhook helpers.

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

function isIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  return parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function isBlockedIPv4(hostname: string): boolean {
  if (!isIPv4(hostname)) return false;
  const [a, b] = hostname.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isBlockedIPv6(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === '::1' ||
    h === '::' ||
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    h.startsWith('fe80:') ||
    h.startsWith('0:0:0:0:0:0:0:1')
  );
}

function isLinkLocal(hostname: string): boolean {
  if (isIPv4(hostname)) {
    const [a, b] = hostname.split('.').map(Number);
    return a === 169 && b === 254;
  }
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').startsWith('fe80:');
}

export function validateWebhookUrl(value: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (value === null || value === undefined || value === '') return { ok: true, url: '' };
  if (typeof value !== 'string') return { ok: false, error: 'webhook_url must be a string' };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'Invalid webhook_url format' };
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    return { ok: false, error: 'webhook_url must use http or https' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return { ok: false, error: 'webhook_url host is not allowed' };

  // On a SELF-HOSTED instance, a private address is the normal answer, not an
  // attack. The agent runs on the operator's own laptop or on their LAN, so its
  // callback is http://localhost:8080 or http://192.168.1.x - exactly what this
  // guard exists to reject. Refusing it there is not security, it is the
  // product failing to do the one thing the operator installed it for.
  //
  // It stays REJECTED BY DEFAULT, because on a shared or public instance this
  // is a genuine SSRF vector: an attacker registers an agent whose webhook
  // points at 169.254.169.254 and reads the cloud metadata service through the
  // server. Opening that must be a deliberate act by whoever runs the instance,
  // so it is one environment variable, off unless set:
  //
  //   ALLOW_PRIVATE_WEBHOOK_URLS=1
  //
  // Set it only when every account on the instance is someone you trust.
  const allowPrivate = process.env.ALLOW_PRIVATE_WEBHOOK_URLS === '1';

  if (!allowPrivate) {
    if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost')) {
      return { ok: false, error: 'webhook_url host is not allowed' };
    }
    if (isBlockedIPv4(hostname) || isBlockedIPv6(hostname)) {
      return { ok: false, error: 'webhook_url must not target private, loopback, link-local, multicast, or reserved IP ranges' };
    }
  } else if (isLinkLocal(hostname)) {
    // Not covered by the opt-in. 169.254.0.0/16 is the cloud metadata range and
    // is never a legitimate webhook target on anybody's LAN, so this one stays
    // shut even for a trusted single-operator instance.
    return { ok: false, error: 'webhook_url must not target the link-local range' };
  }

  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}
