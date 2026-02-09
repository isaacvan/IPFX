-- Check current user_profiles table structure
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'user_profiles'
ORDER BY ordinal_position;

-- Ensure user_profiles table has all necessary columns
-- Add missing columns if they don't exist
DO $$
BEGIN
    -- Add full_name if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_profiles' AND column_name = 'full_name'
    ) THEN
        ALTER TABLE user_profiles ADD COLUMN full_name TEXT;
    END IF;

    -- Add referral_code if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_profiles' AND column_name = 'referral_code'
    ) THEN
        ALTER TABLE user_profiles ADD COLUMN referral_code VARCHAR(10) UNIQUE;
    END IF;

    -- Add referred_by_code if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_profiles' AND column_name = 'referred_by_code'
    ) THEN
        ALTER TABLE user_profiles ADD COLUMN referred_by_code VARCHAR(10);
    END IF;

    -- Add referral_count if missing
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_profiles' AND column_name = 'referral_count'
    ) THEN
        ALTER TABLE user_profiles ADD COLUMN referral_count INTEGER DEFAULT 0;
    END IF;
END $$;

-- Check if RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename = 'user_profiles';

-- Enable RLS if not already enabled
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to recreate them
DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;
DROP POLICY IF EXISTS "Enable insert for authenticated users" ON user_profiles;
DROP POLICY IF EXISTS "Enable insert during registration" ON user_profiles;

-- Create policies that allow signup to work
CREATE POLICY "Enable insert during registration"
    ON user_profiles FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Users can view own profile"
    ON user_profiles FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
    ON user_profiles FOR UPDATE
    USING (auth.uid() = user_id);

-- Verify policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies
WHERE tablename = 'user_profiles';
