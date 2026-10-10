"""Regenerates the Stage 2 / Stage 3 rows of STAGE_TABLE in supabase/functions/_shared/treasury.ts.

Monte Carlo of one Infinity stage per expectancy mu (R per trade) on GRID: +1.2R / -1R trades, 3 trades per
active day, 70% of days active, daily loss limit, daily profit cap (orders blocked once reached), trailing
drawdown from the equity peak, minimum days and trades. Profitable-day, best-day and session rules are NOT
modelled (the table is a liability approximation, not the rule engine).

Rows: "2" = Stage 2 at 6% (runs whose Stage 1 opened before 2026-10-11), "2@7" = Stage 2 at 7% (rule set B,
runs from 2026-10-11), "3" = Stage 3 at 8%. The Stage 1 row is not regenerated here.
Usage: python scripts/treasury-stage-table.py > table.json   (seeded: reruns are identical)
"""
import json, sys
import numpy as np

GRID = [round(-0.4 + 0.02 * i, 2) for i in range(51)]
N = 6000
rng = np.random.default_rng(2026)

def sim(mu, start, target_pct, dd_pct, daily_pct, cap_pct, risk_pct, min_days, min_trades, horizon=140, active=0.70, tpd=3, win_r=1.2):
    mu = np.asarray(mu); n = len(mu) * N
    m = np.repeat(mu, N)
    p_win = (m + 1) / (win_r + 1)
    R = start * risk_pct / 100
    bal = np.full(n, float(start)); peak = bal.copy()
    alive = np.ones(n, bool); passed = np.zeros(n, bool); trades = np.zeros(n, int); done_day = np.zeros(n, int)
    for d in range(1, horizon + 1):
        act_day = rng.random(n) < active
        day_pnl = np.zeros(n)
        for _ in range(tpd):
            can = alive & ~passed & act_day & (day_pnl > -start * daily_pct / 100) & (day_pnl < start * cap_pct / 100)
            if not can.any(): break
            win = rng.random(n) < p_win
            pnl = np.where(win, win_r * R, -R) * can
            bal += pnl; day_pnl += pnl; trades += can
            peak = np.where(can, np.maximum(peak, bal), peak)
            alive &= ~(can & (bal <= peak - start * dd_pct / 100))
            hit = can & alive & (bal >= start * (1 + target_pct / 100)) & (trades >= min_trades) & (d >= min_days)
            done_day = np.where(hit & ~passed, d, done_day); passed |= hit
        if not (alive & ~passed).any(): break
    P = passed.reshape(len(mu), N); D = done_day.reshape(len(mu), N)
    pp = [round(float(x), 4) for x in P.mean(1)]
    dd = [round(float(D[i][P[i]].mean()), 1) if P[i].any() else None for i in range(len(mu))]
    return pp, dd

S2 = dict(start=5000, dd_pct=4, daily_pct=2, cap_pct=1.25, risk_pct=0.35, min_days=15, min_trades=60)
S3 = dict(start=10000, dd_pct=4, daily_pct=2, cap_pct=1.25, risk_pct=0.35, min_days=10, min_trades=40)

if __name__ == "__main__":
    out = {"p_pass": {}, "days_if_pass": {}}
    # Order matters for the seeded stream: "2" then "3" reproduce the table built on 2026-10-08.
    for key, cfg, tgt in (("2", S2, 6), ("3", S3, 8), ("2@7", S2, 7)):
        out["p_pass"][key], out["days_if_pass"][key] = sim(GRID, target_pct=tgt, **cfg)
    json.dump(out, sys.stdout)
