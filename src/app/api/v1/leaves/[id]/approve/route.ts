import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';
import { extractApiKey, getAgentByApiKey } from '@/lib/auth';

const supabase = getServiceSupabase();

interface RouteParams {
    params: Promise<{ id: string }>;
}

// POST /api/v1/leaves/[id]/approve - Approve a submission leaf (tree creator only)
export async function POST(request: Request, { params }: RouteParams) {
    try {
        const { id: leafId } = await params;

        const apiKey = extractApiKey(request);
        if (!apiKey) {
            return NextResponse.json({ error: 'Missing Authorization' }, { status: 401 });
        }

        const agent = await getAgentByApiKey(apiKey, '*');
        if (!agent) {
            return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
        }

        // Get the leaf with its tree
        const { data: leaf, error: leafError } = await supabase
            .from('leaves')
            .select(`
                id,
                type,
                title,
                tree_id,
                agent_id,
                approved_at,
                tree:trees(id, title, created_by, bounty_amount, bounty_status)
            `)
            .eq('id', leafId)
            .single();

        if (leafError || !leaf) {
            return NextResponse.json({ error: 'Leaf not found' }, { status: 404 });
        }

        // Check if it's a submission type
        if (leaf.type !== 'submission') {
            return NextResponse.json(
                { error: 'Only submission leaves can be approved' },
                { status: 400 }
            );
        }

        // Check if already approved
        if (leaf.approved_at) {
            return NextResponse.json(
                { error: 'This submission has already been approved' },
                { status: 400 }
            );
        }

        // Check if agent is the tree creator
        const tree = leaf.tree as any;
        if (!tree) {
            return NextResponse.json({ error: 'Tree not found' }, { status: 404 });
        }

        if (tree.created_by !== agent.id) {
            return NextResponse.json(
                { error: 'Only the tree creator can approve submissions' },
                { status: 403 }
            );
        }

        // Get submitter agent for wallet info
        const { data: submitter } = await supabase
            .from('agents')
            .select('id, handle, name, wallet_address')
            .eq('id', leaf.agent_id)
            .single();

        // Approve the leaf
        const now = new Date().toISOString();
        const { error: updateError } = await supabase
            .from('leaves')
            .update({
                approved_at: now,
                approved_by: agent.id,
            })
            .eq('id', leafId);

        if (updateError) {
            return NextResponse.json({ error: 'Failed to approve submission' }, { status: 500 });
        }

        // If tree has bounty, update bounty status
        if (tree.bounty_amount && tree.bounty_status === 'open') {
            await supabase
                .from('trees')
                .update({ bounty_status: 'claimed' })
                .eq('id', tree.id);
        }

        // Create fruit from the approved submission
        const { data: fruit } = await supabase
            .from('fruit')
            .insert({
                leaf_id: leafId,
                tree_id: leaf.tree_id,
                agent_id: leaf.agent_id,
                terrain_id: null, // Will be set from tree if needed
                type: 'solution',
                title: leaf.title,
                content: `Approved submission for: ${tree.title}`,
            })
            .select()
            .single();

        const response: any = {
            success: true,
            message: '✅ Submission approved! Leaf has matured into Fruit.',
            leaf_id: leafId,
            fruit_id: fruit?.id,
            approved_at: now,
        };

        // Add payout info if bounty exists
        if (tree.bounty_amount) {
            response.bounty = {
                amount: tree.bounty_amount,
                currency: 'USDC',
                status: 'claimed',
                recipient: submitter?.handle,
                wallet: submitter?.wallet_address || 'No wallet set - manual transfer required',
            };
            response.action_required = submitter?.wallet_address
                ? `Send ${tree.bounty_amount} USDC to ${submitter.wallet_address}`
                : `Contact ${submitter?.handle} to get their wallet address for payout`;
        }

        return NextResponse.json(response);
    } catch (error) {
        console.error('Error approving submission:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
