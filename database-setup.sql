-- ============================================
-- IPFX Capital Database Setup
-- ============================================
-- Run this SQL in Supabase SQL Editor to create all tables
-- Go to: Supabase Dashboard → SQL Editor → New Query → Paste this → Run

-- ============================================
-- 1. USER PROFILES TABLE
-- ============================================
-- Stores extended user information beyond authentication
CREATE TABLE user_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  country TEXT,
  trading_experience TEXT,
  referral_source TEXT,
  newsletter BOOLEAN DEFAULT false NOT NULL
);

-- Enable Row Level Security
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only access their own profile
CREATE POLICY "Users can view own profile"
  ON user_profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
  ON user_profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON user_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Create index for faster lookups
CREATE INDEX user_profiles_user_id_idx ON user_profiles(user_id);

-- ============================================
-- 2. CHALLENGE ENROLLMENTS TABLE
-- ============================================
-- Stores user challenge enrollments and status
CREATE TABLE challenge_enrollments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  -- Challenge Details
  challenge_tier TEXT NOT NULL, -- '10k', '25k', '50k', '100k', '200k'
  account_size INTEGER NOT NULL, -- 10000, 25000, 50000, etc.
  entry_fee INTEGER NOT NULL, -- In cents/pence

  -- Status and Dates
  status TEXT DEFAULT 'pending' NOT NULL, -- 'pending', 'active', 'passed', 'failed', 'funded'
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,

  -- Challenge Parameters
  profit_target INTEGER NOT NULL, -- In cents/pence
  daily_loss_limit INTEGER NOT NULL,
  total_loss_limit INTEGER NOT NULL,

  -- Current State
  current_balance INTEGER, -- In cents/pence
  current_profit INTEGER DEFAULT 0,
  trades_count INTEGER DEFAULT 0,
  win_rate DECIMAL(5,2), -- Percentage

  -- Payment
  payment_method TEXT,
  payment_status TEXT DEFAULT 'pending', -- 'pending', 'completed', 'refunded'

  -- Trading Platform
  trading_account_id TEXT,
  trading_platform TEXT DEFAULT 'MT5'
);

-- Enable Row Level Security
ALTER TABLE challenge_enrollments ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own enrollments"
  ON challenge_enrollments FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own enrollments"
  ON challenge_enrollments FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own enrollments"
  ON challenge_enrollments FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Indexes
CREATE INDEX challenge_enrollments_user_id_idx ON challenge_enrollments(user_id);
CREATE INDEX challenge_enrollments_status_idx ON challenge_enrollments(status);

-- ============================================
-- 3. TRADES TABLE (Optional - for future use)
-- ============================================
-- Stores individual trade records
CREATE TABLE trades (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  enrollment_id UUID REFERENCES challenge_enrollments(id) ON DELETE CASCADE NOT NULL,

  -- Trade Details
  symbol TEXT NOT NULL, -- 'EUR/USD', 'GBP/USD', etc.
  direction TEXT NOT NULL, -- 'buy' or 'sell'
  lot_size DECIMAL(10,2) NOT NULL,

  -- Prices
  entry_price DECIMAL(12,5) NOT NULL,
  exit_price DECIMAL(12,5),

  -- Timestamps
  opened_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  closed_at TIMESTAMPTZ,

  -- Results
  profit_loss INTEGER, -- In cents/pence
  status TEXT DEFAULT 'open' NOT NULL -- 'open', 'closed'
);

-- Enable RLS
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own trades"
  ON trades FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own trades"
  ON trades FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own trades"
  ON trades FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Indexes
CREATE INDEX trades_user_id_idx ON trades(user_id);
CREATE INDEX trades_enrollment_id_idx ON trades(enrollment_id);
CREATE INDEX trades_status_idx ON trades(status);

-- ============================================
-- 4. UPDATED_AT TRIGGER FUNCTION
-- ============================================
-- Automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tables
CREATE TRIGGER update_user_profiles_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_challenge_enrollments_updated_at
    BEFORE UPDATE ON challenge_enrollments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- SETUP COMPLETE!
-- ============================================
-- Your tables are now ready. Real data will be created when:
-- 1. Users sign up (creates user_profiles)
-- 2. Users enroll in challenges (creates challenge_enrollments)
-- 3. Users place trades (creates trades)
