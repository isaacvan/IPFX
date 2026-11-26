# E8 replay: re-price every real-rules IPFX trade as if it had been placed on E8 Markets, then
# run each trader's chronological stream through E8 One challenge rules.
import pandas as pd, numpy as np, json, sys

tr = pd.read_pickle('trades.pkl'); lo = pd.read_pickle('lows.pkl'); sp = pd.read_pickle('spread.pkl')
num = ['volume','initial_volume','open_price','close_price','sl','tp','initial_sl','initial_risk_usd','pnl','commission','starting_balance','stage']
for c in num: tr[c] = pd.to_numeric(tr[c], errors='coerce')
for c in ['opened_at','closed_at']: tr[c] = pd.to_datetime(tr[c], utc=True, format='ISO8601')
for c in ['e8_avg','ipfx_avg','e8_spread_med','ipfx_spread_med']: sp[c] = pd.to_numeric(sp[c])
lo['low_per_lot_usd'] = pd.to_numeric(lo.low_per_lot_usd); lo['contract_size'] = pd.to_numeric(lo.contract_size)

# E8 commission per lot (round turn, public schedule 2026-10-08, from cost_symbol_model) and contract sizes
E8C = {'XAUUSD':6,'XAGUSD':6,'SPXUSD':6,'NSXUSD':6,'DJI':12,'GER40':6,'JPN225':6,'BTCUSD':30,'ETHUSD':30,'LTCUSD':30,'ADAUSD':30,'SOLUSD':30}
CONTRACT = {'XAUUSD':100,'XAGUSD':5000,'SPXUSD':10,'NSXUSD':10,'DJI':10,'GER40':10,'JPN225':10,'BTCUSD':1,'ETHUSD':1,'LTCUSD':1}
QUOTE = {'USDJPY':'JPY','GBPJPY':'JPY','EURJPY':'JPY','USDCAD':'CAD','EURCAD':'CAD','AUDCAD':'CAD','USDCHF':'CHF','EURGBP':'GBP','GER40':'EUR','JPN225':'JPY'}
spd = sp.set_index('symbol')

c = tr[(tr.status == 'closed') & (tr.challenge_type != 'demo') & tr.pnl.notna() & tr.volume.notna()].copy()
c = c.merge(lo[['trade_id','low_per_lot_usd','contract_size']], left_on='id', right_on='trade_id', how='left')
c['contract'] = c.contract_size.fillna(c.symbol.map(CONTRACT)).fillna(100000)

def to_usd(sym, amount_quote, price):
    q = QUOTE.get(sym, 'USD')
    if q == 'USD': return amount_quote
    if sym.startswith('USD'): return amount_quote / price       # USDJPY, USDCAD, USDCHF
    # crosses: rough fixed conversion (only ~2% of trades)
    return amount_quote * {'JPY':1/155,'CAD':0.72,'GBP':1.30,'EUR':1.08,'CHF':1.12}[q]

def e8_adjust(row, slip_mult):
    s = row.symbol
    if s not in spd.index: return np.nan
    units = row.volume * row.contract
    e8s, ips = spd.loc[s,'e8_avg'], spd.loc[s,'ipfx_avg']
    # spread: IPFX trade paid IPFX spread once round trip; on E8 it pays E8 spread instead
    spread_diff = to_usd(s, (e8s - ips) * units, row.open_price)
    # slippage / latency: extra adverse fill of slip_mult x E8 spread per side, stops slip a further spread
    slip = to_usd(s, slip_mult * e8s * units * (2 + (1 if row.close_reason == 'sl' else 0)), row.open_price)
    e8_comm = E8C.get(s, 5) * row.volume
    ipfx_comm = row.commission if pd.notna(row.commission) else 0.0
    return -spread_diff - slip - e8_comm + ipfx_comm

# account balance before each trade, to express each trade as % of the account (same % sizing on E8)
c = c.sort_values(['account_id','closed_at'])
c['bal_before'] = c.starting_balance + c.groupby('account_id').pnl.cumsum() - c.pnl
for name, m in [('opt',0.0),('base',0.25),('pess',0.6)]:
    c['adj_'+name] = c.apply(lambda r: e8_adjust(r, m), axis=1)
    c['ret_'+name] = (c.pnl + c['adj_'+name]) / c.bal_before
c['ret_ipfx'] = c.pnl / c.bal_before
c['low_ret'] = (c.low_per_lot_usd * c.volume) / c.bal_before        # worst floating (<=0) as % of account, IPFX prices
c['low_ret'] = c[['low_ret','ret_base']].min(axis=1).where(c.low_ret.notna(), np.minimum(c.ret_base, 0))
# risk in R: opening risk when recorded, else distance to stop, else |worst floating|
risk_usd = c.initial_risk_usd
dist = (c.open_price - c.sl).abs() * c.volume * c.contract
risk_usd = risk_usd.fillna(c.apply(lambda r: to_usd(r.symbol, abs(r.open_price - r.sl) * r.volume * r.contract, r.open_price) if pd.notna(r.sl) else np.nan, axis=1))
c['risk_ret'] = risk_usd / c.bal_before
c.to_pickle('replayed.pkl')
print('trades replayed', len(c), 'unpriced', c.ret_base.isna().sum())
print(c.groupby('symbol')[['ret_ipfx','ret_base']].mean().mul(100).round(3).sort_values('ret_ipfx').head(12).to_string())
print('mean %% per trade  ipfx %.3f  e8 opt %.3f base %.3f pess %.3f' % tuple(c[k].mean()*100 for k in ['ret_ipfx','ret_opt','ret_base','ret_pess']))
print('cost per trade (base) as %% of account: mean %.3f median %.3f' % ((c.adj_base/c.bal_before).mean()*100, (c.adj_base/c.bal_before).median()*100))
