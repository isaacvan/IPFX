-- ============================================================
-- IPFX Capital — Promo Codes Setup
-- Run this in your Supabase SQL Editor
-- ============================================================

-- 1. Promo codes table
CREATE TABLE IF NOT EXISTS promo_codes (
  code          TEXT PRIMARY KEY,
  challenge_name TEXT NOT NULL,   -- e.g. 'Traditional 25K Challenge'
  challenge_type TEXT NOT NULL,   -- e.g. '25k', '50k', '100k', '200k'
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;

-- Anyone can read active codes (needed for client-side validation on signup form)
CREATE POLICY "Public read active promo codes"
  ON promo_codes FOR SELECT
  USING (is_active = TRUE);

-- ============================================================

-- 2. Challenge claims — tracks who redeemed what code
CREATE TABLE IF NOT EXISTS challenge_claims (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  promo_code     TEXT REFERENCES promo_codes(code),
  challenge_type TEXT NOT NULL,
  challenge_name TEXT NOT NULL,
  account_type   TEXT NOT NULL DEFAULT 'traditional', -- 'traditional' or 'futures'
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- If the table already exists, add the column:
ALTER TABLE challenge_claims ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'traditional';

ALTER TABLE challenge_claims ENABLE ROW LEVEL SECURITY;

-- Users can insert their own claim on signup
CREATE POLICY "Users can claim challenges"
  ON challenge_claims FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can view their own claims (for dashboard display)
CREATE POLICY "Users can view own claims"
  ON challenge_claims FOR SELECT
  USING (auth.uid() = user_id);

-- ============================================================

-- 3. Seed your promo codes here
--    Add a new INSERT row for each TikTok video / giveaway code
INSERT INTO promo_codes (code, challenge_name, challenge_type) VALUES
  ('TIKTOK25K',  'Traditional 25K Challenge',  '25k'),
  ('TIKTOK50K',  'Traditional 50K Challenge',  '50k'),
  ('TIKTOK100K', 'Traditional 100K Challenge', '100k'),
  ('TIKTOK200K', 'Traditional 200K Challenge', '200k')
ON CONFLICT (code) DO NOTHING;

-- To deactivate a code (so it stops working):
--   UPDATE promo_codes SET is_active = FALSE WHERE code = 'TIKTOK25K';

-- To view all claims:
--   SELECT cc.*, p.full_name, u.email
--   FROM challenge_claims cc
--   JOIN auth.users u ON u.id = cc.user_id
--   LEFT JOIN profiles p ON p.id = cc.user_id;
