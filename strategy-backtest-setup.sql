-- ============================================================
-- IPFX Capital — Strategy Backtest Submissions
-- Run this in your Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS strategy_submissions (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name             TEXT,
  email            TEXT NOT NULL,
  strategy_name    TEXT,
  trading_style    TEXT,
  timeframe        TEXT,
  instruments      TEXT[],
  submission_type  TEXT NOT NULL DEFAULT 'description', -- 'code' or 'description'
  code_language    TEXT,          -- pine_script | python | mql4 | mql5 | javascript | pseudocode | other
  strategy_code    TEXT,
  entry_conditions TEXT,
  exit_conditions  TEXT,
  risk_management  TEXT,
  additional_notes TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',     -- pending | in_review | completed
  analyst_notes    TEXT,          -- internal field for your quant team's notes
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE strategy_submissions ENABLE ROW LEVEL SECURITY;

-- Anyone can submit (no auth required — this is a public service)
CREATE POLICY "Public can submit strategies"
  ON strategy_submissions FOR INSERT
  WITH CHECK (true);

-- Only authenticated users (your team) can read submissions
CREATE POLICY "Authenticated users can read submissions"
  ON strategy_submissions FOR SELECT
  USING (auth.role() = 'authenticated');

-- Only authenticated users can update status/analyst_notes
CREATE POLICY "Authenticated users can update submissions"
  ON strategy_submissions FOR UPDATE
  USING (auth.role() = 'authenticated');

-- ============================================================
-- Useful queries for your quant team:

-- View all pending submissions (newest first):
-- SELECT id, name, email, strategy_name, trading_style, submission_type, created_at
-- FROM strategy_submissions
-- WHERE status = 'pending'
-- ORDER BY created_at DESC;

-- Mark a submission as in review:
-- UPDATE strategy_submissions SET status = 'in_review' WHERE id = '<uuid>';

-- Mark as completed and add analyst notes:
-- UPDATE strategy_submissions
-- SET status = 'completed', analyst_notes = 'Backtest sent 2026-10-15. Sharpe 1.4, suggested NQ instead of ES.'
-- WHERE id = '<uuid>';
