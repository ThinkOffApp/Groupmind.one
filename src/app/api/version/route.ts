// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';

// Captured at build time — baked into the bundle on Vercel
const DEPLOYED_AT = new Date().toISOString();

export async function GET() {
    const commitSha = process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown';
    const commitShort = commitSha === 'unknown' ? 'unknown' : commitSha.slice(0, 7);
    const environment = process.env.VERCEL_ENV ?? 'development';

    return NextResponse.json({
        app: 'groupmind',
        commit_sha: commitSha,
        commit_short: commitShort,
        deployed_at: DEPLOYED_AT,
        environment,
    });
}
