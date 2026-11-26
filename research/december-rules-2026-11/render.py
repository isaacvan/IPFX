import json, numpy as np, pandas as pd, html
D = pd.read_pickle('ranked.pkl'); MUS = np.array(json.load(open('rulesim2.json'))['mus'])
E = pd.read_pickle('econ_final.pkl'); sim = pd.read_pickle('e8sim.pkl'); c = pd.read_pickle('replayedR.pkl')
cur = D[D.i == 0].iloc[0]; rec = D[D.i == 100].iloc[0]
T = open('report_template.html', encoding='utf-8').read()
pct = lambda x: f'{x*100:.1f}%' if x >= 0.001 or x == 0 else f'{x*100:.2f}%'

def card(tag, title, items, why):
    li = ''.join(f'<li>{i}</li>' for i in items)
    return f'<div class="card"><div class="tag">{tag}</div><h3>{title}</h3><ul>{li}</ul><p class="why">{why}</p></div>'
cards = card('Stage 1 · free · $10,000 simulated', 'E8 One, exactly', [
    'Profit target <b>6%</b> of closed profit',
    'Daily loss <b>3%</b> of the starting balance, measured from each day\'s starting balance, floating losses included. Hard breach.',
    'Dynamic drawdown <b>4%</b> below the highest closed balance. It only rises when profit is closed, and stops rising once it reaches the starting balance.',
    'No minimum days, no consistency rule, no score, no minimum trades',
    'News and weekend holding allowed. Leverage up to 1:30 on FX, 1:15 on indices and metals.',
    'Not allowed: putting the whole daily limit on one trade, and hedging between accounts',
    'At least one closed trade every 60 days'],
    'Matches the E8 One preset in E8\'s help centre, so a pass means the trader stayed inside E8\'s risk rules. In our data that alone does not show edge: 20% to 55% of simulated Stage 1 passers have none.')
cards += card('Stage 2 · $5,000 simulated', 'Show your edge', [
    'Profit target <b>6%</b>, risk up to <b>0.5%</b> per counted trade',
    'Maximum drawdown <b>8%</b> of the starting balance (fixed), daily loss <b>3%</b>',
    'At least <b>40 counted trades</b> over at least <b>10 trading days</b>',
    'Consistency score at least <b>1.5</b> on Stage 2 trades (each trade capped at +5R, as now)',
    'Best day no more than <b>40%</b> of profit; biggest 3 winning trades no more than <b>50%</b> of profit',
    'Profit share held, as now. Verify identity to move up.'],
    'Lottery wins cannot carry a pass: the +5R cap and the top-3 rule stop one or two huge trades counting as proof. After a Stage 2 pass, simulated no-edge share falls to 0.1% to 5%. This is where IPFX starts copying.')
cards += card('Stage 3 · $10,000 simulated', 'Prove it again', [
    'Fresh account: profit target <b>6%</b>, risk up to <b>0.5%</b>, drawdown <b>8%</b> fixed, daily loss <b>3%</b>',
    'At least <b>60 new counted trades</b> over at least <b>15 trading days</b>',
    'Score at least <b>1.5</b> on Stage 3 trades alone, <b>and</b> at least <b>3.0</b> on Stage 2 and 3 trades together',
    'Best day no more than <b>35%</b> of profit; biggest 3 winning trades no more than <b>40%</b> of profit',
    'Then pay: 85% of eligible Stage 2 and 3 profit, up to <b>$700</b>, minimum $500 (unchanged)'],
    'A combined score of 3.0 over about 100 or more trades means a result that random trading reaches about 1 time in 750. Repeating it on fresh Stage 3 trades rules out a lucky streak in Stage 2.')
T = T.replace('{{STAGE_CARDS}}', cards)
T = T.replace('{{RULE_NOTES}}', '<div class="note"><b>What changes from today.</b> Stage 1 drops the 20-trade minimum and the score, and uses E8\'s target and limits instead. Stages 2 and 3 move to 6% targets with a wider fixed 8% drawdown, add minimum trading days and a top-3-trades limit, and Stage 3 must pass on its own trades as well as combined (combined now means Stages 2 and 3 only, not Stage 1). Stage 4 is unchanged. Payout amounts are unchanged.</div>')

# --- power chart (SVG) ---
W, H, L, B, TOP, RGT = 760, 330, 56, 46, 18, 150
xs = lambda m: L + (m - (-0.2)) / (0.6 - (-0.2)) * (W - L - RGT)
ys = lambda p: TOP + (1 - p) * (H - TOP - B)
sel = MUS >= -0.2
series = [('Recommended · disciplined', rec['disciplined']['p'], 'var(--accent)', ''), ('Current v2 · disciplined', cur['disciplined']['p'], 'var(--muted)', ''),
          ('Recommended · our traders\' shape', rec['real']['p'], 'var(--accent)', '6 4'), ('Current v2 · our traders\' shape', cur['real']['p'], 'var(--muted)', '6 4')]
svg = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="Chance of being paid by true edge">']
for p in [0, .25, .5, .75, 1]:
    svg.append(f'<line x1="{L}" x2="{W-RGT}" y1="{ys(p):.1f}" y2="{ys(p):.1f}" stroke="var(--line)"/><text x="{L-8}" y="{ys(p)+4:.1f}" text-anchor="end" font-size="12" fill="var(--muted)">{int(p*100)}%</text>')
for m in [-0.2, 0, 0.1, 0.2, 0.3, 0.4, 0.6]:
    svg.append(f'<text x="{xs(m):.1f}" y="{H-B+18}" text-anchor="middle" font-size="12" fill="var(--muted)">{m:+.1f}R</text>')
svg.append(f'<line x1="{xs(0):.1f}" x2="{xs(0):.1f}" y1="{TOP}" y2="{H-B}" stroke="var(--bad)" stroke-dasharray="3 3"/>')
svg.append(f'<text x="{xs(0)+4:.1f}" y="{TOP+12}" font-size="12" fill="var(--bad)">no edge</text>')
svg.append(f'<text x="{(L+W-RGT)/2:.0f}" y="{H-6}" text-anchor="middle" font-size="12" fill="var(--muted)">True edge per counted trade, after E8 costs</text>')
ly = TOP + 8
for name, p, col, dash in series:
    p = np.array(p)[sel]; m = MUS[sel]
    pts = ' '.join(f'{xs(a):.1f},{ys(b):.1f}' for a, b in zip(m, p))
    svg.append(f'<polyline points="{pts}" fill="none" stroke="{col}" stroke-width="2.4" stroke-dasharray="{dash}"/>')
    svg.append(f'<line x1="{W-RGT+12}" x2="{W-RGT+34}" y1="{ly}" y2="{ly}" stroke="{col}" stroke-width="2.4" stroke-dasharray="{dash}"/><text x="{W-RGT+40}" y="{ly+4}" font-size="11" fill="var(--fg)">{html.escape(name)}</text>')
    ly += 22
svg.append('</svg>')
T = T.replace('{{CHART_POWER}}', ''.join(svg))

show = [-0.2, -0.1, 0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.6]
ix = lambda m: int(np.argmin(np.abs(MUS - m)))
hdr = '<tr><th>Chance of being paid</th>' + ''.join(f'<th>{m:+.2f}R</th>' for m in show) + '</tr>'
def row(n, arr): return f'<tr><td>{n}</td>' + ''.join(f'<td class="n">{pct(arr[ix(m)])}</td>' for m in show) + '</tr>'
T = T.replace('{{TABLE_POWER}}', '<table>' + hdr + row('Recommended, disciplined style', rec['disciplined']['p']) + row('Current v2, disciplined style', cur['disciplined']['p'])
              + row('Recommended, our traders\' shape', rec['real']['p']) + row('Current v2, our traders\' shape', cur['real']['p']) + '</table>')
T = T.replace('{{POWER_NOTE}}', 'Simulated: 1,500 traders per edge level and style. Stage 1 is not included here; it is a separate E8-style filter. A disciplined trader with a +0.2R edge needs about 230 counted trades to be paid (about 3 months at the pace of our active traders); a +0.3R trader about 136. For disciplined traders the recommended rules cut paid zero-edge traders from 2.9% to 0.7%, pay fewer traders with a tiny edge (+0.05R to +0.1R), and pay slightly more at +0.2R and above. For traders whose profits come in rare big wins (our traders\' shape) they are stricter: a +0.3R trader of that kind is paid 10% of the time instead of 19%, because big wins count for less. That is the price of not paying lucky streaks. 129 rule sets were compared; drawdown size, target and trade minimums changed results little, the combined score threshold mattered most.')

def erow(k, lab):
    r = E.loc[k]; return f"<tr><td>{lab}</td><td class='n'>{r.share_paid_no_edge*100:.2f}%</td><td class='n'>{r.share_paid_edge_ge_0_2*100:.0f}%</td><td class='n'>{r.mean_edge_paid:+.2f}R</td><td class='n'>${r.copy_value_per_paid:,.0f}</td></tr>"
econ = ('<p>IPFX makes money from a paid trader by copying their trades onto E8 accounts. If their edge is real, that is worth far more than the payout. The question is how many paid traders have no edge. The table below assumes the population we have today (average edge −0.42R, spread 0.45R), and copying each paid trader for 3 months at $250 per R on E8 (80% kept), at their observed pace of about 72 trades a month.</p>'
        '<div class="tbl"><table><tr><th>Rules · style</th><th>Paid traders with no edge</th><th>Paid traders at +0.2R or better</th><th>Average edge of paid traders</th><th>Copy value per paid trader, 3 months</th></tr>'
        + erow(('recommended', 'disciplined', 'today'), 'Recommended · disciplined') + erow(('current', 'disciplined', 'today'), 'Current v2 · disciplined')
        + erow(('recommended', 'real', 'today'), 'Recommended · our traders\' shape') + erow(('current', 'real', 'today'), 'Current v2 · our traders\' shape') + '</table></div>'
        '<ul style="margin:0;padding-left:20px;display:grid;gap:6px;max-width:72ch">'
        '<li><b>Paying at Stage 3 is profitable</b> if copying runs: one paid trader is worth roughly $14,000 to $22,000 of copy profit over 3 months, against a $700 payout. Even a payout of a few thousand dollars would be covered.</li>'
        '<li><b>Do not copy at full size after Stage 1.</b> In simulation 20% (disciplined) to 55% (our traders\' shape) of Stage 1 passers have no edge, and the 7 real E8 passes did not hold up. Start copying after a Stage 2 pass, when the no-edge share is 0.1% to 5%.</li>'
        '<li>These figures assume copied fills match the trader\'s. Copy latency and E8 fills will take some of the edge; check it on the first copied traders before raising copy size or payouts.</li>'
        '<li>Expect very few payouts at first. At today\'s activity about 2 traders a month would pass Stage 1, and a Stage 3 payout needs 100 or more counted trades after that.</li></ul>')
T = T.replace('{{ECON_BLOCK}}', econ)

names = {'ret_ipfx': 'IPFX prices (no change)', 'ret_opt': 'E8, low costs', 'ret_base': 'E8, central estimate', 'ret_pess': 'E8, high costs'}
rows = ''
for (rname, ret), df in sim.items():
    fin = df[df.result != 'unfinished']; p = int((df.result == 'pass').sum())
    rows += f"<tr><td>{html.escape(rname)}</td><td>{names[ret]}</td><td class='n'>{len(df)}</td><td class='n'>{len(fin)}</td><td class='n'><b>{p}</b></td><td class='n'>{int(df[df.result=='pass'].user_id.nunique())}</td><td class='n'>{int((df.result=='breach_daily').sum())}</td><td class='n'>{int((df.result=='breach_dd').sum())}</td></tr>"
T = T.replace('{{TABLE_E8}}', '<table><tr><th>E8 rules</th><th>Costs</th><th>Attempts</th><th>Finished</th><th>Passes</th><th>Traders passing</th><th>Daily-loss breaches</th><th>Drawdown breaches</th></tr>' + rows + '</table>')
P = sim[('E8 One preset (help centre)', 'ret_base')]; prow = ''
cs = c.sort_values('opened_at')
for k, uid in enumerate(P[P.result == 'pass'].user_id.unique(), 1):
    t = cs[cs.user_id == uid].reset_index(drop=True); a = P[(P.user_id == uid) & (P.result == 'pass')].iloc[0]
    pre = t.iloc[a.start:a.end]; post = t.iloc[a.end:]
    after = 'no more trades' if not len(post) else f"{len(post)} trades, {post.ret_base.sum()*100:+.2f}% of account"
    prow += f"<tr><td>Trader {k}</td><td class='n'>{int(a.n)}</td><td class='n'>{int(a.days)}</td><td class='n'>{pre.R.max():.1f}R</td><td class='n'>{pre.R.mean():+.2f}R</td><td>{after}</td></tr>"
T = T.replace('{{TABLE_PASSERS}}', '<table><tr><th>E8 pass</th><th>Trades to pass</th><th>Days</th><th>Biggest win</th><th>Average per trade</th><th>Afterwards</th></tr>' + prow + '</table>')

# histogram of trader mean R (winsorised), n>=20
c2 = c.copy(); c2['Rw'] = c2.R.clip(-3, 5); g = c2.groupby('user_id'); m = g.Rw.mean()[g.size() >= 20]
bins = np.arange(-2.0, 1.26, 0.25); h, _ = np.histogram(m.clip(-1.99, 1.24), bins)
W2, H2, L2, B2 = 760, 250, 46, 44; bw = (W2 - L2 - 16) / len(h); mx = max(h)
s = [f'<svg viewBox="0 0 {W2} {H2}" role="img" aria-label="Average result per trade for each trader with 20 or more trades">']
for v in range(0, mx + 1, 5):
    y = 16 + (1 - v / mx) * (H2 - 16 - B2); s.append(f'<line x1="{L2}" x2="{W2-16}" y1="{y:.1f}" y2="{y:.1f}" stroke="var(--line)"/><text x="{L2-8}" y="{y+4:.1f}" text-anchor="end" font-size="12" fill="var(--muted)">{v}</text>')
for k, v in enumerate(h):
    x = L2 + k * bw; y = 16 + (1 - v / mx) * (H2 - 16 - B2); col = 'var(--good)' if bins[k] >= 0 else 'var(--bad)'
    s.append(f'<rect x="{x+2:.1f}" y="{y:.1f}" width="{bw-4:.1f}" height="{H2-B2-y:.1f}" fill="{col}" opacity="0.85"/>')
for k, b in enumerate(bins):
    if k % 2 == 0: s.append(f'<text x="{L2+k*bw:.1f}" y="{H2-B2+18}" text-anchor="middle" font-size="12" fill="var(--muted)">{b:+.1f}R</text>')
s.append(f'<text x="{W2/2:.0f}" y="{H2-6}" text-anchor="middle" font-size="12" fill="var(--muted)">Average result per trade at E8 costs (each trade capped at −3R and +5R), {len(m)} traders with 20+ trades</text></svg>')
T = T.replace('{{CHART_HIST}}', ''.join(s))

T = T.replace('{{N_RULESETS}}', '129').replace('{{N_TRADES}}', f'{len(c):,}').replace('{{N_TRADERS}}', f'{c.user_id.nunique()}')
T = T.replace('{{V_LUCK}}', '0.7%').replace('{{V_LUCK_TEXT}}', 'of zero-edge traders would be paid under the recommended rules (2.9% under today\'s v2), while 77% of +0.2R traders still get paid')
T = T.replace('{{NEXT_STEPS}}', '<ol class="steps">'
    '<li>Choose the Stage 1 preset: the help centre E8 One preset used here (6% / 3% / 4%), or the website\'s $100K default (9% / 4% / 6%). The website default would have passed only 2 of our traders.</li>'
    '<li>Confirm account sizes: $10,000 for Stage 1 (finer lot sizes than $1,000), $5,000 and $10,000 for Stages 2 and 3, payout unchanged.</li>'
    '<li>Engine changes, none made yet: E8 dynamic drawdown with lock at the starting balance; fixed drawdown for Stages 2 and 3; minimum trading days; top-3-trades rule; Stage 3 own score; combined score over Stages 2 and 3 only; remove the Stage 1 score and 20-trade minimum.</li>'
    '<li>Terms update (new version) and the rules page, then the held mobile email rewritten with the new stage structure. 240 copies of the old email went out before the hold; 2,249 are held.</li>'
    '<li>Copy policy: begin copying on E8 at small size after a Stage 2 pass, and compare copied results with the trader\'s own for the first 100 copied trades before increasing size.</li></ol>')
open('IPFX-December-Rules.html', 'w', encoding='utf-8').write(T)
assert '{{' not in T, [x for x in T.split('{{')[1:]][:3]
print('ok', len(T))
