# Data tests behind each proposed rule improvement (E8-cost R per trade).
import pandas as pd, numpy as np, json
c = pd.read_pickle('replayedR.pkl').sort_values('opened_at').reset_index(drop=True)
sp = pd.read_pickle('spread.pkl').set_index('symbol'); sp['e8_avg'] = pd.to_numeric(sp.e8_avg)
c['hold_s'] = (c.closed_at - c.opened_at).dt.total_seconds()
c['Rw'] = c.R.clip(-3, 5)
out = {}

# H1 clustering: correlation of trade results within the same trader-day; effective number of observations
c['day'] = c.opened_at.dt.floor('D')
g = c.groupby(['user_id', 'day'])
dm = g.Rw.transform('mean'); um = c.groupby('user_id').Rw.transform('mean')
# ICC via one-way ANOVA on trader-day groups (within-trader)
x = c.Rw - um
grp = x.groupby([c.user_id, c.day])
k = grp.size(); k0 = (k.sum() - (k**2).sum() / k.sum()) / (len(k) - 1)
msb = (grp.size() * grp.mean()**2).sum() / (len(k) - 1); msw = ((x - grp.transform('mean'))**2).sum() / (k.sum() - len(k))
icc = (msb - msw) / (msb + (k0 - 1) * msw)
out['H1_icc_same_day'] = round(float(icc), 3); out['H1_trades_per_day_mean'] = round(float(k.mean()), 2)
out['H1_design_effect'] = round(float(1 + (k.mean() - 1) * icc), 2)

# H2 stop width in spreads vs cost and lottery tails
stop = (c.open_price - c.initial_sl.fillna(c.sl)).abs()
c['stop_spreads'] = stop / c.symbol.map(sp.e8_avg)
b = pd.cut(c.stop_spreads, [0, 4, 8, 15, 30, 1e9], labels=['<4', '4-8', '8-15', '15-30', '30+'])
c['costR'] = (c.adj_base / c.bal_before) / c.risk_ret
t = c.groupby(b, observed=True).agg(trades=('R', 'size'), mean_R_E8=('R', 'mean'), mean_R_IPFX=('R_ipfx', 'mean'), median_costR=('costR', 'median'),
                                     share_R_over_10=('R', lambda s: (s > 10).mean()))
out['H2_stop_width'] = t.round(3).reset_index().astype(str).to_dict('records')

# H3 hold time
hb = pd.cut(c.hold_s, [-1, 60, 300, 1800, 4 * 3600, 1e9], labels=['<1m', '1-5m', '5-30m', '30m-4h', '>4h'])
t = c.groupby(hb, observed=True).agg(trades=('R', 'size'), mean_R_E8=('R', 'mean'), mean_Rw_E8=('Rw', 'mean'), mean_R_IPFX=('R_ipfx', 'mean'), win_rate=('R', lambda s: (s > 0).mean()))
out['H3_hold_time'] = t.round(3).reset_index().astype(str).to_dict('records')

# H5 tilt: trades opened within 15 min of a losing close vs other trades (same trader)
c['prev_close'] = c.groupby('user_id').closed_at.shift(); c['prev_R'] = c.groupby('user_id').R.shift()
c['gap_min'] = (c.opened_at - c.prev_close).dt.total_seconds() / 60
tilt = (c.prev_R < 0) & (c.gap_min.between(-1e9, 15))
out['H5_after_loss_15min'] = dict(trades=int(tilt.sum()), mean_Rw=round(float(c.loc[tilt, 'Rw'].mean()), 3), others_mean_Rw=round(float(c.loc[~tilt, 'Rw'].mean()), 3),
                                  share_of_all_trades=round(float(tilt.mean()), 3))
# trades after 2+ losses in the day
c['day_loss_count'] = c.groupby(['user_id', 'day']).R.transform(lambda s: (s < 0).cumsum().shift().fillna(0))
lb = pd.cut(c.day_loss_count, [-1, 0, 1, 2, 4, 1e9], labels=['0', '1', '2', '3-4', '5+'])
out['H5_by_prior_losses_today'] = c.groupby(lb, observed=True).agg(trades=('R', 'size'), mean_Rw=('Rw', 'mean')).round(3).reset_index().astype(str).to_dict('records')

# H7 size escalation after losses (martingale): risk of next trade vs previous, after a loss
c['prev_risk'] = c.groupby('user_id').risk_ret.shift()
esc = (c.prev_R < 0) & (c.risk_ret > 1.5 * c.prev_risk)
out['H7_size_up_50pct_after_loss'] = dict(trades=int(esc.sum()), share=round(float(esc.mean()), 3), mean_Rw=round(float(c.loc[esc, 'Rw'].mean()), 3))

# H10 day-level vs trade-level score agreement
rows = []
for u, t in c.groupby('user_id'):
    if len(t) < 20: continue
    d = t.groupby('day').ret_base.sum()
    st = t.Rw.mean() * np.sqrt(len(t)) / max(t.Rw.std(ddof=1), .5)
    sd = d.mean() * np.sqrt(len(d)) / d.std(ddof=1) if len(d) > 2 and d.std(ddof=1) > 0 else np.nan
    rows.append(dict(n=len(t), days=len(d), trade_score=st, day_score=sd))
H = pd.DataFrame(rows)
out['H10_trade_vs_day_score'] = dict(traders=len(H), corr=round(float(H.trade_score.corr(H.day_score)), 2),
                                     median_ratio_day_over_trade=round(float((H.day_score / H.trade_score).median()), 2))

# Symbol mix and E8-cost edge by symbol (winsorised)
s = c.groupby('symbol').agg(trades=('R', 'size'), mean_Rw=('Rw', 'mean'), costR=('costR', 'median')).sort_values('trades', ascending=False).head(10)
out['by_symbol'] = s.round(3).reset_index().astype(str).to_dict('records')

# Hour of day (UTC) E8-cost result
hr = c.groupby(c.opened_at.dt.hour).agg(trades=('R', 'size'), mean_Rw=('Rw', 'mean'))
out['by_hour'] = hr.round(3).reset_index().astype(str).to_dict('records')
json.dump(out, open('hypotheses.json', 'w'), indent=1)
print(json.dumps(out, indent=1))
