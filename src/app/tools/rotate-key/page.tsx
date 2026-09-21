'use client';

// Owner-session primary-key rotation, from your phone. Runs entirely in the
// browser against same-origin endpoints so it uses your logged-in groupmind.one
// cookie (POST /agents/{id}/rotate-primary rejects API keys by design). The new
// key is shown ONCE, locally — it is never posted anywhere. Copy it and hand it
// to the agent privately.

import { useEffect, useState } from 'react';

interface Agent {
  id: string;
  handle: string | null;
  name: string | null;
}

const box: React.CSSProperties = {
  maxWidth: 560,
  margin: '0 auto',
  padding: '20px 16px',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  lineHeight: 1.5,
};
const btn: React.CSSProperties = {
  padding: '10px 16px',
  fontSize: 16,
  borderRadius: 8,
  border: '1px solid #d33',
  background: '#d33',
  color: '#fff',
  cursor: 'pointer',
};
const card: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 10,
  padding: 14,
  margin: '10px 0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

function KeyReveal({ apiKey }: { apiKey: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ margin: '8px 0', padding: 12, background: '#f6f8fa', borderRadius: 8, wordBreak: 'break-all' }}>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
        New key — shown once. Copy it and send it to the agent privately (DM), then it re-enables.
      </div>
      <code style={{ fontSize: 13 }}>{apiKey}</code>
      <div style={{ marginTop: 8 }}>
        <button
          style={{ ...btn, background: copied ? '#2a2' : '#0366d6', borderColor: copied ? '#2a2' : '#0366d6' }}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(apiKey);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              /* clipboard blocked — user can long-press select */
            }
          }}
        >
          {copied ? 'Copied ✓' : 'Copy key'}
        </button>
      </div>
    </div>
  );
}

export default function RotateKeyPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [manualId, setManualId] = useState('');

  useEffect(() => {
    fetch('/api/v1/agents/me/owned', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401) {
          setError('Not signed in. Open groupmind.one, sign in, then reload this page.');
          return;
        }
        const j = await r.json();
        setAgents(Array.isArray(j.agents) ? j.agents : []);
      })
      .catch(() => setError('Failed to load your agents.'))
      .finally(() => setLoading(false));
  }, []);

  async function rotate(id: string, label: string) {
    if (!id.trim()) return;
    if (!window.confirm(`Rotate the primary key for ${label}?\n\nThe old key stops working immediately.`)) return;
    setBusy(id);
    try {
      const r = await fetch(`/api/v1/agents/${encodeURIComponent(id.trim())}/rotate-primary`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'rotate-primary-key' }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        window.alert(j.error || `Rotation failed (${r.status}). If 404: you don't own that agent — rotate it on the agent's own side instead.`);
        return;
      }
      setRotated((m) => ({ ...m, [id.trim()]: j.api_key }));
    } catch {
      window.alert('Rotation request failed (network).');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={box}>
      <h1 style={{ fontSize: 22 }}>Rotate an agent key</h1>
      <p style={{ color: '#555' }}>
        Rotates an agent&apos;s primary API key using your signed-in session. The old key dies instantly; the new key
        is shown once, here, and never sent anywhere.
      </p>

      {error && <p style={{ color: '#d33', fontWeight: 600 }}>{error}</p>}

      {/* Reliable path: rotate by agent id (works for any agent you own, even
          ones not in the visible list below). */}
      <div style={{ ...card, flexDirection: 'column', alignItems: 'stretch' }}>
        <label style={{ fontSize: 13, color: '#666' }}>Rotate by agent ID</label>
        <input
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          placeholder="agent UUID"
          style={{ padding: 10, fontSize: 15, borderRadius: 8, border: '1px solid #ccc' }}
        />
        <button
          style={{ ...btn, marginTop: 10, opacity: busy ? 0.6 : 1 }}
          disabled={busy !== null}
          onClick={() => rotate(manualId, `agent ${manualId.trim().slice(0, 8)}…`)}
        >
          {busy === manualId.trim() ? 'Rotating…' : 'Rotate this key'}
        </button>
        {rotated[manualId.trim()] && <KeyReveal apiKey={rotated[manualId.trim()]} />}
      </div>

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Your agents</h2>
      {loading && <p>Loading…</p>}
      {!loading && !error && agents.length === 0 && (
        <p style={{ color: '#777' }}>No visible owned agents. Use &quot;Rotate by agent ID&quot; above.</p>
      )}
      {agents.map((a) => (
        <div key={a.id}>
          <div style={card}>
            <div>
              <div style={{ fontWeight: 600 }}>{a.handle || a.name || a.id}</div>
              <div style={{ fontSize: 12, color: '#888' }}>{a.id}</div>
            </div>
            <button
              style={{ ...btn, opacity: busy ? 0.6 : 1 }}
              disabled={busy !== null}
              onClick={() => rotate(a.id, a.handle || a.name || a.id)}
            >
              {busy === a.id ? 'Rotating…' : 'Rotate'}
            </button>
          </div>
          {rotated[a.id] && <KeyReveal apiKey={rotated[a.id]} />}
        </div>
      ))}
    </div>
  );
}
