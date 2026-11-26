import json, numpy as np, pandas as pd, html
R2 = json.load(open('rulesim2.json')); S1 = json.load(open('stage1sim.json'))
MUS = np.array(R2['mus'])
def prior(mean, sd):
    w = np.exp(-0.5 * ((MUS - mean) / sd) ** 2); return w / w.sum()
PRIORS = {'today': prior(-0.42, 0.45), 'better': prior(-0.15, 0.30)}
COPY_TRADES = 3 * 72; USD_PER_R = 250 * 0.8

def label(s2, s3):
    if s2['risk'] == 0.0035: return 'Current v2'
    return f"DD {s2['dd']*100:.0f}% · target {s2['target']*100:.0f}% · S2 {s2['min_trades']} trades, score {s2['score']} · S3 {s3['min_trades']} trades, score {s3['score']}, combined {s3['combined']}"

recs = {}
for r in R2['rows']:
    d = recs.setdefault(r['i'], dict(i=r['i'], s2=r['s2'], s3=r['s3'], label=label(r['s2'], r['s3'])))
    p = np.array(r['p']); s1 = np.array(S1[r['style']]['p3'])
    d[r['style']] = dict(p=p, p2=np.array(r['p2']), trades=r['trades'])
    for pn, pw in PRIORS.items():
        paid = pw * s1 * p * 1000
        n = paid.sum()
        d[(r['style'], pn)] = dict(paid=n, false=(paid[MUS <= 0].sum() / n if n > 0 else np.nan),
                                   copy_per_passer=((paid * MUS).sum() / n * COPY_TRADES * USD_PER_R if n > 0 else np.nan),
                                   mean_mu=((paid * MUS).sum() / n if n > 0 else np.nan))
D = pd.DataFrame(recs.values())
def g(d, style, key, pn='today'): return d[(style, pn)][key]
D['max_false'] = D.apply(lambda d: max(np.nan_to_num(g(d, 'real', 'false'), nan=0), np.nan_to_num(g(d, 'disciplined', 'false'), nan=0)), axis=1)
ix = lambda m: int(np.argmin(np.abs(MUS - m)))
for m in [0.0, 0.1, 0.2, 0.3]:
    D[f'pow{m}'] = D.apply(lambda d: min(d['real']['p'][ix(m)], d['disciplined']['p'][ix(m)]), axis=1)
    D[f'powR{m}'] = D.apply(lambda d: d['real']['p'][ix(m)], axis=1)
    D[f'powD{m}'] = D.apply(lambda d: d['disciplined']['p'][ix(m)], axis=1)
D['copy_min'] = D.apply(lambda d: min(g(d, 'real', 'copy_per_passer'), g(d, 'disciplined', 'copy_per_passer')), axis=1)
cur = D[D.i == 0].iloc[0]
cand = D[(D.i != 0) & (D.max_false <= 0.05) & (D['pow0.0'] <= 0.005)].sort_values(['pow0.2', 'pow0.3', 'pow0.1'], ascending=False)
print('candidates', len(cand))
print(cand[['i', 'label', 'max_false', 'pow0.0', 'pow0.1', 'pow0.2', 'pow0.3', 'copy_min']].head(12).to_string())
print('CURRENT', cur[['max_false', 'pow0.0', 'pow0.1', 'pow0.2', 'pow0.3', 'copy_min']].to_dict())
D.to_pickle('ranked.pkl')
