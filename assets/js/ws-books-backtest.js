/* Books → "Copied on E8": what every Infinity trade would have made on a $50,000 E8 account, copied in the trader's
   direction (A-book) and reverse-copied (B-book). The books are separate accounts. Real E8 sizes (0.06/0.07
   alternating = 0.065 average), E8's own bid/ask after the measured copy delay, E8 contract sizes, commission, and
   E8's $625 daily / $3,000 drawdown rules on equity marked every minute. Each book can be viewed for the traders the owner
   wants in it: A-book only traders in profit, B-book only traders not in profit (decided from what was known at the time,
   or, labelled as hindsight, from their final result), or all traders. Read-only: brain-monitor → ab_e8_copy_backtest. */
(() => {
  'use strict';
  const T = window.TeamOS, { esc, usd, ukTime } = T;
  const root = document.getElementById('e8bt');
  if (!root) return;
  let r = null, err = '', busy = false, saved = null;
  const shown = { a: 100, b: 100 }, query = { a: '', b: '' }, hideAfter = { a: false, b: false };
  const NAME = { a: 'A-book', b: 'B-book' };
  // The data key for each view: ap/ah/a for A-book, bp/bh/b for B-book (see the SQL header for the exact rules).
  const MODES = {
    a: [
      { key: 'ap', label: 'In profit when copied', what: 'copied only while the trader’s account is in profit',
        note: 'A trader’s trade is copied only if their own closed P&amp;L before that trade was above $0 (trades closed at least 2 minutes earlier). Their first trade is never copied. Only what was known at the time.' },
      { key: 'ah', label: 'Ended in profit (hindsight)', what: 'copied only for traders who ended in profit', hindsight: true,
        note: 'Traders are picked by their <b>final</b> result, which nobody knew when the trades were placed. This is a best case, not a result you could have had.' },
      { key: 'a', label: 'All traders', what: 'copied in the trader’s direction, every trader' },
    ],
    b: [
      { key: 'bp', label: 'In loss when reversed', what: 'reverse-copied only while the trader’s account is in loss',
        note: 'A trader’s trade is reversed only if their own closed P&amp;L before that trade was below $0 (trades closed at least 2 minutes earlier). Traders at exactly $0 or with no history are skipped. Only what was known at the time.' },
      { key: 'bh', label: 'Ended not in profit (hindsight)', what: 'reverse-copied only for traders who did not end in profit', hindsight: true,
        note: 'Traders are picked by their <b>final</b> result, which nobody knew when the trades were placed. This is a best case, not a result you could have had.' },
      { key: 'b', label: 'All traders', what: 'reverse-copied: the opposite of every trade, every trader' },
    ],
  };
  const mode = { a: 'ap', b: 'bp' };
  const cur = (k) => MODES[k].find((m) => m.key === mode[k]) || MODES[k][0];

  const sign = (v) => (Number(v) > 0 ? 'good' : Number(v) < 0 ? 'bad' : '');
  const money = (v) => (v == null ? '—' : `<span class="num ${sign(v)}">${usd(v)}</span>`);
  const pct = (v) => (v == null ? '—' : (Number(v) * 100).toFixed(1) + '%');
  const fixed = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
  const hold = (s) => { s = Number(s); if (!Number.isFinite(s)) return '—'; if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; return (s / 3600).toFixed(1) + 'h'; };
  const day = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d + 'T12:00:00Z'));
  const flip = (side) => (side === 'buy' ? 'sell' : 'buy');
  const when = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(t) : '—'; };
  const px = (v, sym) => (v == null ? '—' : Number(v).toFixed(/JPY/.test(sym) ? 3 : Number(v) > 50 ? 2 : 5));

  async function run() {
    if (busy) return;
    busy = true; err = ''; render();
    try { const j = await T.brain('e8_copy_backtest'); r = j.backtest; saved = j.computed_at || null; if (!r?.available) err = r?.reason || 'Not available yet'; }
    catch (e) { err = e.message; }
    finally { busy = false; render(); }
  }

  function stats(b) {
    const s = b.summary;
    const tile = (k, v, sub) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
    return `<div class="stats">
      ${tile('Net P&amp;L', money(s.net_pnl), `before costs ${usd(s.gross_pnl)}`)}
      ${tile('Trades', `<span class="num">${s.trades}</span>`, `${s.traders} traders · ${fixed(s.lots_avg, 3)} lots avg`)}
      ${tile('Win rate', `<span class="num">${pct(s.win_rate)}</span>`, `${s.wins} won · ${s.losses} lost`)}
      ${tile('Profit factor', `<span class="num ${Number(s.profit_factor) >= 1 ? 'good' : 'bad'}">${fixed(s.profit_factor)}</span>`, `${usd(s.gross_profit)} won / ${usd(-s.gross_loss)} lost`)}
      ${tile('Per trade', money(s.expectancy), `95% range ${usd(s.ci95_low)} to ${usd(s.ci95_high)}`)}
      ${tile('Avg win / loss', `<span class="num" style="font-size:18px;white-space:nowrap"><span class="good">${usd(s.avg_win)}</span> / <span class="bad">${usd(s.avg_loss)}</span></span>`, `avg hold ${hold(s.avg_hold_s)}`)}
      ${tile('Costs paid', `<span class="num bad">${usd(-(Number(s.spread_paid) + Number(s.commission)))}</span>`, `spread ${usd(s.spread_paid)} · commission ${usd(s.commission)}`)}
      ${tile('Max drawdown', `<span class="num bad">${usd(-(b.e8.max_drawdown || 0))}</span>`, `lowest equity ${usd(b.e8.lowest_equity)}`)}
    </div>`;
  }

  function e8Rules(b, set) {
    const e = b.e8;
    const tail = `Worst day ${usd(e.worst_day)} against the −${usd(set.daily_loss_limit)} limit · up to ${e.max_open} positions open at once · peak margin ${usd(e.max_margin)}.`;
    if (e.breached) {
      return `<div class="banner red"><span><b>On E8 this account would have been closed on ${esc(ukTime(e.breach_at))} (UK)</b> by the ${e.breach_kind === 'daily_loss' ? `${usd(set.daily_loss_limit)} daily loss` : `${usd(set.max_drawdown_limit)} drawdown`} rule, at ${usd(e.pnl_at_breach)}.
        ${e.trades_before_breach} trades came before it; the other ${e.trades_blocked_after_breach} could not have been taken. Unwithdrawn profit is lost with the account. ${tail}</span></div>`;
    }
    return `<div class="banner blue"><span><b>Stayed inside E8’s ${usd(set.daily_loss_limit)} daily and ${usd(set.max_drawdown_limit)} drawdown limits.</b> ${tail}</span></div>`;
  }

  function dailyTable(b, set) {
    return `<div class="tablewrap"><div class="scroll"><table><thead><tr><th>Day (UTC)</th><th class="r">Trades</th><th class="r">P&amp;L</th><th class="r">Worst point vs day start</th></tr></thead><tbody>
      ${b.daily.map((d) => `<tr><td>${esc(day(d.day))}</td><td class="r num">${d.trades}</td><td class="r">${money(d.net)}</td>
        <td class="r"><span class="num ${Number(d.worst_intraday) <= -set.daily_loss_limit ? 'bad' : Number(d.worst_intraday) < 0 ? 'warn' : ''}">${d.worst_intraday == null ? '—' : usd(d.worst_intraday)}</span>${Number(d.worst_intraday) <= -set.daily_loss_limit ? ' <span class="cap red">E8 limit</span>' : ''}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  }

  function breakdown(rows, first, label) {
    return `<div class="tablewrap"><div class="scroll" style="max-height:360px"><table><thead><tr><th>${label}</th><th class="r">Trades</th><th class="r">P&amp;L</th><th class="r">Win rate</th>${first === 'trader' ? '<th class="r">Profit factor</th>' : '<th class="r">Spread paid</th>'}</tr></thead><tbody>
      ${rows.map((x) => `<tr><td>${esc(x[first])}</td><td class="r num">${x.trades}</td><td class="r">${money(x.net)}</td><td class="r num">${pct(x.win_rate)}</td>
        <td class="r num">${first === 'trader' ? fixed(x.profit_factor) : usd(x.spread_paid)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  }

  function tradesTable(k) {
    const d = mode[k], fam = k, q = query[k].trim().toLowerCase();
    const all = (r.trades || []).filter((t) => t[d + '_net'] != null)
      .filter((t) => !q || String(t.trader).toLowerCase().includes(q) || String(t.symbol).toLowerCase().includes(q))
      .filter((t) => !(hideAfter[k] && t[d + '_after_breach']));
    const rows = all.slice(0, shown[k]);
    return `<div class="row" style="gap:10px;margin:10px 0;flex-wrap:wrap">
        <input class="input" style="max-width:260px" placeholder="Filter by trader or symbol" value="${esc(query[k])}" data-bt="q" data-book="${k}" aria-label="Filter ${NAME[k]} trades">
        <label class="muted" style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-bt="after" data-book="${k}"${hideAfter[k] ? ' checked' : ''}> Only trades before the E8 breach</label>
        <span class="muted" style="font-size:13px">${all.length} trades${r.books[d].e8.breached && !hideAfter[k] ? ' · faded rows came after the E8 breach and could not have been taken' : ''}</span></div>
      <div class="tablewrap"><div class="scroll" style="max-height:560px"><table><thead><tr>
        <th>Opened (UK)</th><th>Trader</th><th>Symbol</th><th>Copy</th><th class="r">Lots</th><th class="r">E8 entry → exit</th><th class="r">Held</th><th class="r" title="The trader’s own closed P&amp;L before this trade">Trader so far</th><th class="r">Trader P&amp;L</th><th class="r">E8 P&amp;L</th></tr></thead><tbody>
        ${rows.map((t) => {
          const after = t[d + '_after_breach'], side = k === 'a' ? t.side : flip(t.side);
          return `<tr${after ? ' style="opacity:.5" title="After the E8 breach: this trade could not have been taken"' : ''}><td class="num muted" style="white-space:nowrap">${esc(when(t.opened_at))}</td>
            <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.trader)}">${esc(t.trader)}</td><td>${esc(t.symbol)}</td>
            <td class="${side === 'buy' ? 'good' : 'bad'}">${esc(side)}</td><td class="r num">${fixed(t[d + '_lots'])}</td>
            <td class="r num" style="white-space:nowrap">${px(t[fam + '_entry'], t.symbol)} → ${px(t[fam + '_exit'], t.symbol)}</td>
            <td class="r num muted">${hold(t.hold_s)}</td><td class="r num muted">${usd(t.trader_before)}</td><td class="r num muted">${usd(t.trader_pnl)}</td><td class="r" style="white-space:nowrap">${money(t[d + '_net'])}</td></tr>`;
        }).join('') || '<tr><td colspan="10" class="muted">No trades match.</td></tr>'}
      </tbody></table></div></div>
      ${all.length > rows.length ? `<div class="row" style="margin-top:8px"><button class="btn sm" data-bt="more" data-book="${k}">Show ${Math.min(200, all.length - rows.length)} more</button><button class="btn sm link" data-bt="all" data-book="${k}">Show all ${all.length}</button></div>` : ''}`;
  }

  function bookBlock(k) {
    const m = cur(k), b = r.books[m.key], set = r.settings;
    const pick = `<div class="seg" role="group" aria-label="${NAME[k]} traders" style="margin:6px 0 4px">${MODES[k].map((o) =>
      `<button type="button" data-bt="mode" data-book="${k}" data-mode="${o.key}" aria-pressed="${o.key === m.key}">${o.label}</button>`).join('')}</div>`;
    const head = (verdict) => `<div class="grouphead" style="margin-top:28px">${NAME[k]} <span class="sub">${m.what} · its own $${Number(set.account_size).toLocaleString('en-GB')} E8 account</span>${verdict}</div>${pick}
      ${m.note ? `<p class="muted" style="font-size:13px;margin:6px 0 10px">${m.note}</p>` : ''}
      ${m.hindsight ? '<div class="banner"><span><b>Hindsight view.</b> It uses the traders’ final results to decide who to include, so it flatters the numbers. Use the first view for what you could actually have done.</span></div>' : ''}`;
    if (!b) return head('') + '<div class="empty">This view is not in the saved result yet. It appears within 10 minutes.</div>';
    const s = b.summary;
    if (!s.trades) return head('<span class="cap">No trades</span>') + '<div class="empty">No trades qualified under this rule.</div>';
    const verdict = b.e8.breached ? '<span class="cap red">E8 account lost</span>' : Number(s.net_pnl) > 0 ? '<span class="cap green">Profitable</span>' : '<span class="cap">Losing</span>';
    return `${head(verdict)}
      ${stats(b)}${e8Rules(b, set)}
      <div class="grouphead">Day by day</div>${dailyTable(b, set)}
      <details class="more"><summary>By trader · ${b.traders.length}</summary>${breakdown(b.traders, 'trader', 'Trader')}</details>
      <details class="more"><summary>By symbol · ${b.symbols.length}</summary>${breakdown(b.symbols, 'symbol', 'Symbol')}</details>
      <details class="more" open><summary>Every ${NAME[k]} trade · ${s.trades}</summary>${tradesTable(k)}</details>`;
  }

  function notes() {
    const set = r.settings, c = r.coverage;
    const unpriced = (r.trades || []).filter((t) => t.reason != null);
    return `<details class="more"><summary>How this is calculated · real E8 fill check</summary>
      <ul class="muted" style="font-size:13px;line-height:1.6;padding-left:18px">
        <li><b>Size:</b> ${esc(set.lots)}.</li>
        <li><b>Prices:</b> ${esc(set.prices)}. Entry at E8’s first quote ${set.entry_delay_s}s after the trader opened, exit ${set.exit_delay_s}s after the trader closed, the delays measured on your real E8 copies.</li>
        <li><b>Costs:</b> E8’s own spread at each fill. ${esc(set.commission)}. ${esc(set.swaps)}; ${set.overnight_copies} copies were held through the daily rollover.</li>
        <li><b>E8 rules:</b> separate $${Number(set.account_size).toLocaleString('en-GB')} accounts, ${usd(set.daily_loss_limit)} daily loss from the start-of-day balance (${esc(set.day)} day) and ${usd(set.max_drawdown_limit)} maximum drawdown, checked on equity marked to E8 bid/ask every minute.</li>
        <li><b>Coverage:</b> ${c.priced} of ${c.source_trades} Infinity trades since ${esc(ukTime(r.from))} (when E8 prices start). ${c.not_priced} had no E8 price within ${set.max_wait_s}s and are left out rather than guessed.</li>
        <li><b>Who is in each book:</b> ${esc(set.profit_filter || '')}</li>
        <li>Your E8 payout is your profit split of the account profit, and only on profit withdrawn before any breach.</li>
      </ul>
      <div class="grouphead">Model vs your real E8 fills</div>
      <div class="tablewrap"><div class="scroll"><table><thead><tr><th>When (UK)</th><th>Order</th><th class="r">Real E8 fill</th><th class="r">Model price</th><th class="r">Difference</th></tr></thead><tbody>
        ${(r.real_fill_check || []).map((f) => `<tr><td class="num muted">${esc(ukTime(f.at))}</td><td>${esc(f.symbol)} ${esc(f.event)} ${esc(f.side)}</td><td class="r num">${px(f.actual_fill, f.symbol)}</td><td class="r num">${px(f.model_price, f.symbol)}</td><td class="r num">${esc(f.difference)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No real E8 fills to compare yet.</td></tr>'}
      </tbody></table></div></div>
      ${unpriced.length ? `<div class="grouphead">Not priced · ${unpriced.length}</div><div class="tablewrap"><div class="scroll" style="max-height:300px"><table><thead><tr><th>Opened (UK)</th><th>Trader</th><th>Symbol</th><th>Reason</th></tr></thead><tbody>
        ${unpriced.map((t) => `<tr><td class="num muted">${esc(ukTime(t.opened_at))}</td><td>${esc(t.trader)}</td><td>${esc(t.symbol)}</td><td class="muted">${esc(t.reason)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    </details>`;
  }

  function render() {
    const head = `<div class="grouphead" style="margin-top:36px">Copied on E8 <span class="sub">Infinity trades copied (A-book, traders in profit) and reverse-copied (B-book, traders not in profit) at 0.065 lots on E8 prices</span>
      <button class="btn sm" data-bt="run"${busy ? ' disabled' : ''}>${busy ? 'Loading…' : 'Refresh'}</button></div>`;
    if (busy && !r) { root.innerHTML = head + '<div class="empty">Loading…</div>'; return; }
    if (err && !r) { root.innerHTML = head + `<div class="banner red">${esc(err)}<button class="btn sm" data-bt="run">Try again</button></div>`; return; }
    if (!r) { root.innerHTML = head; return; }
    root.innerHTML = head + `<p class="lede" style="margin:4px 0 0">${esc(ukTime(r.from))} to ${esc(ukTime(r.to))} · calculated ${esc(ukTime(saved || r.as_of))} (updates every 10 minutes)${err ? ` · <span class="bad">${esc(err)}</span>` : ''}</p>`
      + bookBlock('a') + bookBlock('b') + notes();
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bt]'); if (!b || b.disabled) return;
    const k = b.dataset.book;
    if (b.dataset.bt === 'run') run();
    if (b.dataset.bt === 'mode') { mode[k] = b.dataset.mode; shown[k] = 100; query[k] = ''; hideAfter[k] = false; render(); }
    if (b.dataset.bt === 'more') { shown[k] += 200; render(); }
    if (b.dataset.bt === 'all') { shown[k] = Infinity; render(); }
  });
  root.addEventListener('change', (e) => {
    const b = e.target.closest('[data-bt="after"]'); if (!b) return;
    hideAfter[b.dataset.book] = b.checked; render();
  });
  let typing = null;
  root.addEventListener('input', (e) => {
    const b = e.target.closest('[data-bt="q"]'); if (!b) return;
    const k = b.dataset.book, pos = b.selectionStart;
    query[k] = b.value; shown[k] = 100;
    clearTimeout(typing);
    typing = setTimeout(() => {
      render();
      const again = root.querySelector(`[data-bt="q"][data-book="${k}"]`);
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    }, 250);
  });

  render();
  run();
})();
