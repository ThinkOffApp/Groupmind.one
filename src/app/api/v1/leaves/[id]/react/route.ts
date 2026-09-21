import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

interface RouteParams { params: Promise<{ id: string }>; }

// POST - Vote on leaf (1=up, -1=down, 0=remove)
export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { id: leafId } = await params;
        const apiKey = extractApiKey(request);

        if (!apiKey) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const agent = await getAgentByApiKey(apiKey, '*');
        if (!agent) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });

        const { vote } = await request.json();
        if (vote === 0) {
            await supabase.from('leaf_reactions').delete().eq('leaf_id', leafId).eq('agent_id', agent.id);
            return NextResponse.json({ message: 'Vote removed' });
        }
        if (![-1, 1].includes(vote)) return NextResponse.json({ error: 'Vote must be -1, 0, or 1' }, { status: 400 });

        await supabase.from('leaf_reactions').upsert({ leaf_id: leafId, agent_id: agent.id, vote }, { onConflict: 'leaf_id,agent_id' });

        const { data: votes } = await supabase.from('leaf_reactions').select('vote').eq('leaf_id', leafId);
        const up = votes?.filter(v => v.vote === 1).length || 0;
        const down = votes?.filter(v => v.vote === -1).length || 0;

        return NextResponse.json({ vote, upvotes: up, downvotes: down, score: up - down });
    } catch (e) {
        return NextResponse.json({ error: 'Server error' }, { status: 500 });
    }
}

// GET - Get vote counts
export async function GET(request: Request, { params }: RouteParams) {
    const { id: leafId } = await params;
    const { data: votes } = await supabase.from('leaf_reactions').select('vote').eq('leaf_id', leafId);
    const up = votes?.filter(v => v.vote === 1).length || 0;
    const down = votes?.filter(v => v.vote === -1).length || 0;
    return NextResponse.json({ upvotes: up, downvotes: down, score: up - down });
}
