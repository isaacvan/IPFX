-- Generate referral codes for existing users who don't have one yet
-- Run this in Supabase SQL Editor

DO $$
DECLARE
    user_record RECORD;
    new_code VARCHAR(10);
BEGIN
    -- Loop through all users without a referral code
    FOR user_record IN
        SELECT user_id
        FROM public.user_profiles
        WHERE referral_code IS NULL
    LOOP
        -- Generate a unique code for each user
        new_code := generate_referral_code(user_record.user_id);

        -- Update the user's profile with the new code
        UPDATE public.user_profiles
        SET referral_code = new_code
        WHERE user_id = user_record.user_id;

        RAISE NOTICE 'Generated code % for user %', new_code, user_record.user_id;
    END LOOP;

    RAISE NOTICE 'Finished generating referral codes for existing users';
END $$;

-- Verify all users now have referral codes
SELECT
    COUNT(*) as total_users,
    COUNT(referral_code) as users_with_codes,
    COUNT(*) - COUNT(referral_code) as users_without_codes
FROM public.user_profiles;
