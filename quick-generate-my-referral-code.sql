-- Quick script to generate referral codes for all existing users
-- Run this in Supabase SQL Editor

-- First, let's check current status
SELECT
    user_id,
    full_name,
    referral_code,
    referral_count
FROM public.user_profiles;

-- Now generate codes for users who don't have one
UPDATE public.user_profiles
SET referral_code = generate_referral_code(user_id)
WHERE referral_code IS NULL;

-- Verify the update
SELECT
    user_id,
    full_name,
    referral_code,
    referral_count
FROM public.user_profiles;
