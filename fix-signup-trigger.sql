-- Fix the handle_new_user function to handle both 'name' and 'full_name' metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    new_referral_code VARCHAR(10);
    referrer_id UUID;
    user_name TEXT;
BEGIN
    -- Generate unique referral code
    new_referral_code := generate_referral_code(NEW.id);

    -- Handle both 'name' and 'full_name' metadata fields
    user_name := COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        split_part(NEW.email, '@', 1)
    );

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
        referral_code,
        referred_by_code
    )
    VALUES (
        NEW.id,
        user_name,
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

-- Verify the function works
SELECT routine_name, routine_definition
FROM information_schema.routines
WHERE routine_name = 'handle_new_user';
