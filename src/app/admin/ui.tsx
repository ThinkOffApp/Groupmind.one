// Shared server-rendered UI for the unified /admin area.
// No client components here — admin data never leaves the server unrendered.

import Link from 'next/link';
import { adminLogin, adminLogout } from './actions';

export function fmtDateTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
    });
}

export function fmtStatValue(value: string | number): string {
    return typeof value === 'number' ? value.toLocaleString('en-US') : value;
}

export function StatTile({
    label,
    value,
    hint,
}: {
    label: string;
    value: string | number;
    hint?: string;
}) {
    return (
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
            <div className="text-sm text-gray-400">{label}</div>
            <div className="text-3xl font-semibold text-white mt-1 tabular-nums">
                {fmtStatValue(value)}
            </div>
            {hint && <div className="text-xs text-gray-500 mt-1">{hint}</div>}
        </div>
    );
}

/**
 * Shared login form for every /admin page. Deliberately generic: it renders
 * identically whether or not ADMIN_DASHBOARD_PASSWORD is configured, so
 * unauthenticated visitors learn nothing about server configuration.
 */
export function LoginForm({ error, next }: { error: boolean; next: string }) {
    return (
        <div className="max-w-md mx-auto px-6 py-24">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-8 space-y-6">
                <div>
                    <h1 className="text-2xl font-semibold text-white">ThinkOff admin</h1>
                    <p className="text-gray-400 text-sm mt-2">
                        Enter the admin password to view apps and usage stats.
                    </p>
                </div>

                {error && (
                    <div className="bg-red-950/30 border border-red-500/30 rounded-lg p-3 text-sm text-red-200">
                        Invalid password.
                    </div>
                )}

                <form action={adminLogin} className="space-y-4">
                    <input type="hidden" name="next" value={next} />
                    <input
                        type="password"
                        name="password"
                        placeholder="Admin password"
                        autoFocus
                        autoComplete="current-password"
                        className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-[var(--primary)]"
                    />
                    <button
                        type="submit"
                        className="w-full bg-[var(--primary)]/90 hover:bg-[var(--primary)] text-black font-medium rounded-lg px-4 py-3 transition-colors"
                    >
                        Sign in
                    </button>
                </form>
            </div>
        </div>
    );
}

/** Page header with optional back link and the shared sign-out button. */
export function AdminHeader({
    title,
    subtitle,
    backHref,
}: {
    title: string;
    subtitle?: string;
    backHref?: string;
}) {
    return (
        <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
                {backHref && (
                    <Link
                        href={backHref}
                        className="text-sm text-gray-400 hover:text-white transition-colors"
                    >
                        ← All apps
                    </Link>
                )}
                <h1 className="text-3xl font-bold text-white">{title}</h1>
                {subtitle && <p className="text-gray-400 text-sm mt-1">{subtitle}</p>}
            </div>
            <form action={adminLogout}>
                <button
                    type="submit"
                    className="text-sm text-gray-400 hover:text-white border border-white/10 rounded-lg px-4 py-2 transition-colors"
                >
                    Sign out
                </button>
            </form>
        </div>
    );
}
