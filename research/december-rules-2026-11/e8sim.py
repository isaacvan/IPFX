# Run each trader's chronological real-rules trades through E8 One challenge rules.
# Account normalised to 1.0. Each trade's return is the % of account it made on IPFX, re-priced at E8 costs.
# Floating loss uses the recorded worst point of each trade; overlapping trades are assumed to hit their worst together
# (conservative). Day boundary: UTC midnight (E8's server day may differ by a few hours).
import pandas as pd, numpy as np, json, sys

c = pd.read_pickle('replayed.pkl')
RULESETS = {
    'E8 One preset (help centre)':   dict(target=0.06, daily=0.03, dd=0.04),
    'E8 One $100K default (website)': dict(target=0.09, daily=0.04, dd=0.06),
}

def run_stream(t, retcol, target, daily, dd):
    """t: one trader's trades sorted by opened_at. Returns list of attempts: dict(result, n, days, end_idx)."""
    attempts = []
    i, n = 0, len(t)
    op = t.opened_at.values; cl = t.closed_at.values; r = t[retcol].values; low = t.low_ret.values
    while i < n:
        bal, high, start = 1.0, 1.0, i
        day = pd.Timestamp(op[i]).floor('D'); day_start_bal = bal
        result = 'unfinished'
        j = i
        open_lows = []  # (close_time, low) of trades still open
        while j < n:
            d = pd.Timestamp(op[j]).floor('D')
            # settle trades that closed before this one opened, in order
            if d != day: day, day_start_bal = d, bal
            floor_dd = max(min(high - dd, 1.0), 1.0 - dd) if high < 1.0 + dd else 1.0
            floor_day = day_start_bal - daily
            open_lows = [(ct, lw) for ct, lw in open_lows if ct > op[j]]
            worst_eq = bal + low[j] + sum(lw for _, lw in open_lows)
            if np.isnan(r[j]): j += 1; continue
            if worst_eq <= floor_day or worst_eq <= floor_dd:
                result = 'breach_daily' if worst_eq <= floor_day else 'breach_dd'
                j += 1; break
            open_lows.append((cl[j], low[j]))
            bal += r[j]; high = max(high, bal)
            floor_dd = 1.0 if high >= 1.0 + dd else max(high - dd, 1.0 - dd)
            if bal <= floor_dd or bal <= day_start_bal - daily:
                result = 'breach_daily' if bal <= day_start_bal - daily else 'breach_dd'; j += 1; break
            j += 1
            if bal >= 1.0 + target:
                result = 'pass'; break
        days = len(set(pd.to_datetime(t.opened_at.iloc[start:j]).dt.floor('D')))
        attempts.append(dict(result=result, n=j - start, days=days, start=start, end=j, final=bal))
        i = j
    return attempts

out = {}
users = c.sort_values('opened_at').groupby('user_id')
for rname, rs in RULESETS.items():
    for retcol in ['ret_ipfx', 'ret_opt', 'ret_base', 'ret_pess']:
        rows = []
        for uid, t in users:
            t = t.reset_index(drop=True)
            for k, a in enumerate(run_stream(t, retcol, **rs)):
                rows.append(dict(user_id=uid, attempt=k + 1, **a))
        df = pd.DataFrame(rows)
        fin = df[df.result != 'unfinished']
        passers = df[df.result == 'pass'].user_id.nunique()
        out[(rname, retcol)] = df
        print(f"{rname:34s} {retcol:9s} attempts={len(df):4d} finished={len(fin):4d} pass={int((df.result=='pass').sum()):3d} "
              f"({(df.result=='pass').sum()/max(len(fin),1)*100:4.1f}% of finished) traders_passing={passers:3d}/{df.user_id.nunique()} "
              f"breach_daily={int((df.result=='breach_daily').sum())} breach_dd={int((df.result=='breach_dd').sum())} median_trades_to_pass={df[df.result=='pass'].n.median()}")
pd.to_pickle(out, 'e8sim.pkl')
