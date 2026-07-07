-- ============================================================
-- IPFX Capital — Single-Use Promo Code Support
-- Run this in your Supabase SQL Editor
-- ============================================================

-- 1. Add max_uses and use_count to promo_codes
--    max_uses = NULL means unlimited (existing behaviour)
--    max_uses = 1    means single-use
ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS max_uses  INT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS use_count INT NOT NULL DEFAULT 0;

-- ============================================================

-- 2. Trigger function: fires after every challenge_claims INSERT
--    Increments use_count on the redeemed code.
--    If use_count now equals max_uses, flips is_active to FALSE
--    so no further account can redeem it.
CREATE OR REPLACE FUNCTION increment_promo_use_count()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.promo_code IS NOT NULL THEN
    UPDATE promo_codes
    SET
      use_count = use_count + 1,
      is_active = CASE
        WHEN max_uses IS NOT NULL AND (use_count + 1) >= max_uses THEN FALSE
        ELSE is_active
      END
    WHERE code = NEW.promo_code;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Attach trigger to challenge_claims
DROP TRIGGER IF EXISTS trg_promo_use_count ON challenge_claims;
CREATE TRIGGER trg_promo_use_count
  AFTER INSERT ON challenge_claims
  FOR EACH ROW
  EXECUTE FUNCTION increment_promo_use_count();

-- ============================================================

-- 4. Insert the single-use code G7DKXVFTCH
--    Unlocks: Traditional 100K Challenge
--    max_uses = 1 — once one account redeems it, is_active flips
--    to FALSE and the code becomes permanently invalid for everyone else.
INSERT INTO promo_codes (code, challenge_name, challenge_type, max_uses, is_active)
VALUES ('G7DKXVFTCH', 'Traditional 100K Challenge', '100k', 1, TRUE)
ON CONFLICT (code) DO UPDATE
  SET
    challenge_name = EXCLUDED.challenge_name,
    challenge_type = EXCLUDED.challenge_type,
    max_uses       = EXCLUDED.max_uses,
    is_active      = TRUE,
    use_count      = 0;

-- Single-use code: ONJZKD5IWU
INSERT INTO promo_codes (code, challenge_name, challenge_type, max_uses, is_active)
VALUES ('ONJZKD5IWU', 'Traditional 100K Challenge', '100k', 1, TRUE)
ON CONFLICT (code) DO UPDATE
  SET
    challenge_name = EXCLUDED.challenge_name,
    challenge_type = EXCLUDED.challenge_type,
    max_uses       = EXCLUDED.max_uses,
    is_active      = TRUE,
    use_count      = 0;

-- ============================================================
-- HOW IT WORKS
-- ============================================================
-- 1. User enters G7DKXVFTCH on the signup form.
-- 2. checkPromoCode() queries promo_codes WHERE code = 'G7DKXVFTCH'
--    AND is_active = TRUE → found → shown as valid.
-- 3. User completes signup → a row is inserted into challenge_claims.
-- 4. trg_promo_use_count fires → use_count becomes 1 → use_count (1)
--    >= max_uses (1) → is_active set to FALSE.
-- 5. Any subsequent account that tries the code gets no row back from
--    the query (is_active = FALSE) → shown as "Invalid or expired".
-- ============================================================

-- To check current status of all single-use codes:
--   SELECT code, challenge_name, is_active, use_count, max_uses
--   FROM promo_codes WHERE code IN ('G7DKXVFTCH', 'ONJZKD5IWU');

-- To reset a code (e.g. if signup failed after the trigger fired):
--   UPDATE promo_codes SET is_active = TRUE, use_count = 0 WHERE code = 'G7DKXVFTCH';
--   UPDATE promo_codes SET is_active = TRUE, use_count = 0 WHERE code = 'ONJZKD5IWU';
