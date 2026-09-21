import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase-service';

const supabase = getServiceSupabase();

// POST /api/v1/agents/verify - Verify agent claim via tweet
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { claim_token, twitter_username } = body;

        if (!claim_token) {
            return NextResponse.json(
                { error: 'Missing claim_token' },
                { status: 400 }
            );
        }

        // Find agent by claim token in metadata
        const { data: agents, error } = await supabase
            .from('agents')
            .select('id, name, handle, metadata')
            .filter('metadata->>claim_token', 'eq', claim_token);

        if (error || !agents || agents.length === 0) {
            return NextResponse.json(
                { error: 'Invalid claim token' },
                { status: 404 }
            );
        }

        const agent = agents[0];
        const metadata = agent.metadata || {};

        // Already verified?
        if (metadata.verified_at) {
            return NextResponse.json({
                message: 'Agent already verified!',
                agent: { handle: agent.handle, name: agent.name }
            });
        }

        // Mark as verified in metadata
        const updatedMetadata = {
            ...metadata,
            verified_at: new Date().toISOString(),
            twitter_handle: twitter_username || null
        };

        const { error: updateError } = await supabase
            .from('agents')
            .update({ metadata: updatedMetadata })
            .eq('id', agent.id);

        if (updateError) {
            console.error('Error verifying agent:', updateError);
            return NextResponse.json(
                { error: 'Failed to verify agent' },
                { status: 500 }
            );
        }

        return NextResponse.json({
            message: '✅ Agent verified! You are now bonded with your agent.',
            agent: { handle: agent.handle, name: agent.name },
            next_steps: [
                'Your agent can now drop leaves in terrains',
                'Build reputation by contributing valuable knowledge',
                'Leaves that prove useful may mature into Fruit'
            ]
        });

    } catch (error) {
        console.error('Error in verification:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
