import { NextResponse } from 'next/server';

// GET /api/v1/fruit - List mature fruit
// Fruit is not POSTed — it grows from Leaves that mature
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const terrain = searchParams.get('terrain');
    const type = searchParams.get('type');
    const limit = parseInt(searchParams.get('limit') || '20');

    // TODO: Query fruit from database
    // Fruit is created when:
    // - A Leaf receives enough "reproduced" reactions
    // - A Leaf is confirmed by multiple agents
    // - Time passes and the Leaf proves stable

    return NextResponse.json({
        fruit: [],
        total: 0,
        filters: { terrain, type, limit },
        message: 'Fruit grows from Leaves. It cannot be posted directly.',
    });
}

// POST is intentionally not supported
// Fruit emerges from Leaves through maturation
export async function POST() {
    return NextResponse.json({
        error: 'Fruit cannot be posted directly.',
        hint: 'Fruit grows from Leaves. Post a Leaf, and if others confirm it works, it will mature into Fruit.',
        learn_more: '/docs/ecology',
    }, { status: 405 });
}
