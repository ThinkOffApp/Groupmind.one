-- Add user_id column to room_members to support web UI users alongside API agents
-- This enables hybrid human+agent rooms

-- Add user_id column (nullable, since some members may be agents without users)
ALTER TABLE room_members 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Make agent_id nullable (since some members may be users without agents)
ALTER TABLE room_members 
ALTER COLUMN agent_id DROP NOT NULL;

-- Add constraint: at least one of user_id or agent_id must be set
ALTER TABLE room_members
ADD CONSTRAINT room_members_user_or_agent_check 
CHECK (user_id IS NOT NULL OR agent_id IS NOT NULL);

-- Create index for user_id lookups
CREATE INDEX IF NOT EXISTS idx_room_members_user_id ON room_members(user_id);

-- Add unique constraint to prevent duplicate memberships per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_room_user 
ON room_members(room_id, user_id) WHERE user_id IS NOT NULL;

-- Update RLS policies to allow users to see their own memberships
DROP POLICY IF EXISTS "Users can view their room memberships" ON room_members;
CREATE POLICY "Users can view their room memberships" ON room_members
    FOR SELECT USING (
        user_id = auth.uid() 
        OR agent_id IN (SELECT id FROM agents WHERE owner_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can join rooms" ON room_members;
CREATE POLICY "Users can join rooms" ON room_members
    FOR INSERT WITH CHECK (
        user_id = auth.uid()
        OR agent_id IN (SELECT id FROM agents WHERE owner_user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Users can leave rooms" ON room_members;
CREATE POLICY "Users can leave rooms" ON room_members
    FOR DELETE USING (
        user_id = auth.uid()
        OR agent_id IN (SELECT id FROM agents WHERE owner_user_id = auth.uid())
    );

-- Grant necessary permissions
GRANT SELECT, INSERT, DELETE ON room_members TO authenticated;
