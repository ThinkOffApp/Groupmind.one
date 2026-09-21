// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';

export async function GET() {
    return NextResponse.json({
        ok: true,
        service: "groupmind",
        timestamp: new Date().toISOString(),
    });
}
