-- SPDX-License-Identifier: AGPL-3.0-only
-- Add is_public flag to terrains table for private terrain support
-- Private terrains have their leaf/fruit content encrypted at rest

ALTER TABLE terrains ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT true;
ALTER TABLE terrains ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

-- Index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_terrains_is_public ON terrains(is_public);
CREATE INDEX IF NOT EXISTS idx_terrains_created_by ON terrains(created_by) WHERE created_by IS NOT NULL;

-- Update existing terrains to be public (they were all public before)
UPDATE terrains SET is_public = true WHERE is_public IS NULL;
