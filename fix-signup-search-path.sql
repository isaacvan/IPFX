-- ============================================================
-- FIX: "Database error saving new user" on signup (2026-09-08)
--
-- ROOT CAUSE: public.handle_new_user() is SECURITY DEFINER but had no
-- `SET search_path`. It called generate_referral_code(NEW.id) WITHOUT a
-- schema qualifier (every table reference in it was qualified as
-- public.*, but that one function call was not). A SECURITY DEFINER
-- function inherits the *caller's* search_path, and GoTrue's session
-- when inserting into auth.users does not reliably include `public`, so
-- the call failed to resolve, the exception propagated out of the
-- AFTER INSERT trigger, and the entire auth.users insert was rolled
-- back. GoTrue surfaces that to the client as the generic
-- "Database error saving new user" / "Database error creating new user".
--
-- Same root-cause class as the earlier fn_sha256/pgcrypto failure in
-- internal-control-core.sql: SECURITY DEFINER + unqualified reference +
-- no explicit search_path.
--
-- THE FIX (two parts):
--   1. SET search_path = public on the function  <- this is what
--      actually resolves the bug.
--   2. Each side-effect block wrapped in its own BEGIN/EXCEPTION so a
--      failure in referral crediting, restricted-country lookup, or
--      consent logging can never again block account creation. Signup
--      is the primary action; enrichment is best-effort. Same principle
--      as logAudit() in supabase/functions/trading-engine/index.ts
--      ("audit logging must never block trading"). Failures now
--      RAISE WARNING (visible in Postgres logs) instead of vanishing.
--
-- VERIFIED: admin createUser succeeded post-fix; user_profiles row
-- created with a generated referral_code, and both consent_records rows
-- (terms + privacy) written. Test user deleted afterwards.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
    new_referral_code VARCHAR(10);
    referrer_id UUID;
    user_name TEXT;
    v_country_code TEXT;
    v_restricted BOOLEAN;
BEGIN
    BEGIN
        new_referral_code := generate_referral_code(NEW.id);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'handle_new_user: generate_referral_code failed for %: %', NEW.id, SQLERRM;
        new_referral_code := NULL;
    END;

    user_name := COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        split_part(NEW.email, '@', 1)
    );

    v_country_code := upper(NEW.raw_user_meta_data->>'country_code');
    BEGIN
        v_restricted := v_country_code IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.restricted_countries WHERE country_code = v_country_code
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'handle_new_user: restricted_countries check failed for %: %', NEW.id, SQLERRM;
        v_restricted := false;
    END;

    BEGIN
        IF NEW.raw_user_meta_data->>'referral_code' IS NOT NULL THEN
            SELECT user_id INTO referrer_id
            FROM public.user_profiles
            WHERE referral_code = NEW.raw_user_meta_data->>'referral_code';

            IF referrer_id IS NOT NULL THEN
                UPDATE public.user_profiles
                SET referral_count = referral_count + 1
                WHERE user_id = referrer_id;
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'handle_new_user: referral credit failed for %: %', NEW.id, SQLERRM;
    END;

    BEGIN
        INSERT INTO public.user_profiles (
            user_id, full_name, referral_code, referred_by_code,
            country_code, restricted_jurisdiction, age_confirmed
        )
        VALUES (
            NEW.id, user_name, new_referral_code, NEW.raw_user_meta_data->>'referral_code',
            v_country_code, coalesce(v_restricted, false),
            (NEW.raw_user_meta_data->>'age_confirmed')::boolean IS TRUE
        )
        ON CONFLICT (user_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'handle_new_user: user_profiles insert failed for %: %', NEW.id, SQLERRM;
    END;

    BEGIN
        INSERT INTO public.consent_records (user_id, document, version)
        VALUES
          (NEW.id, 'terms', coalesce(NEW.raw_user_meta_data->>'terms_version', 'unknown')),
          (NEW.id, 'privacy', coalesce(NEW.raw_user_meta_data->>'privacy_version', 'unknown'));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'handle_new_user: consent_records insert failed for %: %', NEW.id, SQLERRM;
    END;

    RETURN NEW;
END;
$function$;
