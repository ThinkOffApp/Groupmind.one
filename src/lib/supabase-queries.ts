// SPDX-License-Identifier: AGPL-3.0-only
// src/lib/supabase-queries.ts
// Server-side data fetching functions for Supabase

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { serverSupabaseUrl } from "./supabase-url";

export async function getSupabaseServer() {
    const cookieStore = await cookies();
    return createServerClient(
        serverSupabaseUrl()!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options)
                        );
                    } catch {
                        // Ignore in Server Components
                    }
                },
            },
        }
    );
}

export async function getTerrains() {
    const supabase = await getSupabaseServer();
    const { data, error } = await supabase
        .from("terrains")
        .select(`
            id,
            slug,
            name,
            description,
            parent_id,
            status,
            created_at
        `)
        .eq("status", "approved")
        .order("name");

    if (error) {
        console.error("Error fetching terrains:", error);
        return [];
    }
    return data || [];
}

// Get terrains with hierarchy structure
export async function getTerrainsHierarchy() {
    const terrains = await getTerrains();

    // Separate parents (no parent_id) and children
    const parents = terrains.filter(t => !t.parent_id);
    const children = terrains.filter(t => t.parent_id);

    // Build hierarchy
    return parents.map(parent => ({
        ...parent,
        children: children.filter(child => child.parent_id === parent.id)
    }));
}

export async function getTerrain(slug: string) {
    const supabase = await getSupabaseServer();
    const { data, error } = await supabase
        .from("terrains")
        .select(`
            id,
            slug,
            name,
            description,
            is_public,
            parent_id,
            created_at
        `)
        .eq("slug", slug)
        .single();

    if (error) {
        console.error("Error fetching terrain:", error);
        return null;
    }
    return data;
}

export async function getTrees(terrainId?: string) {
    const supabase = await getSupabaseServer();
    let query = supabase
        .from("trees")
        .select(`
            id,
            slug,
            title,
            description,
            status,
            updated_at,
            terrain:terrains(slug, name)
        `)
        .order("updated_at", { ascending: false });

    if (terrainId) {
        query = query.eq("terrain_id", terrainId);
    }

    const { data, error } = await query;

    if (error) {
        console.error("Error fetching trees:", error);
        return [];
    }
    return data || [];
}

export async function getTree(id: string) {
    const supabase = await getSupabaseServer();
    const { data, error } = await supabase
        .from("trees")
        .select(`
            id,
            slug,
            title,
            description,
            status,
            updated_at,
            terrain:terrains(slug, name)
        `)
        .eq("id", id)
        .single();

    if (error) {
        console.error("Error fetching tree:", error);
        return null;
    }
    return data;
}

export async function getLeaves(treeId?: string, limit = 50) {
    // Use service-role client to avoid cookie/RLS issues in server components
    const { getServiceSupabase } = await import('./supabase-service');
    const supabase = getServiceSupabase();

    try {
        let query = supabase
            .from("leaves")
            .select(`
                id,
                type,
                title,
                content,
                created_at,
                agent_id,
                terrain_id,
                tree_id
            `)
            .order("created_at", { ascending: false })
            .limit(limit);

        if (treeId) {
            query = query.eq("tree_id", treeId);
        }

        const { data, error } = await query;

        if (error) {
            console.error("Error fetching leaves:", error);
            return [];
        }

        if (!data || data.length === 0) {
            return [];
        }

        // Manually fetch related data to avoid RLS join issues
        const terrainIds = [...new Set(data.map(l => l.terrain_id).filter(Boolean))];
        const treeIds = [...new Set(data.map(l => l.tree_id).filter(Boolean))];
        const agentIds = [...new Set(data.map(l => l.agent_id).filter(Boolean))];

        const [terrainsRes, treesRes, agentsRes] = await Promise.all([
            terrainIds.length > 0
                ? supabase.from("terrains").select("id, slug, name").in("id", terrainIds)
                : { data: [] },
            treeIds.length > 0
                ? supabase.from("trees").select("id, slug, title").in("id", treeIds)
                : { data: [] },
            agentIds.length > 0
                ? supabase.from("agents").select("id, handle, name").in("id", agentIds)
                : { data: [] }
        ]);

        const terrainsMap = new Map((terrainsRes.data || []).map(t => [t.id, t]));
        const treesMap = new Map((treesRes.data || []).map(t => [t.id, t]));
        const agentsMap = new Map((agentsRes.data || []).map(a => [a.id, a]));

        // Return enriched data
        return data.map((leaf: any) => ({
            ...leaf,
            agent: agentsMap.get(leaf.agent_id) || null,
            terrain: terrainsMap.get(leaf.terrain_id) || null,
            tree: treesMap.get(leaf.tree_id) || null
        }));
    } catch (err) {
        console.error("Exception fetching leaves:", err);
        return [];
    }
}


export async function getFruit(limit = 50) {
    const supabase = await getSupabaseServer();
    const { data, error } = await supabase
        .from("fruit")
        .select(`
            id,
            leaf_id,
            type,
            title,
            content,
            created_at,
            agent:agents!fruit_agent_id_fkey(handle, name),
            terrain:terrains(slug, name),
            tree:trees(slug, title)
        `)
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) {
        console.error("Error fetching fruit:", error);
        return [];
    }
    return data || [];
}

export async function getTerrainStats(terrainId: string, parentId?: string) {
    const supabase = await getSupabaseServer();
    const ids = parentId ? [terrainId, parentId] : [terrainId];

    const [treesResult, leavesResult, fruitResult] = await Promise.all([
        supabase.from("trees").select("id", { count: "exact" }).in("terrain_id", ids),
        supabase.from("leaves").select("id", { count: "exact" }).in("terrain_id", ids),
        supabase.from("fruit").select("id", { count: "exact" }).in("terrain_id", ids),
    ]);

    return {
        trees: treesResult.count || 0,
        leaves: leavesResult.count || 0,
        fruit: fruitResult.count || 0,
    };
}

export async function getTreeStats(treeId: string) {
    const supabase = await getSupabaseServer();

    const [leavesResult, fruitResult] = await Promise.all([
        supabase.from("leaves").select("id", { count: "exact" }).eq("tree_id", treeId),
        supabase.from("fruit").select("id", { count: "exact" }).eq("tree_id", treeId),
    ]);

    return {
        leaves: leavesResult.count || 0,
        fruit: fruitResult.count || 0,
    };
}

export async function getAgents(limit: number = 10) {
    const supabase = await getSupabaseServer();

    // Get agents with their most recent activity
    const { data: agents, error } = await supabase
        .from("agents")
        .select(`
            id,
            handle,
            name,
            metadata,
            created_at
        `)
        .limit(50); // Get more to filter by activity
        
    // Get humans
    const { data: humans } = await supabase
        .from("user_profiles")
        .select(`
            user_id,
            handle,
            display_name,
            created_at,
            last_seen_at
        `)
        .limit(50);

    if (error || !agents) {
        console.error("Error fetching agents:", error);
        return [];
    }

    // Get last activity time for each agent (leaves or comments)
    const agentsWithActivity = await Promise.all(
        agents.map(async (agent) => {
            const [lastLeaf, lastComment] = await Promise.all([
                supabase
                    .from("leaves")
                    .select("created_at")
                    .eq("agent_id", agent.id)
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .single(),
                supabase
                    .from("leaf_comments")
                    .select("created_at")
                    .eq("agent_id", agent.id)
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .single()
            ]);

            const leafTime = lastLeaf.data?.created_at ? new Date(lastLeaf.data.created_at).getTime() : 0;
            const commentTime = lastComment.data?.created_at ? new Date(lastComment.data.created_at).getTime() : 0;
            const lastActivity = Math.max(leafTime, commentTime, new Date(agent.created_at).getTime());

            return {
                ...agent,
                is_human: false,
                verified_at: agent.metadata?.verified_at || null,
                last_activity: new Date(lastActivity).toISOString()
            };
        })
    );
    
    const humansMapped = (humans || []).map(h => ({
        id: h.user_id,
        handle: h.handle ? `@${h.handle.replace('@', '')}` : '@anonymous',
        name: h.display_name || 'Anonymous User',
        metadata: {},
        created_at: h.created_at,
        is_human: true,
        verified_at: h.created_at, // Consider all humans verified for now
        last_activity: h.last_seen_at || h.created_at
    }));
    
    const combined = [...agentsWithActivity, ...humansMapped];

    // Sort by most recent activity and take top N
    return combined
        .sort((a, b) => new Date(b.last_activity).getTime() - new Date(a.last_activity).getTime())
        .slice(0, limit);
}

// Get trending trees (most leaves in last 7 days)
export async function getTrendingTrees(limit: number = 5) {
    const supabase = await getSupabaseServer();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Get trees with recent leaf counts
    const { data: trees } = await supabase
        .from("trees")
        .select(`
            id,
            slug,
            title,
            terrain:terrains(slug, name)
        `)
        .order("updated_at", { ascending: false })
        .limit(20);

    if (!trees || trees.length === 0) return [];

    // Count leaves per tree in last week
    const treesWithCounts = await Promise.all(
        trees.map(async (tree) => {
            const { count } = await supabase
                .from("leaves")
                .select("id", { count: "exact", head: true })
                .eq("tree_id", tree.id)
                .gte("created_at", weekAgo);
            return { ...tree, leaf_count: count || 0 };
        })
    );

    return treesWithCounts
        .filter(t => t.leaf_count > 0)
        .sort((a, b) => b.leaf_count - a.leaf_count)
        .slice(0, limit);
}

// Get popping leaves (most reactions recently)
export async function getPoppingLeaves(limit: number = 5) {
    const supabase = await getSupabaseServer();

    // Get recent leaves with reaction counts
    const { data: leaves } = await supabase
        .from("leaves")
        .select(`
            id,
            title,
            type,
            created_at,
            agent:agents!leaves_agent_id_fkey(handle)
        `)
        .order("created_at", { ascending: false })
        .limit(30);

    if (!leaves || leaves.length === 0) return [];

    // Count reactions per leaf
    const leavesWithReactions = await Promise.all(
        leaves.map(async (leaf) => {
            const { count } = await supabase
                .from("reactions")
                .select("id", { count: "exact", head: true })
                .eq("leaf_id", leaf.id);
            return { ...leaf, reaction_count: count || 0 };
        })
    );

    return leavesWithReactions
        .sort((a, b) => b.reaction_count - a.reaction_count)
        .slice(0, limit);
}

// Get top bots (most leaves)
export async function getTopBots(limit: number = 5) {
    const supabase = await getSupabaseServer();

    const { data: agents } = await supabase
        .from("agents")
        .select(`
            id,
            handle,
            name,
            credibility,
            metadata
        `)
        .limit(100);

    if (!agents || agents.length === 0) return [];

    // Count leaves per agent
    const agentsWithCounts = await Promise.all(
        agents.map(async (agent) => {
            const { count } = await supabase
                .from("leaves")
                .select("id", { count: "exact", head: true })
                .eq("agent_id", agent.id);
            return {
                ...agent,
                leaf_count: count || 0,
                verified: !!agent.metadata?.verified_at
            };
        })
    );

    return agentsWithCounts
        .filter(a => a.leaf_count > 0)
        .sort((a, b) => b.leaf_count - a.leaf_count)
        .slice(0, limit);
}

// Get public rooms with member counts
export async function getPublicRooms(limit: number = 5) {
    const supabase = await getSupabaseServer();

    const { data: rooms, error } = await supabase
        .from("rooms")
        .select(`
            id,
            name,
            slug,
            is_public,
            created_at
        `)
        .eq("is_public", true)
        .order("created_at", { ascending: false })
        .limit(limit * 2); // Get more to sort by member count

    if (error || !rooms || rooms.length === 0) {
        console.error("Error fetching public rooms:", error);
        return [];
    }

    // Count members per room
    const roomsWithCounts = await Promise.all(
        rooms.map(async (room) => {
            const { count } = await supabase
                .from("room_members")
                .select("id", { count: "exact", head: true })
                .eq("room_id", room.id);
            return {
                ...room,
                member_count: count || 0
            };
        })
    );

    // Sort by member count and return top N
    return roomsWithCounts
        .sort((a, b) => b.member_count - a.member_count)
        .slice(0, limit);
}

