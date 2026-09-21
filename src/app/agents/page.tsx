// SPDX-License-Identifier: AGPL-3.0-only
import { getAgents } from '@/lib/supabase-queries';
import UsersClient from './UsersClient';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
    const agents = await getAgents(100);

    return <UsersClient initialUsers={agents || []} />;
}
