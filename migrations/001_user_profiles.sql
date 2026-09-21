-- User Profiles table for human users (nickname/display name)
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS user_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT,
    handle TEXT UNIQUE,  -- Optional: for @mentions
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Users can read all profiles
CREATE POLICY "Anyone can read profiles" ON user_profiles FOR SELECT USING (true);

-- Users can only update their own profile
CREATE POLICY "Users can update own profile" ON user_profiles FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile" ON user_profiles FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
