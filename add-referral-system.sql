-- Add referral code columns to user_profiles table
ALTER TABLE user_profiles
ADD COLUMN referral_code VARCHAR(10) UNIQUE,
ADD COLUMN referred_by_code VARCHAR(10),
ADD COLUMN referral_count INTEGER DEFAULT 0;

-- Create index for faster referral code lookups
CREATE INDEX idx_user_profiles_referral_code ON user_profiles(referral_code);
CREATE INDEX idx_user_profiles_referred_by ON user_profiles(referred_by_code);

-- Function to generate unique referral code using Hashids-style encoding
CREATE OR REPLACE FUNCTION generate_referral_code(user_id_input UUID)
RETURNS VARCHAR(10) AS $$
DECLARE
    -- Base62 characters (excludes confusing chars like 0/O, 1/I/l)
    chars TEXT := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    code TEXT := '';
    num BIGINT;
    remainder INT;
    hash_input TEXT;
    i INT;
BEGIN
    -- Create a hash from UUID and timestamp for uniqueness
    hash_input := user_id_input::TEXT || extract(epoch from now())::TEXT;
    num := ('x' || substr(md5(hash_input), 1, 12))::bit(48)::BIGINT;

    -- Convert to base-32 using our character set
    FOR i IN 1..8 LOOP
        remainder := num % 32;
        code := substr(chars, remainder + 1, 1) || code;
        num := num / 32;
    END LOOP;

    RETURN code;
END;
$$ LANGUAGE plpgsql;

-- Update the handle_new_user function to include referral code generation
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    new_referral_code VARCHAR(10);
    referrer_id UUID;
BEGIN
    -- Generate unique referral code
    new_referral_code := generate_referral_code(NEW.id);

    -- Check if user signed up with a referral code
    IF NEW.raw_user_meta_data->>'referral_code' IS NOT NULL THEN
        -- Find the referrer and increment their count
        SELECT user_id INTO referrer_id
        FROM public.user_profiles
        WHERE referral_code = NEW.raw_user_meta_data->>'referral_code';

        IF referrer_id IS NOT NULL THEN
            UPDATE public.user_profiles
            SET referral_count = referral_count + 1
            WHERE user_id = referrer_id;
        END IF;
    END IF;

    -- Create user profile with referral code
    INSERT INTO public.user_profiles (
        user_id,
        full_name,
        newsletter,
        referral_code,
        referred_by_code
    )
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        COALESCE((NEW.raw_user_meta_data->>'newsletter')::boolean, false),
        new_referral_code,
        NEW.raw_user_meta_data->>'referral_code'
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate the trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- Optional: Create a referrals table for detailed tracking
CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    referrer_user_id UUID REFERENCES user_profiles(user_id) ON DELETE CASCADE,
    referred_user_id UUID REFERENCES user_profiles(user_id) ON DELETE CASCADE,
    referral_code VARCHAR(10) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- pending, active, rewarded
    reward_earned DECIMAL(10,2) DEFAULT 0,
    UNIQUE(referred_user_id)
);

-- Enable RLS on referrals table
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own referrals
CREATE POLICY "Users can view their own referrals"
    ON referrals FOR SELECT
    USING (
        referrer_user_id = auth.uid() OR
        referred_user_id = auth.uid()
    );

-- Create index for referral lookups
CREATE INDEX idx_referrals_referrer ON referrals(referrer_user_id);
CREATE INDEX idx_referrals_referred ON referrals(referred_user_id);

COMMENT ON TABLE referrals IS 'Tracks detailed referral relationships between users';
COMMENT ON COLUMN user_profiles.referral_code IS 'Unique referral code for this user to share';
COMMENT ON COLUMN user_profiles.referred_by_code IS 'Referral code used when this user signed up';
COMMENT ON COLUMN user_profiles.referral_count IS 'Number of users who signed up with this user''s referral code';
