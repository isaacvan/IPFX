# P(pass E8 One preset | true edge), per style, at the observed typical risk per trade (0.38%), within 1 attempt and
# within 3 attempts (one free restart a month for a quarter).
import numpy as np, json, sys
sys.argv = sys.argv[:1] + ['1']
exec(open('rulesim2.py').read().split("MUS = np.array")[0])          # reuse draw() and residual pool
MUS = np.array([-0.6, -0.4, -0.2, -0.1, 0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6])
def e8_one(style, mu, risk=0.0038, target=0.06, daily=0.03, dd=0.04, max_trades=400):
    R = draw(style, mu, max_trades); perday = rng.poisson(3, max_trades) + 1
    bal = high = day_start = 0.0; tday = 0; di = 0
    for k in range(max_trades):
        if tday >= perday[di]: day_start = bal; tday = 0; di += 1
        floor = 0.0 if high >= dd else high - dd
        if bal - risk * (1.0 if R[k] < 0 else 0.4) <= min(day_start - daily, 9) or bal - risk * (1.0 if R[k] < 0 else 0.4) <= floor: return False, k + 1
        bal += R[k] * risk; tday += 1; high = max(high, bal)
        floor = 0.0 if high >= dd else high - dd
        if bal <= day_start - daily or bal <= floor: return False, k + 1
        if bal >= target: return True, k + 1
    return False, max_trades
N = 3000; out = {}
for style in ['real', 'disciplined']:
    p1 = []; p3 = []; tr = []
    for mu in MUS:
        res1 = [e8_one(style, mu) for _ in range(N)]
        p = np.mean([r[0] for r in res1]); p1.append(p); p3.append(1 - (1 - p) ** 3)
        tr.append(float(np.median([r[1] for r in res1 if r[0]])) if any(r[0] for r in res1) else None)
    out[style] = dict(p1=p1, p3=p3, trades=tr)
    print(style, ' '.join(f'{m:+.2f}:{p*100:5.1f}%' for m, p in zip(MUS, p1)))
json.dump(dict(mus=MUS.tolist(), **out), open('stage1sim.json', 'w'))
