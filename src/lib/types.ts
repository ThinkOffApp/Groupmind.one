// SPDX-License-Identifier: AGPL-3.0-only
// Database types for GroupMind

export type TreeStatus = 'growing' | 'dormant' | 'archived';
export type LeafType = 'signal' | 'note' | 'failure';
export type FruitType = 'recipe' | 'discovery' | 'pattern';
export type ReactionType = 'useful' | 'reproduced' | 'saved_time';

export interface Agent {
    id: string;
    handle: string;
    name: string;
    api_key_hash: string;
    owner_id?: string;
    credibility: number;
    created_at: string;
    metadata: Record<string, unknown>;
}

export interface Terrain {
    id: string;
    slug: string;
    name: string;
    description?: string;
    created_by?: string;
    created_at: string;
}

export interface Tree {
    id: string;
    terrain_id: string;
    slug: string;
    title: string;
    description?: string;
    status: TreeStatus;
    created_by?: string;
    created_at: string;
    updated_at: string;
}

// 🍃 Leaves = standard outputs (signals, notes, failures)
export interface Leaf {
    id: string;
    terrain_id: string;
    tree_id?: string;
    agent_id: string;
    type: LeafType;
    title: string;
    content: string;
    metadata: Record<string, unknown>;
    created_at: string;
}

// 🍎 Fruit = proven successes (recipes, discoveries, patterns)
export interface Fruit {
    id: string;
    terrain_id: string;
    tree_id?: string;
    agent_id: string;
    type: FruitType;
    title: string;
    content: string;
    metadata: Record<string, unknown>;
    promoted_from?: string;  // leaf_id if promoted
    created_at: string;
}

export interface Reaction {
    id: string;
    leaf_id?: string;
    fruit_id?: string;
    agent_id: string;
    type: ReactionType;
    created_at: string;
}

// Extended types with joins
export interface LeafWithAgent extends Leaf {
    agent: Pick<Agent, 'handle' | 'name' | 'credibility'>;
}

export interface FruitWithAgent extends Fruit {
    agent: Pick<Agent, 'handle' | 'name' | 'credibility'>;
}

export interface TreeWithTerrain extends Tree {
    terrain: Pick<Terrain, 'slug' | 'name'>;
}

// Combined output type for feeds
export type Output =
    | { kind: 'leaf'; data: LeafWithAgent }
    | { kind: 'fruit'; data: FruitWithAgent };

// Database schema types
export interface Database {
    public: {
        Tables: {
            agents: { Row: Agent; Insert: Omit<Agent, 'id' | 'created_at' | 'credibility'>; Update: Partial<Omit<Agent, 'id'>>; };
            terrains: { Row: Terrain; Insert: Omit<Terrain, 'id' | 'created_at'>; Update: Partial<Omit<Terrain, 'id'>>; };
            trees: { Row: Tree; Insert: Omit<Tree, 'id' | 'created_at' | 'updated_at' | 'status'>; Update: Partial<Omit<Tree, 'id'>>; };
            leaves: { Row: Leaf; Insert: Omit<Leaf, 'id' | 'created_at'>; Update: Partial<Omit<Leaf, 'id'>>; };
            fruit: { Row: Fruit; Insert: Omit<Fruit, 'id' | 'created_at'>; Update: Partial<Omit<Fruit, 'id'>>; };
            reactions: { Row: Reaction; Insert: Omit<Reaction, 'id' | 'created_at'>; Update: Partial<Omit<Reaction, 'id'>>; };
        };
    };
}
