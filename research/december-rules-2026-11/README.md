# December 2026 Infinity rules research (26 Nov 2026, overnight)

Report: `IPFX-December-Rules.html` (also published privately as a claude.ai artifact).

Data (not committed; contains per-trader rows): production `trades` + `trading_accounts`, `ipfx_trade_lows`, `cost_samples`
(E8 vs IPFX spreads, ~30k samples per major symbol), `cost_symbol_model` (E8 commission). Export SQL is in the session notes;
re-export into this folder as `trades.pkl`, `lows.pkl`, `spread.pkl` before re-running.

Pipeline: `e8replay.py` (re-price every real-rules trade at E8 costs, 3 cost levels) -> `e8sim.py` (each trader's trades in
order through E8 One preset 6%/3%/4% and website 9%/4%/6%) -> `edge.py` (sign-flip null, persistence, empirical Bayes) ->
`stage1sim.py` and `rulesim2p.py` (Monte Carlo of 129 Stage 2+3 rule sets, 2 styles, 12 edge levels, 1,500 traders each,
20 processes) -> `build_report.py` / `render.py`.

Headline: 7 of 485 traders pass E8 One at E8 costs; pooled -0.42R per trade at E8 (-0.21R at IPFX); no detectable edge;
recommended rule set #100 (Stage 2: 6%, DD 8% fixed, daily 3%, 40 counted trades / 10 days, score 1.5, best day 40%, top-3 <= 50%;
Stage 3: 6%, 60 trades / 15 days, own score 1.5 and S2+S3 combined 3.0, best day 35%, top-3 <= 40%). Not implemented.
