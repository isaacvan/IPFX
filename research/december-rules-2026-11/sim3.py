# (a) Same-day clustering (ICC 0.20 measured) vs per-trade score; day-based score fix.
# (b) Restart luck over 12 months: per-attempt scoring vs lifetime scoring (failed attempts stay on record).
import numpy as np, pandas as pd, json, time
from multiprocessing import Pool
c = pd.read_pickle('replayedR.pkl')
g = c.groupby('user_id'); keep = g.size()[g.size() >= 10].index
RES = (c[c.user_id.isin(keep)].R - c[c.user_id.isin(keep)].groupby('user_id').R.transform('mean')).values
RES = np.clip(RES, -6, 60); RES = RES - RES.mean()
ICC = 0.20
S2 = dict(risk=0.005, daily=0.03, dd=0.08, target=0.06, min_trades=40, min_days=10, best_day=0.40, top3=0.50, score=1.5)
S3 = dict(risk=0.005, daily=0.03, dd=0.08, target=0.06, min_trades=60, min_days=15, best_day=0.35, top3=0.40, score=1.5, combined=3.0)

def trades(rng, style, mu, n, cluster):
    perday = rng.poisson(2.4, n) + 1
    day = np.repeat(np.arange(n), perday)[:n]
    if style == 'disciplined':
        p = (mu + 1) / 2.5
        if cluster:   # good days and bad days: shift win probability per day, keeping the mean
            shift = rng.normal(0, 0.18, n)[day]
            win = rng.random(n) < np.clip(p + shift, 0.01, 0.99)
        else:
            win = rng.random(n) < p
        R = np.where(win, 1.5, -1.0) + rng.normal(0, .08, n)
    else:
        e = RES[rng.integers(len(RES), size=n)]
        if cluster:
            sd = RES.std(); e = np.sqrt(1 - ICC) * e + np.sqrt(ICC) * rng.normal(0, sd, n)[day]
        R = mu + e
    return R, day

def tscore(R, cap=5, floor=.5):
    Rc = np.minimum(R, cap); n = len(Rc)
    return Rc.mean() * np.sqrt(n) / max(Rc.std(ddof=1), floor) if n > 1 else -9

def dscore(R, day, cap=5, floor=.5):
    Rc = np.minimum(R, cap); s = pd.Series(Rc).groupby(day).sum().values
    if len(s) < 3: return -9
    # per-trade scale so thresholds stay comparable: t on daily sums
    return s.mean() * np.sqrt(len(s)) / max(s.std(ddof=1), floor)

def stage(rng, style, mu, rule, sc, prior=None, lifetime=None, max_trades=600, cluster=True):
    R, day = trades(rng, style, mu, max_trades, cluster)
    risk = rule['risk']; bal = high = ds = 0.0; cur = -1; dp = {}
    for k in range(max_trades):
        if day[k] != cur: cur = day[k]; ds = bal
        r = R[k]
        if bal - risk * (1 if r < 0 else .4) <= min(ds - rule['daily'], 9) or bal - risk * (1 if r < 0 else .4) <= -rule['dd']: return False, R[:k+1], day[:k+1]
        bal += r * risk; dp[cur] = dp.get(cur, 0) + r * risk
        if bal <= ds - rule['daily'] or bal <= -rule['dd']: return False, R[:k+1], day[:k+1]
        n = k + 1
        if n < rule['min_trades'] or bal < rule['target'] or len(dp) < rule['min_days'] or max(dp.values()) / bal > rule['best_day']: continue
        Ra = R[:n]; w = np.sort(Ra[Ra > 0])[::-1]
        if w[:3].sum() * risk / bal > rule['top3']: continue
        if sc(Ra, day[:n]) < rule['score']: continue
        if prior is not None:
            PR, PD = prior
            allR = np.concatenate([PR, Ra]); allD = np.concatenate([PD, day[:n] + PD.max() + 1])
            if sc(allR, allD) < rule['combined']: continue
        if lifetime is not None:
            LR, LD = lifetime
            allR = np.concatenate([LR, Ra]); allD = np.concatenate([LD, day[:n] + (LD.max() + 1 if len(LD) else 0)])
            if sc(allR, allD) < rule['combined']: continue
        return True, Ra, day[:n]
    return False, R, day

def one(args):
    style, mu, variant, seed, N = args
    rng = np.random.default_rng(seed); paid = 0
    for _ in range(N):
        if variant in ('iid_trade', 'clustered_trade', 'clustered_day'):
            cl = variant != 'iid_trade'; sc = dscore if variant == 'clustered_day' else (lambda R, d: tscore(R))
            ok2, R2, D2 = stage(rng, style, mu, S2, sc, cluster=cl)
            if ok2:
                ok3, _, _ = stage(rng, style, mu, S3, sc, prior=(R2, D2), cluster=cl)
                paid += ok3
        else:  # 12 months of restarts, ~864 trades budget; per-attempt vs lifetime
            sc = lambda R, d: tscore(R); LR = np.array([]); LD = np.array([], dtype=int); used = 0; got = False
            while used < 864 and not got:
                ok2, R2, D2 = stage(rng, style, mu, S2, sc, lifetime=None if variant == 'restarts_per_attempt' else None, cluster=True)
                used += len(R2)
                if variant == 'restarts_lifetime':
                    # Stage 2 must also clear score 1.5 on the lifetime record
                    if ok2 and tscore(np.concatenate([LR, R2])) < S2['score']: ok2 = False
                    LR = np.concatenate([LR, R2]); LD = np.concatenate([LD, D2 + (LD.max() + 1 if len(LD) else 0)])
                if not ok2: continue
                ok3, R3, D3 = stage(rng, style, mu, S3, sc, prior=(R2, D2), lifetime=(LR, LD) if variant == 'restarts_lifetime' else None, cluster=True)
                used += len(R3)
                if variant == 'restarts_lifetime':
                    LR = np.concatenate([LR, R3]); LD = np.concatenate([LD, D3 + LD.max() + 1])
                got = ok3
            paid += got
    return (style, mu, variant, paid / N)

if __name__ == '__main__':
    t0 = time.time(); jobs = []
    for style in ['disciplined', 'real']:
        for mu in [0.0, 0.1, 0.2, 0.3]:
            for v in ['iid_trade', 'clustered_trade', 'clustered_day']: jobs.append((style, mu, v, hash((style, mu, v)) % 99991, 3000))
            for v in ['restarts_per_attempt', 'restarts_lifetime']: jobs.append((style, mu, v, hash((style, mu, v, 1)) % 99991, 1500))
    with Pool(20) as p: res = p.map(one, jobs)
    df = pd.DataFrame(res, columns=['style', 'mu', 'variant', 'paid'])
    print(df.pivot_table(index=['style', 'variant'], columns='mu', values='paid').mul(100).round(2).to_string())
    df.to_pickle('sim3.pkl'); print('secs', round(time.time() - t0))
