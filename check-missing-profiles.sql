-- Find users without profiles
SELECT
    'Users in auth.users WITHOUT profiles in user_profiles:' as status;

SELECT
    au.id as user_id,
    au.email,
    au.created_at,
    au.raw_user_meta_data
FROM auth.users au
LEFT JOIN public.user_profiles up ON au.id = up.user_id
WHERE up.user_id IS NULL
ORDER BY au.created_at DESC;

-- Count them
SELECT
    COUNT(*) as total_auth_users,
    (SELECT COUNT(*) FROM public.user_profiles) as total_profiles,
    COUNT(*) - (SELECT COUNT(*) FROM public.user_profiles) as missing_profiles
FROM auth.users;
