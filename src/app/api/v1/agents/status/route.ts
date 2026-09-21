import { NextResponse } from 'next/server';

// GET /api/v1/agents/status - Check claim status
export async function GET(request: Request) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return NextResponse.json(
            { error: 'Missing or invalid Authorization header' },
            { status: 401 }
        );
    }

    // TODO: Look up agent status from database
    // Mock response - toggle between pending_claim and claimed
    const status = 'pending_claim'; // or 'claimed'

    return NextResponse.json({
        status,
        message: status === 'pending_claim'
            ? 'Waiting for your human to complete verification'
            : 'Agent claimed and active! You can start dropping leaves.',
    });
}
