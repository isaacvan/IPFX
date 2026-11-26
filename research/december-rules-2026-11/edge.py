# Is there real, persistent edge? Cross-sectional tests on E8-cost returns.
import pandas as pd, numpy as np
rng = np.random.default_rng(7)
c = pd.read_pickle('replayed.pkl').sort_values('opened_at')
c = c[c.ret_base.notna()]
# R multiple per trade: E8-cost return / opening risk (fallback: trader's median risk)
med_risk = c.groupby('user_id').risk_ret.transform('median')
risk = c.risk_ret.fillna(med_risk).fillna(c.risk_ret.median()).clip(lower=0.0005)
c['R'] = c.ret_base / risk
c['R_ipfx'] = c.ret_ipfx / risk
c.to_pickle('replayedR.pkl')

g = c.groupby('user_id')
stats = pd.DataFrame({'n': g.size(), 'meanR': g.R.mean(), 'sdR': g.R.std(), 'meanR_ipfx': g.R_ipfx.mean(),
                      'mean_ret': g.ret_base.mean(), 'days': g.opened_at.apply(lambda s: s.dt.floor('D').nunique())})
stats['t'] = stats.meanR / (stats.sdR.clip(lower=0.5) / np.sqrt(stats.n))
print('pooled mean R per trade: E8 base %.3f  IPFX %.3f  (n=%d trades, %d traders)' % (c.R.mean(), c.R_ipfx.mean(), len(c), len(stats)))
print('share of traders with positive mean R (E8 base): all %.1f%%, n>=20 %.1f%%, n>=50 %.1f%%' % (
    (stats.meanR > 0).mean()*100, (stats[stats.n>=20].meanR > 0).mean()*100, (stats[stats.n>=50].meanR > 0).mean()*100))

# 1) Sign-flip null: if nobody had edge (mean 0 after costs), how many t>2 / t>3 would we expect?
for nmin in [20, 50]:
    S = stats[stats.n >= nmin]
    obs2, obs3 = (S.t > 2).sum(), (S.t > 3).sum()
    sims2, sims3 = [], []
    for _ in range(2000):
        k2 = k3 = 0
        for uid in S.index:
            x = c.loc[c.user_id == uid, 'R'].values if False else None
        sims2.append(0)
    # faster: per-trader demeaned bootstrap
    groups = {u: c.loc[c.user_id == u, 'R'].values for u in S.index}
    T = []
    for _ in range(1000):
        tt = []
        for u, x in groups.items():
            y = (x - x.mean()) * rng.choice([-1, 1], len(x))
            tt.append(y.mean() / (max(y.std(ddof=1), 0.5) / np.sqrt(len(y))))
        T.append(tt)
    T = np.array(T)
    print(f'n>={nmin}: traders={len(S)}  observed t>2: {obs2}  t>3: {obs3}  | expected under no-edge null: t>2 {np.mean((T>2).sum(1)):.1f} (95th pct {np.percentile((T>2).sum(1),95):.0f}), t>3 {np.mean((T>3).sum(1)):.2f}')

# 2) Persistence: does the first half predict the second half? (traders with >= 20 trades)
rows = []
for u, x in c.groupby('user_id'):
    if len(x) < 20: continue
    h = len(x) // 2
    a, b = x.R.values[:h], x.R.values[h:]
    rows.append(dict(user=u, n=len(x), first=a.mean(), second=b.mean(), t_first=a.mean()/(max(a.std(ddof=1),0.5)/np.sqrt(len(a)))))
P = pd.DataFrame(rows)
print('persistence (n>=20, %d traders): corr(first-half mean R, second-half mean R) = %.2f; Spearman %.2f' % (len(P), P['first'].corr(P['second']), P['first'].corr(P['second'], method='spearman')))
top = P[P.t_first > 1]; bot = P[P.t_first <= 1]
print('  first-half t>1: %d traders, their second-half mean R %.3f | others: %d traders, second-half mean R %.3f' % (len(top), top.second.mean(), len(bot), bot.second.mean()))
top = P[P['first'] > 0]
print('  first-half mean R > 0: %d traders -> second-half mean R %.3f (positive in %d of them)' % (len(top), top.second.mean(), (top.second > 0).sum()))

# 3) Empirical Bayes: how much true spread in edge is there beyond noise?
S = stats[stats.n >= 10].copy()
S['se2'] = (S.sdR.clip(lower=0.5) ** 2) / S.n
var_obs = S.meanR.var(); noise = S.se2.mean()
print('EB (n>=10, %d traders): var(observed means)=%.3f, mean noise var=%.3f -> true-edge SD ~ %.3f R; grand mean %.3f R' % (len(S), var_obs, noise, np.sqrt(max(var_obs - noise, 0)), S.meanR.mean()))
stats.to_pickle('trader_stats.pkl'); P.to_pickle('persistence.pkl')
print(stats.sort_values('t', ascending=False).head(12).round(3).to_string())
