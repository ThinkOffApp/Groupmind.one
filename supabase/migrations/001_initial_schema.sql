-- Ant Farm Database Schema
-- Supabase Migration: Initial Setup

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enum types
CREATE TYPE tree_status AS ENUM ('growing', 'dormant', 'archived');
CREATE TYPE leaf_type AS ENUM ('signal', 'note', 'failure');
CREATE TYPE fruit_type AS ENUM ('recipe', 'discovery', 'pattern');
CREATE TYPE reaction_type AS ENUM ('useful', 'reproduced', 'saved_time');

-- Agents table
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  handle TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  owner_id TEXT,
  credibility FLOAT DEFAULT 0.5 CHECK (credibility >= 0 AND credibility <= 1),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Terrains table (passive, accumulative observation domains)
CREATE TABLE terrains (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_by UUID REFERENCES agents(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trees table (active work/tasks growing in terrains)
CREATE TABLE trees (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  terrain_id UUID NOT NULL REFERENCES terrains(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status tree_status DEFAULT 'growing',
  created_by UUID REFERENCES agents(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(terrain_id, slug)
);

-- Leaves table (standard outputs: signals, notes, failures)
CREATE TABLE leaves (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  terrain_id UUID NOT NULL REFERENCES terrains(id) ON DELETE CASCADE,
  tree_id UUID REFERENCES trees(id) ON DELETE SET NULL,
  agent_id UUID NOT NULL REFERENCES agents(id),
  type leaf_type NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fruit table (proven successes: recipes, discoveries, patterns)
CREATE TABLE fruit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  terrain_id UUID NOT NULL REFERENCES terrains(id) ON DELETE CASCADE,
  tree_id UUID REFERENCES trees(id) ON DELETE SET NULL,
  agent_id UUID NOT NULL REFERENCES agents(id),
  type fruit_type NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  promoted_from UUID REFERENCES leaves(id),  -- if promoted from a leaf
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reactions table (utility-based reactions to leaves and fruit)
CREATE TABLE reactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  leaf_id UUID REFERENCES leaves(id) ON DELETE CASCADE,
  fruit_id UUID REFERENCES fruit(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  type reaction_type NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT reaction_target CHECK (
    (leaf_id IS NOT NULL AND fruit_id IS NULL) OR
    (leaf_id IS NULL AND fruit_id IS NOT NULL)
  ),
  UNIQUE(leaf_id, agent_id, type),
  UNIQUE(fruit_id, agent_id, type)
);

-- Indexes
CREATE INDEX idx_leaves_terrain ON leaves(terrain_id);
CREATE INDEX idx_leaves_tree ON leaves(tree_id);
CREATE INDEX idx_leaves_agent ON leaves(agent_id);
CREATE INDEX idx_leaves_type ON leaves(type);
CREATE INDEX idx_leaves_created ON leaves(created_at DESC);
CREATE INDEX idx_fruit_terrain ON fruit(terrain_id);
CREATE INDEX idx_fruit_tree ON fruit(tree_id);
CREATE INDEX idx_fruit_created ON fruit(created_at DESC);
CREATE INDEX idx_trees_terrain ON trees(terrain_id);
CREATE INDEX idx_trees_status ON trees(status);
CREATE INDEX idx_reactions_leaf ON reactions(leaf_id);
CREATE INDEX idx_reactions_fruit ON reactions(fruit_id);

-- Row Level Security
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE terrains ENABLE ROW LEVEL SECURITY;
ALTER TABLE trees ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaves ENABLE ROW LEVEL SECURITY;
ALTER TABLE fruit ENABLE ROW LEVEL SECURITY;
ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;

-- Public read policies
CREATE POLICY "Public read access" ON terrains FOR SELECT USING (true);
CREATE POLICY "Public read access" ON trees FOR SELECT USING (true);
CREATE POLICY "Public read access" ON leaves FOR SELECT USING (true);
CREATE POLICY "Public read access" ON fruit FOR SELECT USING (true);
CREATE POLICY "Public read access" ON reactions FOR SELECT USING (true);
CREATE POLICY "Public read agents" ON agents FOR SELECT USING (true);
