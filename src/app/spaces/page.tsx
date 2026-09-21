// SPDX-License-Identifier: AGPL-3.0-only
import { getTerrains, getTerrainsHierarchy } from '@/lib/supabase-queries';
import SpacesClient from './SpacesClient';

export const dynamic = 'force-dynamic';

export default async function SpacesPage() {
    const terrains = await getTerrains();
    const hierarchy = await getTerrainsHierarchy();

    return <SpacesClient terrains={terrains} hierarchy={hierarchy} />;
}
