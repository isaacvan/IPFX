# Grid search of Stage 2 + Stage 3 rules, two trader styles, with company economics.
import numpy as np, pandas as pd, json, sys, itertools, time
rng = np.random.default_rng(23)
c = pd.read_pickle('replayedR.pkl')
g = c.groupby('user_id'); keep = g.size()[g.size() >= 10].index
res_real = (c[c.user_id.isin(keep)].R - c[c.user_id.isin(keep)].groupby('user_id').R.transform('mean')).values
res_real = np.clip(res_real, -6, 60); res_real -= res_real.mean()

def draw(style, mu, n):
    if style == 'real':
        return mu + res_real[rng.integers(len(res_real), size=n)]
    # disciplined: fixed stop (-1R, a little slippage) and 1.5R targets; win prob set so the mean is mu
    p = (mu + 1.0) / 2.5
    win = rng.random(n) < p
    return np.where(win, 1.5, -1.0) + rng.normal(0, 0.08, n)

def score(R, cap=5.0, floor=0.5):
    Rc = np.minimum(R, cap); n = len(Rc)
    return Rc.mean() * np.sqrt(n) / max(Rc.std(ddof=1), floor) if n > 1 else -9

def run_stage(style, mu, rule, prior_R=None, max_trades=600):
    risk = rule['risk']; R = draw(style, mu, max_trades)
    perday = rng.poisson(3, max_trades) + 1
    bal = high = day_start = 0.0; tday = 0; di = 0; days = []
    for k in range(max_trades):
        if tday >= perday[di]:
            days.append(bal - day_start); day_start = bal; tday = 0; di += 1
        r = R[k]
        floor_dd = (min(high - rule['dd'], 0.0) if rule['trailing'] else -rule['dd'])
        worst = bal - risk * (1.0 if r < 0 else 0.4)
        if worst <= day_start - rule['daily'] or worst <= floor_dd: return False, R[:k + 1], k + 1
        bal += r * risk; tday += 1; high = max(high, bal)
        if bal <= day_start - rule['daily'] or bal <= floor_dd: return False, R[:k + 1], k + 1
        n = k + 1
        if n < rule['min_trades'] or bal < rule['target']: continue
        dd = days + [bal - day_start]
        if len(dd) < rule['min_days']: continue
        if max(dd) / bal > rule['best_day']: continue
        Ra = R[:n]
        wins = np.sort(Ra[Ra > 0])[::-1]
        if wins[:3].sum() * risk / bal > rule['top3']: continue
        if score(Ra) < rule['score']: continue
        if prior_R is not None and score(np.concatenate([prior_R, Ra])) < rule['combined']: continue
        return True, Ra, n
    return False, R, max_trades

MUS = np.array([-0.6, -0.4, -0.2, -0.1, 0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6])
base2 = dict(risk=0.005, daily=0.03, trailing=False, min_days=10, best_day=0.40, top3=0.50)
base3 = dict(risk=0.005, daily=0.03, trailing=False, min_days=15, best_day=0.35, top3=0.40)
GRID = []
for dd, tgt, n2, s2, n3, s3, comb in itertools.product([0.06, 0.08], [0.04, 0.06], [40, 60], [1.5, 2.0], [60, 100], [1.0, 1.5], [2.5, 3.0]):
    GRID.append((dict(base2, dd=dd, target=tgt, min_trades=n2, score=s2, combined=None),
                 dict(base3, dd=dd, target=tgt, min_trades=n3, score=s3, combined=comb)))
CURRENT = (dict(risk=0.0035, daily=0.02, dd=0.04, trailing=False, target=0.07, min_trades=40, min_days=0, best_day=0.35, top3=9, score=1.65, combined=None),
           dict(risk=0.0035, daily=0.02, dd=0.04, trailing=False, target=0.08, min_trades=50, min_days=0, best_day=0.30, top3=9, score=-99, combined=2.0))
N = int(sys.argv[1]) if len(sys.argv) > 1 else 600
rows = []
t0 = time.time()
for gi, (s2, s3) in enumerate([CURRENT] + GRID):
    for style in ['real', 'disciplined']:
        p3 = []
        for mu in MUS:
            k = 0; tr = []
            for _ in range(N):
                ok2, R2, n2 = run_stage(style, mu, s2)
                if ok2:
                    ok3, R3, n3 = run_stage(style, mu, s3, prior_R=R2)
                    if ok3: k += 1; tr.append(n2 + n3)
            p3.append(k / N)
        rows.append(dict(i=gi, style=style, s2=s2, s3=s3, p=p3))
    if gi % 8 == 0: print(gi, len(GRID), round(time.time() - t0), flush=True)
json.dump(dict(mus=MUS.tolist(), rows=rows), open('rulesim2.json', 'w'))
print('done', round(time.time() - t0))
