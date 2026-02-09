-- DEBUG SCRIPT: Run this to see what's wrong with signup

-- 1. Check if user_profiles table exists
SELECT 'Checking user_profiles table...' as step;
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name = 'user_profiles'
ORDER BY ordinal_position;

-- 2. Check if generate_referral_code function exists
SELECT 'Checking generate_referral_code function...' as step;
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_name = 'generate_referral_code';

-- 3. Check if handle_new_user function exists
SELECT 'Checking handle_new_user function...' as step;
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_name = 'handle_new_user';

-- 4. Check if trigger exists
SELECT 'Checking trigger...' as step;
SELECT trigger_name, event_manipulation, event_object_table
FROM information_schema.triggers
WHERE trigger_name = 'on_auth_user_created';

-- 5. Check RLS policies
SELECT 'Checking RLS policies...' as step;
SELECT schemaname, tablename, policyname, cmd
FROM pg_policies
WHERE tablename = 'user_profiles';

-- 6. Try to manually test the function
SELECT 'Testing referral code generation...' as step;
SELECT generate_referral_code('00000000-0000-0000-0000-000000000000'::uuid) as test_code;
