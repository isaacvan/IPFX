/* Individual E8 trader research. TeamOS supplies the existing owner + MFA transport.
   All scenarios and selected portfolios are saved server results; this module never prices trades. */
(() => {
  'use strict';
  const T = window.TeamOS;
  if (!T) return;
  const CLASSES = ['INSUFFICIENT_DATA', 'COST_BLED', 'COPY_CANDIDATE', 'REVERSE_CANDIDATE', 'UNSTABLE', 'TAIL_RISK', 'E8_INCOMPATIBLE', 'STOPPED_TRADING'];
  const LABELS = ['Insufficient data', 'Cost bleed', 'Copy candidate', 'Reverse candidate', 'Unstable', 'Tail risk', 'E8 incompatible', 'Stopped trading'];
  const esc = T.esc;
  const number = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  const fixed = (v, d = 2) => number(v) === null ? '—' : number(v).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
  const count = v => fixed(v, 0);
  const pct = v => number(v) === null ? '—' : fixed(number(v) * 100, 1) + '%';
  const money = v => number(v) === null ? '—' : (number(v) < 0 ? '−$' : '$') + fixed(Math.abs(number(v)));
  const signed = v => `<span class="num ${number(v) > 0 ? 'good' : number(v) < 0 ? 'bad' : ''}">${money(v)}</span>`;
  const arr = v => Array.isArray(v) ? v : [];
  const text = v => v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const reasons = v => arr(v).map(x => typeof x === 'object' ? [x.code, x.reason || x.message || x.description].filter(Boolean).join(': ') : String(x));
  const why = (v, fallback = 'Not available in the saved analysis.') => reasons(v?.reasons).concat(v?.reason ? [v.reason] : []).join(' · ') || fallback;
  const cls = v => LABELS[CLASSES.indexOf(v)] || v || 'Not classified';
  const tone = v => v === 'COPY_CANDIDATE' ? 'green' : v === 'REVERSE_CANDIDATE' ? 'blue' : ['TAIL_RISK', 'E8_INCOMPATIBLE'].includes(v) ? 'red' : '';
  const badge = v => `<span class="cap ${tone(v)}">${esc(cls(v))}</span>`;
  const interval = v => Array.isArray(v) && number(v[0]) !== null && number(v[1]) !== null ? `${money(v[0])} to ${money(v[1])}` : '95% interval unavailable';
  const time = v => Number.isFinite(Date.parse(v)) ? T.ukTime(v) : 'Unknown';
  const empty = (v, fallback) => `<p class="et-empty">${esc(why(v, fallback))}</p>`;
  const tile = (label, value, sub = '') => `<div class="stat"><div class="k">${esc(label)}</div><div class="v num">${value}</div><div class="s">${esc(sub)}</div></div>`;
  const table = (headers, rows, fallback = 'No saved observations for this view.') => `<div class="tablewrap"><div class="et-scroll"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${headers.length}" class="muted">${esc(fallback)}</td></tr>`}</tbody></table></div></div>`;
  const cells = values => `<tr>${values.map(v => `<td>${v}</td>`).join('')}</tr>`;
  const panel = (title, html, wide = false) => `<section class="et-panel ${wide ? 'et-wide' : ''}"><h3>${esc(title)}</h3>${html}</section>`;
  function chart(points, fields, label, format = money) {
    const rows = arr(points), values = rows.flatMap(p => fields.map(f => number(p[f.key]))).filter(v => v !== null);
    if (!values.length) return empty(points, 'No saved curve observations.');
    const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
    const y = v => 164 - (v - min) / span * 144;
    const x = i => 64 + i / Math.max(1, rows.length - 1) * 610;
    const paths = fields.map(f => {
      let move = true;
      const d = rows.map((p, i) => { const v = number(p[f.key]); if (v === null) { move = true; return ''; } const s = `${move ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`; move = false; return s; }).join(' ');
      return `<path d="${d}" class="${f.color}" fill="none" stroke="currentColor" stroke-width="2"/>`;
    }).join('');
    return `<figure class="et-chart"><svg viewBox="0 0 700 198" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><line x1="64" x2="674" y1="${y(0)}" y2="${y(0)}" class="et-gridline"/><text x="0" y="24">${esc(format(max))}</text><text x="0" y="166">${esc(format(min))}</text>${paths}<text x="64" y="191">${esc(text(rows[0]?.day || rows[0]?.at || rows[0]?.horizon || 'Start'))}</text><text x="674" y="191" text-anchor="end">${esc(text(rows.at(-1)?.day || rows.at(-1)?.at || rows.at(-1)?.horizon || 'Latest'))}</text></svg><figcaption>${fields.map(f => `<span class="${f.color}">● ${esc(f.label)}</span>`).join('')}</figcaption></figure>`;
  }
  function histogram(values, label) {
    const rows = arr(values), max = Math.max(1, ...rows.map(r => number(r.count) || 0));
    if (!rows.length) return empty(values, 'Histogram not available in the saved analysis.');
    return `<div class="et-hist" role="img" aria-label="${esc(label)}">${rows.map(r => `<div class="et-bin"><span>${esc(text(r.label ?? r.bucket ?? r.range))}</span><div><i style="width:${Math.max(0, (number(r.count) || 0) / max * 100)}%"></i></div><b class="num">${count(r.count)}</b></div>`).join('')}</div>`;
  }
  function mount(root) {
    if (!root || root.dataset.etMounted) return;
    root.dataset.etMounted = 'true'; root.classList.add('et');
    const state = { latency: 2, slippage: 0, page: 0, limit: 100, query: '', class_filter: '', symbol: '', min_trades: 0, sort: 'a_net', direction: 'desc' };
    let data = null, error = '', pending = false, generation = 0, drawerId = null, detailGeneration = 0, detail = null, detailError = '', portfolio = null, portfolioError = '', portfolioBusy = false, portfolioGeneration = 0, versionChanged = false, disposed = false, warmGeneration = 0, snapshot = null;
    const selected = new Set(), views = new Map(), details = new Map();
    const request = () => ({ ...state });
    const viewKey = () => JSON.stringify(request());
    const detailKey = id => `${id}:${state.latency}:${state.slippage}`;
    const script = [...document.scripts].find(s => /\/ws-books-traders\.js(?:\?|$)/.test(s.src));
    const loadedScript = script?.getAttribute('src');
    root.innerHTML = `<header class="et-heading"><div><span class="et-eyebrow">E8 RESEARCH · INDIVIDUAL FLOW</span><h2>Individual trader book performance</h2><p class="muted">Copy and reverse each trader at E8 prices, after execution costs.</p></div><button type="button" class="btn sm" data-et="refresh">Refresh analysis</button></header>
      <div data-slot="version" hidden class="banner blue" role="status">A newer version of this page is available. <button type="button" class="btn sm" data-et="reload">Reload page</button></div>
      <div data-slot="alert" hidden class="banner red" role="status"></div><div data-slot="freshness" class="et-meta" aria-live="polite">Loading saved analysis…</div>
      <div data-slot="summary"></div><div data-slot="classes" class="et-classes"></div>
      <div class="et-controls group"><div class="et-stress"><div><b>Execution sensitivity</b><span class="muted">Saved E8 scenarios · exit delay 5s</span></div><div class="et-control"><span>Entry latency</span><div class="seg" role="group" aria-label="Entry latency">${[1,2,5,15].map(n => `<button type="button" data-et="latency" data-value="${n}" aria-pressed="${n === 2}">${n}s</button>`).join('')}</div></div><div class="et-control"><span>Slippage per side</span><div class="seg" role="group" aria-label="Slippage per side">${[0,1,2].map(n => `<button type="button" data-et="slippage" data-value="${n}" aria-pressed="${n === 0}">${n} ${n === 1 ? 'tick' : 'ticks'}</button>`).join('')}</div></div></div>
      <div class="et-filters"><label class="field et-search"><span>Search traders</span><input class="input" data-et="query" data-focus="query" maxlength="120" placeholder="Trader email" type="search"></label><label class="field"><span>Evidence class</span><select class="input" data-et="class_filter" aria-label="Evidence class"><option value="">All classes</option>${CLASSES.map(c => `<option value="${c}">${esc(cls(c))}</option>`).join('')}</select></label><label class="field"><span>Symbol</span><input class="input" data-et="symbol" maxlength="30" placeholder="All symbols" aria-label="Symbol filter"></label><label class="field"><span>Minimum trades</span><input class="input" data-et="min_trades" type="number" min="0" max="1000000" step="1" value="0"></label></div></div>
      <div class="et-table-head"><span data-slot="count" class="muted"></span><span class="muted">A = copy · B = reverse · USD</span></div><div class="tablewrap"><div class="et-scroll et-main-scroll" data-preserve-scroll="traders"><table class="et-traders"><thead><tr><th aria-label="Portfolio selection"></th>${[['trader','Trader / evidence'],['trades','Trades / days'],['','Symbol mix'],['a_net','A net / 95% interval'],['b_net','B net / 95% interval'],['gross_per_trade','Gross / trade'],['cost_per_trade','Cost / round turn'],['p_copy','P(copy) / P(reverse)'],['q_copy','q copy / reverse'],['evidence_class','Stability / E8 flags']].map(([key,label]) => `<th${key ? ` data-sort-head="${key}" aria-sort="none"` : ''}>${key ? `<button type="button" data-et="sort" data-value="${key}">${label}<span aria-hidden="true" data-sort-arrow="${key}"></span></button>` : label}</th>`).join('')}</tr></thead><tbody data-slot="rows"></tbody></table></div></div>
      <div class="et-pagination"><button type="button" class="btn sm" data-et="previous">Previous</button><span data-slot="page" class="muted"></span><button type="button" class="btn sm" data-et="next">Next</button></div>
      <p class="et-note">P&amp;L includes all priced cash results. Intervals use eligible trades from completed days and describe comparable repeated samples. P(copy/reverse) is a working model estimate with unverified calibration. Candidate q-values require valid prospective evidence across all people, directions and displayed scenarios.</p>
      <div class="et-bottom"><section class="group et-walk"><h3>Walk-forward evidence</h3><div data-slot="walk"></div></section><section class="group et-portfolio"><h3>Selected-set portfolio</h3><p class="muted">One shared E8 account. Individual P&amp;Ls do not add up when daily loss, drawdown and crowding rules bind.</p><div class="row"><span data-slot="selected">0 selected</span><select class="input" data-et="book" aria-label="Portfolio book"><option value="a">A-book · copy</option><option value="b">B-book · reverse</option></select><button type="button" class="btn primary sm" data-et="portfolio" disabled>Read saved portfolio</button><button type="button" class="btn sm" data-et="clear">Clear</button></div><div data-slot="portfolio"></div></section></div>
      <details class="more et-methods"><summary>Coverage, calibration and evidence gates</summary><div data-slot="methods"></div></details><p class="et-note">Research only. Keep E8’s written permission for copying and reversing IPFX flow on file; policy compatibility is reported in the evidence.</p>
      <div class="et-backdrop" data-et="backdrop" hidden><aside class="et-drawer" role="dialog" aria-modal="true" aria-labelledby="et-drawer-title"><header><div><span class="et-eyebrow">TRADER EVIDENCE</span><h2 id="et-drawer-title"></h2><span data-slot="drawer-scenario" class="muted"></span></div><button class="btn sm" type="button" data-et="close" aria-label="Close trader detail">Close ×</button></header><div class="et-drawer-controls"><div class="et-control"><span>Entry latency</span><div class="seg" role="group" aria-label="Drawer entry latency">${[1,2,5,15].map(n => `<button type="button" data-et="latency" data-value="${n}" aria-pressed="${n === 2}">${n}s</button>`).join('')}</div></div><div class="et-control"><span>Slippage per side</span><div class="seg" role="group" aria-label="Drawer slippage per side">${[0,1,2].map(n => `<button type="button" data-et="slippage" data-value="${n}" aria-pressed="${n === 0}">${n} ${n === 1 ? 'tick' : 'ticks'}</button>`).join('')}</div></div></div><div class="et-drawer-scroll" data-preserve-scroll="drawer" tabindex="0"><div data-slot="detail"></div></div></aside></div>`;
    const slot = key => root.querySelector(`[data-slot="${key}"]`);
    function put(key, html) { const el = slot(key); if (el.innerHTML !== html) el.innerHTML = html; }
    function preserve(el, html) {
      if (el.innerHTML === html) return;
      const active = el.contains(document.activeElement) ? document.activeElement : null;
      const focusKey = active?.dataset.focus, start = active?.selectionStart, end = active?.selectionEnd;
      const scrolls = [...el.querySelectorAll('[data-preserve-scroll]')].map(n => [n.dataset.preserveScroll, n.scrollTop, n.scrollLeft]);
      const open = [...el.querySelectorAll('details[open]')].map(n => n.dataset.detailKey);
      el.innerHTML = html;
      for (const [key, top, left] of scrolls) { const n = [...el.querySelectorAll('[data-preserve-scroll]')].find(e => e.dataset.preserveScroll === key); if (n) { n.scrollTop = top; n.scrollLeft = left; } }
      el.querySelectorAll('details').forEach(n => { if (open.includes(n.dataset.detailKey)) n.open = true; });
      if (focusKey) { const n = [...el.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === focusKey); n?.focus({ preventScroll: true }); if (typeof n?.setSelectionRange === 'function' && start !== null) n.setSelectionRange(start, end); }
    }
    function freshness() {
      const stamp = data?.computed_at, source = data?.source_computed_at;
      const age = Number.isFinite(Date.parse(stamp)) ? Math.max(0, Math.floor((Date.now() - Date.parse(stamp)) / 60000)) : null;
      put('freshness', `${stamp ? `Updated ${age === 0 ? 'just now' : age === null ? 'at an unknown time' : `${age} min ago`} · ${esc(time(stamp))}` : 'Calculation time unknown'}${source ? ` · source ${esc(time(source))}` : ''} · ${state.latency}s entry / 5s exit · ${state.slippage} adverse ticks per side${pending ? ' · Reading saved view…' : ''}`);
      const stale = data?.stale === true || age === null || age > 30 || (Number.isFinite(Date.parse(source)) && Date.now() - Date.parse(source) > 1800000);
      const message = [error, data?.available === false ? why(data) : '', data && stale ? 'Stale or undated analysis. The last successful saved calculation is not confirmed within 30 minutes.' : '', data?.refresh_error ? text(data.refresh_error) : ''].filter(Boolean).join(' ');
      slot('alert').hidden = !message; put('alert', esc(message));
      slot('version').hidden = !versionChanged;
    }
    function summary() {
      const s = data?.summary || {}, cc = s.class_counts || data?.class_counts || data?.classes || {};
      const total = s.total ?? s.population ?? data?.population_total ?? data?.population, enough = s.enough_data;
      put('summary', `<div class="stats">${tile('Individual traders',count(total),'Population in the saved window')}${tile('Enough data',count(enough),'Reportable sample threshold')}${tile('Copy candidates',count(s.copy_candidates),'After population FDR control')}${tile('Reverse candidates',count(s.reverse_candidates),'After population FDR control')}${tile('FDR target',pct(s.fdr_target ?? data?.config?.fdr_target ?? data?.config?.fdr_alpha ?? data?.config?.q_max ?? data?.config?.q_target),'Target false-discovery share')}${tile('Expected false share',pct(s.expected_false_discovery_share),'Among selected candidates; — if unknown')}</div><p class="et-verdict">Of <b>${count(total)}</b> traders, <b>${count(s.classified ?? enough)}</b> have enough evidence to classify; <b>${count(s.copy_candidates)}</b> look copyable; <b>${count(s.reverse_candidates)}</b> look reversible. ${esc(s.statement || s.reason || 'The remaining traders have no supported actionable verdict; inspect their evidence and exact reasons.')}</p>`);
      const hasCounts = Boolean(s.class_counts || data?.class_counts || data?.classes);
      put('classes', CLASSES.map(c => `<button class="et-class" type="button" data-et="class" data-value="${c}" aria-pressed="${state.class_filter === c}">${badge(c)}<b class="num">${count(cc[c] ?? (hasCounts ? 0 : null))}</b></button>`).join(''));
    }
    function symbols(v) {
      if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? esc(x) : `${esc(x.symbol ?? x.name ?? 'Unknown')}${x.share != null ? ` ${pct(x.share)}` : x.trades != null ? ` (${count(x.trades)})` : ''}`).join(' · ') || '—';
      return v && typeof v === 'object' ? Object.entries(v).map(([k,n]) => `${esc(k)} ${pct(n)}`).join(' · ') : esc(text(v));
    }
    function rowCells(r) {
      const id = String(r.trader_id), rs = reasons(r.reasons), flags = reasons(r.flags).join(' · ');
      const reasonHTML = rs.length > 1 ? `<details data-detail-key="reason-${esc(id)}"><summary>${esc(rs[0])} · ${rs.length-1} more reasons</summary>${rs.slice(1).map(reason => `<p>${esc(reason)}</p>`).join('')}</details>` : esc(rs[0] || r.reason || 'No classification reason supplied.');
      const stability = typeof r.stability === 'object' ? r.stability?.label ?? r.stability?.reason ?? (r.stability?.supported === true ? 'Regime support established' : 'Regime support incomplete') : r.stability || 'Stability not established';
      return [`<input type="checkbox" data-et="select" data-id="${esc(id)}" data-focus="select-${esc(id)}" aria-label="Include ${esc(r.trader || id)} in portfolio"${selected.has(id) ? ' checked' : ''}>`,
        `<button type="button" class="et-person" data-et="detail" data-id="${esc(id)}" data-focus="trader-${esc(id)}">${esc(r.trader || id)}</button><div>${badge(r.evidence_class)} <small>${esc(text(r.tier))}</small></div><div class="et-reason">${reasonHTML}</div>`,
        `<b class="num">${count(r.trades)}</b><small>${count(r.active_days)} completed days · ${count(r.inference_trades)} eligible</small>`, symbols(r.symbols),
        `${signed(r.a_net)}<small>${interval(r.a_interval)}</small><small>WR ${pct(r.a_win_rate)} · PF ${fixed(r.a_profit_factor)}</small>`, `${signed(r.b_net)}<small>${interval(r.b_interval)}</small><small>WR ${pct(r.b_win_rate)} · PF ${fixed(r.b_profit_factor)}</small>`,
        `${signed(r.gross_per_trade)}<small>${fixed(r.gross_spread_multiple)} × spread</small>`, `${money(r.cost_per_trade)}<small>A + B: ${number(r.a_net) !== null && number(r.b_net) !== null ? money(number(r.a_net) + number(r.b_net)) : '—'}</small>`,
        `<span class="num">${pct(r.p_copy)} / ${pct(r.p_reverse)}</span><small>Copy / reverse</small>`, `<span class="num">${fixed(r.q_copy,4)} / ${fixed(r.q_reverse,4)}</span><small>Copy / reverse</small>`,
        `${esc(stability)}<small>${esc(flags || 'E8 flags not reported')}</small><small>${esc(gap(r.sample_gap))}</small>`];
    }
    function renderRows() {
      const body = slot('rows'), old = new Map([...body.rows].map(r => [r.dataset.id, r]));
      const rows = arr(data?.traders || data?.rows), scroll = root.querySelector('.et-main-scroll'), top = scroll.scrollTop, left = scroll.scrollLeft;
      if (!rows.length) { preserve(body, `<tr><td colspan="11" class="et-empty">${esc(pending ? 'Reading saved traders…' : data?.available === false ? why(data) : 'No traders match these filters.')}</td></tr>`); }
      else {
        [...body.rows].filter(r => !r.dataset.id).forEach(r => r.remove());
        rows.forEach((r, index) => {
          const id = String(r.trader_id), row = old.get(id) || document.createElement('tr'); row.dataset.id = id; old.delete(id);
          const html = rowCells(r); html.forEach((content,i) => { const td = row.cells[i] || row.insertCell(); preserve(td,content); });
          if (body.children[index] !== row) body.insertBefore(row,body.children[index] || null);
          row.classList.toggle('et-selected',selected.has(id));
        }); old.forEach(r => r.remove());
      }
      scroll.scrollTop = top; scroll.scrollLeft = left;
      const total = number(data?.total), start = state.page * state.limit;
      put('count',`${rows.length ? start + 1 : 0}–${start + rows.length} of ${count(total)} matching traders`);
      put('page',`Page ${state.page + 1}${total !== null ? ` of ${Math.max(1,Math.ceil(total/state.limit))}` : ''}`);
      root.querySelector('[data-et="previous"]').disabled = state.page === 0 || pending;
      root.querySelector('[data-et="next"]').disabled = pending || total === null || start + rows.length >= total;
      root.querySelectorAll('[data-sort-head]').forEach(h => { h.setAttribute('aria-sort', h.dataset.sortHead === state.sort ? state.direction === 'asc' ? 'ascending' : 'descending' : 'none'); });
      root.querySelectorAll('[data-sort-arrow]').forEach(a => { a.textContent = a.dataset.sortArrow === state.sort ? state.direction === 'asc' ? ' ↑' : ' ↓' : ''; });
    }
    function gap(v) { if (number(v) !== null) return `Needs ~${count(v)} more trades for a 95% call at the observed edge`; if (v && typeof v === 'object') return v.reason || (number(v.additional_trades ?? v.more_trades ?? v.additional) !== null ? `Needs ~${count(v.additional_trades ?? v.more_trades ?? v.additional)} more trades for a 95% call at the observed edge` : 'Sample gap not estimable'); return 'Sample gap not estimable at the observed edge'; }
    function walk() {
      const w = data?.walk_forward || data?.walkforward;
      if (!w || w.available === false) return put('walk', empty(w,'No prospective follow-up is available yet.'));
      const s = w.summary || w;
      put('walk', `<p class="et-note">${esc(w.label || w.mode || 'Saved walk-forward evaluation')} · classifications use information available before the following trade.</p>${w.reconstructed || /reconstruct|histor/i.test(w.mode || '') ? '<div class="banner">Reconstructed history is descriptive. It is not a captured prospective holdout.</div>' : ''}<div class="et-mini-stats">${tile('Ever copyable',count(s.copy_traders ?? s.copy_candidates))}${tile('Ever reversible',count(s.reverse_traders ?? s.reverse_candidates))}${tile('Subsequent A net',signed(s.a_net))}${tile('Subsequent B net',signed(s.b_net))}${tile('Hit rate',pct(s.hit_rate))}${tile('Later flipped',pct(s.flip_share))}</div>${number(s.a_net) !== null && number(s.a_net) < 0 || number(s.b_net) !== null && number(s.b_net) < 0 ? '<p class="bad">Follow-up results include a loss. Historical selection has not established a profitable edge.</p>' : ''}${s.trades === 0 ? '<p class="muted">No subsequent qualifying trades yet.</p>' : ''}${w.reason ? empty(w) : ''}`);
    }
    function methods() {
      const c = data?.coverage || {}, cfg = data?.config || {}, calibration = data?.calibration;
      const params = arr(calibration?.parameters || calibration?.rows || calibration);
      if (!params.length && calibration) {
        params.push({parameter:'Real E8 fill comparison',status:calibration.label || 'MEASURED',value:calibration.value ?? null,n:calibration.n,reason:calibration.reason || 'Recorded model versus actual fill observations'});
        if(calibration.model) params.push({parameter:'Slippage / impact model',status:calibration.model.label || 'ASSUMED',value:null,n:calibration.n,reason:calibration.model.reason});
      }
      put('methods', `<div class="et-mini-stats">${tile('Priced trades',count(c.priced ?? c.priced_trades))}${tile('Not priced',count(c.not_priced ?? c.unpriced))}${tile('Source trades',count(c.source_trades))}${tile('Sample window',esc(text(c.from ?? data?.from)),text(c.to ?? data?.to))}</div><p class="et-note">Missing E8 quotes are not guessed. Overnight swaps, risk-preserving sizing, margin, policy checks and crowding remain unknown unless the saved result supplies evidence.</p>${reasons(c.reasons).length ? empty(c) : ''}<h4>Execution calibration</h4>${table(['Parameter','Status','Value','Sample size','Evidence / reason'], params.map(p => cells([esc(p.parameter ?? p.name ?? p.symbol),esc(p.status ?? p.provenance ?? 'UNKNOWN'),esc(text(p.value)),count(p.n ?? p.sample_size),esc(p.reason || p.evidence || '—')])),why(calibration,'No calibration observations supplied.'))}<p class="et-note">MEASURED = observed in real execution; FITTED = estimated from observations; ASSUMED = a scenario input. A thin fill sample cannot establish a reliable impact model.</p><h4>Evidence gates</h4><p class="et-note">${esc(cfg.description || 'Fewer than 30 priced trades: insufficient. 30–99: provisional. 100+: reportable. Potential actionability requires 200+ trades, 10 completed days, stable halves and regimes, population q ≤ 0.05, and a valid sequential evidence gate. Unknown support prevents actionability.')}</p>${cfg.version ? `<p class="et-note">Configuration ${esc(cfg.version)}</p>` : ''}`);
    }
    function render() { const x = window.scrollX, y = window.scrollY; freshness(); summary(); renderRows(); walk(); methods(); selection(); root.querySelector('[data-et="refresh"]').disabled = pending; window.scrollTo(x,y); }
    async function load() {
      const seq = ++generation, key = viewKey(); pending = true; error = ''; freshness();
      try {
        const response = await T.brain('e8_trader_performance', request());
        if (response?.ok === false) throw new Error(response.error || response.reason || 'Saved analysis could not be read.');
        if (seq !== generation || disposed) return;
        data = response.performance || { available: false, reason: 'No saved performance returned.' };
        if (snapshot !== data.computed_at) { snapshot = data.computed_at; views.clear(); details.clear(); }
        views.set(key,data);
        // Optional precomputed cells supplied in the same cache payload.
        for (const s of arr(data.scenarios || data.stress_cells)) if (s.traders) views.set(JSON.stringify({...request(),latency:Number(s.latency),slippage:Number(s.slippage)}), {...data,...s});
      } catch (e) { if (seq === generation) error = e.message || String(e); }
      finally { if (seq === generation && !disposed) { pending = false; render(); if (data?.available !== false && !error) warmViews(); } }
    }
    async function warmViews() {
      const token = ++warmGeneration, base = request();
      const jobs = [1,2,5,15].flatMap(latency => [0,1,2].map(slippage => ({...base,latency,slippage}))).filter(r => !views.has(JSON.stringify(r)));
      // Bounded parallel cache reads make sensitivity switches local once saved cells arrive.
      for (let i = 0; i < jobs.length; i += 2) {
        if (token !== warmGeneration || disposed || document.visibilityState === 'hidden') return;
        await Promise.all(jobs.slice(i,i+2).map(async body => {
          try { const r = await T.brain('e8_trader_performance',body); if (token === warmGeneration && r?.ok !== false && r.performance && (!snapshot || r.performance.computed_at === snapshot)) views.set(JSON.stringify(body),r.performance); } catch (_) { /* Selected cells report their own read error. */ }
        }));
      }
    }
    async function checkVersion() {
      if (!loadedScript || document.visibilityState === 'hidden') return;
      try {
        const r = await fetch(location.pathname, { cache: 'no-store', credentials: 'same-origin' });
        if (!r.ok) return;
        const doc = new DOMParser().parseFromString(await r.text(),'text/html');
        const next = [...doc.scripts].map(s => s.getAttribute('src')).find(s => /\/ws-books-traders\.js(?:\?|$)/.test(s || ''));
        if (next && new URL(next,location.href).href !== new URL(loadedScript,location.href).href) { versionChanged = true; freshness(); }
      } catch (_) { /* A version probe failure must not replace financial data. */ }
    }
    function invalidatePortfolio() { portfolio = null; portfolioError = ''; portfolioBusy = false; ++portfolioGeneration; renderPortfolio(); }
    function changeView() { ++warmGeneration; const cached = views.get(viewKey()); data = cached || null; invalidatePortfolio(); render(); if (drawerId) { detail = details.get(detailKey(drawerId)) || null; renderDetail(); loadDetail(); } load(); }
    function selection() { put('selected',`${selected.size} / 50 selected`); root.querySelector('[data-et="portfolio"]').disabled = !selected.size || portfolioBusy; }
    function renderPortfolio() {
      selection();
      if (portfolioError) return put('portfolio',`<p class="bad" role="status">${esc(portfolioError)}</p>`);
      if (portfolioBusy) return put('portfolio','<p class="muted" role="status">Reading the saved selected-set simulation…</p>');
      if (!portfolio) return put('portfolio','<p class="et-note">Select up to 50 traders. This reads a saved simulation; it does not place orders.</p>');
      if (portfolio.available === false) return put('portfolio',empty(portfolio));
      const p = portfolio.summary || portfolio, e = portfolio.e8 || p;
      put('portfolio',`<div class="et-mini-stats">${tile('Combined net',signed(p.net ?? p.net_pnl))}${tile('Worst day',signed(p.worst_day ?? e.worst_day))}${tile('Breach date',esc(e.breach_at ? time(e.breach_at) : e.breached === false ? 'No breach' : 'Unknown'))}</div>${portfolio.reason ? empty(portfolio) : ''}${portfolio.mark_missing ? '<p class="bad">Missing minute marks: account-limit evidence is incomplete.</p>' : ''}${chart(portfolio.path,[{key:'net',label:'Shared account net',color:'et-a'}],'Selected shared account equity')}${table(['Trader','Marginal contribution','Realized allocation','Net without trader'],arr(portfolio.contributions || portfolio.traders).map(r => cells([esc(r.trader || arr(data?.traders).find(t => t.trader_id === r.trader_id)?.trader || r.trader_id),signed(r.marginal_contribution ?? r.marginal_net),signed(r.realized_net),signed(r.without_net)])))}<p class="et-note">Crowding peak: ${count(portfolio.crowding?.max_same_symbol_side_traders)} traders on one symbol and side. Policy enforcement: ${portfolio.crowding?.policy_enforced === true ? 'confirmed' : 'not established'}.</p>${reasons(portfolio.limitations).map(reason => `<p class="et-note">${esc(reason)}</p>`).join('')}`);
    }
    async function loadPortfolio() {
      if (!selected.size || portfolioBusy) return;
      const seq = ++portfolioGeneration; portfolioBusy = true; portfolio = null; portfolioError = ''; renderPortfolio();
      try { const r = await T.brain('e8_trader_portfolio',{trader_ids:[...selected],book:root.querySelector('[data-et="book"]').value,latency:state.latency,slippage:state.slippage}); if (seq !== portfolioGeneration) return; if (r?.ok === false) throw new Error(r.error || r.reason); portfolio = r.portfolio || {available:false,reason:'No saved portfolio returned.'}; }
      catch(e) { if (seq === portfolioGeneration) portfolioError = e.message || String(e); }
      finally { if (seq === portfolioGeneration) { portfolioBusy = false; renderPortfolio(); } }
    }
    function statsPanel(d) {
      const s = d.statistics || d.stats || {}, t = d.tails || s.tail || {}, ce = d.copy_error || {}, r = d.trader_summary || d.summary || d;
      return panel('Inference, tails and sample gap',`<div class="et-mini-stats">${tile('Raw gross / trade',signed(s.raw_mean ?? r.raw?.gross_mean ?? r.gross_per_trade))}${tile('Shrunk gross / trade',signed(s.posterior_mean ?? s.shrunk_mean ?? r.posterior?.mean))}${tile('Day-clustered / serial SE',money(s.clustered_se ?? s.standard_error ?? r.raw?.se_gross))}${tile('P(copy)',pct(r.p_copy ?? s.p_copy))}${tile('P(reverse)',pct(r.p_reverse ?? s.p_reverse))}${tile('q copy / reverse',`${fixed(r.q_copy ?? s.q_copy,4)} / ${fixed(r.q_reverse ?? s.q_reverse,4)}`)}</div><p class="et-gap">${esc(gap(d.sample_gap ?? r.sample_gap))}</p><p class="et-note">${esc(s.power?.method || 'Sample gap is a fixed-look heuristic at the observed edge; it is not a guarantee that FDR, regime or sequential gates will pass.')}</p>${table(['Diagnostic','Saved value'],[['Sequential evidence',s.anytime_reason ?? s.sequential_reason ?? s.anytime?.reason ?? s.anytime_valid],['Sequential validity',s.anytime?.valid === true ? 'Valid prospective process' : 'Not established'],['Registered bound / e-value',s.anytime?.bound ?? s.e_value],['Top 3 favorable gross share',pct(t.top3_share ?? t.top_3_share ?? t.favorable_top3_share)],['Sub-minute share',pct(s.subminute_share)],['Average win / loss',`${money(t.avg_win ?? d.distributions?.a_net?.avg_win)} / ${money(t.avg_loss ?? d.distributions?.a_net?.avg_loss)}`],['Skewness / kurtosis',`${fixed(t.skewness)} / ${fixed(t.kurtosis)}`],['Tail review',t.reason],['Common copy-error factor',ce.common_factor],['Idiosyncratic copy error',ce.residual],['Copy-error evidence',ce.reason],['Interval sample',s.inference?.interval_basis],['Inference-eligible / observed trades',`${count(s.inference?.trades)} / ${count(s.inference?.observed_trades)}`],['Model assumptions',r.posterior?.assumptions],['FDR method / limitation',s.fdr ? `${s.fdr.method}: ${s.fdr.limitation || ''}` : null]].map(([k,v]) => cells([esc(k),esc(text(v))])))}`,true);
    }
    function renderDetail() {
      if (!drawerId) return;
      const r = arr(data?.traders).find(r => String(r.trader_id) === drawerId) || {};
      root.querySelector('#et-drawer-title').textContent = (typeof detail?.trader === 'string' ? detail.trader : detail?.trader?.trader || detail?.trader?.email) || r.trader || drawerId;
      put('drawer-scenario',`${state.latency}s entry / 5s exit · ${state.slippage} adverse ticks per side · saved E8 analysis`);
      let html;
      if (detailError) html = `<div class="banner red">${esc(detailError)}</div><button type="button" class="btn" data-et="retry-detail" data-focus="retry-detail">Retry detail</button>`;
      else if (!detail) html = '<div class="empty" role="status">Reading saved trader evidence…</div>';
      else if (detail.available === false) html = empty(detail);
      else {
        const d = detail, s = d.summary || d.trader_summary || d.row || r, decomp = d.decomposition || {}, daily = arr(d.daily), markouts = arr(d.markouts).map(m => ({...m,horizon: typeof m.horizon === 'number' ? `${m.horizon}s` : m.horizon})), regimes = arr(d.regimes || d.stability?.regimes), sens = arr(d.sensitivity || d.scenarios || d.stress_cells);
        if (d.own_exit) markouts.push({horizon:'Own exit',price_move:d.own_exit.price,spread_multiple:d.own_exit.spread_multiple,r:d.own_exit.r_multiple,n:s.trades});
        let variants = arr(d.variants);
        if (!Array.isArray(d.variants) && d.variants) { const risk = d.variants.risk_preserving_reverse; variants = [...(risk ? [{name:'Risk-preserving B',b_net:risk.net,reason:`${count(risk.priced)} priced · ${count(risk.not_priced)} not priced; valid opposite stop required`}] : []),...arr(d.variants.fixed_horizons).map(v => ({...v,name:`Fixed horizon ${v.seconds}s`,reason:`${count(v.priced)} priced observations; values are average net per trade`}))]; }
        html = `<div class="et-detail-verdict">${badge(s.evidence_class || r.evidence_class)}<p>${esc(why(s,why(r)))}</p><div class="stats">${tile('A-book · copy',signed(s.a_net),interval(s.a_interval))}${tile('B-book · reverse',signed(s.b_net),interval(s.b_interval))}${tile('Priced trades',count(s.trades),`${count(s.active_days)} active days`)}</div></div><div class="et-detail-grid">`
          + panel('Equity at E8 prices',chart(d.equity || d.curves,[{key:'a',label:'A · copy',color:'et-a'},{key:'b',label:'B · reverse',color:'et-b'}],'A and B equity curves'),true)
          + panel('Daily P&L',table(['Day (UTC)','Trades','A net','B net'],daily.map(x => cells([esc(x.day),count(x.trades),signed(x.a_net ?? x.a),signed(x.b_net ?? x.b)]))))
          + panel('P&L decomposition',table(['Component','USD'],[['Gross direction',decomp.gross ?? decomp.gross_direction],['Spread paid',decomp.spread],['Commission paid',decomp.commission],['Slippage paid',decomp.slippage],['A + B (−2 × costs)',decomp.pair_net]].map(([k,v]) => cells([esc(k),signed(v)]))))
          + panel('Entry markouts · trader direction',chart(markouts,[{key:'spread_multiple',label:'Signed move / spread',color:'et-a'}],'Signed E8 mid move by horizon',v => fixed(v)+'×')+table(['Horizon','Price move','Spread multiple','R','n'],markouts.map(m => cells([esc(text(m.horizon ?? m.horizon_s)),fixed(m.price_move,5),fixed(m.spread_multiple),fixed(m.r),count(m.n)])),why(d.markouts,'Markouts unavailable; missing E8 observations are not imputed.')),true)
          + panel('Per-symbol results',table(['Symbol','Trades','A net','B net'],arr(d.symbols).map(x => cells([esc(x.symbol),count(x.trades),signed(x.a_net),signed(x.b_net)]))),true)
          + panel('Trade-result distribution',histogram(d.result_histogram || d.distribution?.histogram,'Distribution of individual trade results')+table(['Book','Average win','Average loss'],['a_net','b_net'].map(k => cells([k==='a_net'?'A · copy':'B · reverse',signed(d.distributions?.[k]?.avg_win),signed(d.distributions?.[k]?.avg_loss)]))))
          + panel('Hold-time distribution',histogram(d.hold_histogram || d.hold_time_histogram,'Distribution of trade hold times'))
          + panel('Regime and behavior stability',table(['Dimension','Regime','Trades','A net','B net','Evidence'],regimes.map(x => cells([esc(x.dimension ?? x.kind),esc(x.regime ?? x.label),count(x.trades),signed(x.a_net),signed(x.b_net),esc(x.reason || x.stability || '—')])),why(d.stability,'Weeks, sessions and volatility comparisons not established.'))+`<p class="et-note">${esc(d.behavior?.reason || d.behaviour?.reason || 'Behavior-change and survivorship evidence not supplied.')}</p>`,true)
          + statsPanel(d)
          + panel('Saved execution sensitivity',table(['Entry latency','Ticks / side','A net','B net','Evidence class','Reason'],sens.map(x => cells([`${count(x.latency)}s`,count(x.slippage),signed(x.a_net),signed(x.b_net),badge(x.evidence_class),esc(why(x))]))),true)
          + panel('Exit and sizing variants',table(['Variant','A net','B net','Availability / reason'],variants.map(x => cells([esc(x.name || x.variant),signed(x.a_net),signed(x.b_net),esc(why(x,x.available === true ? 'Available' : 'Not established'))])), 'Risk-preserving B and fixed-horizon exits are not supplied in this saved view.'),true) + '</div>';
      }
      const scroller = root.querySelector('.et-drawer-scroll'), top = scroller.scrollTop; preserve(slot('detail'),html); scroller.scrollTop = top;
    }
    async function loadDetail() {
      if (!drawerId) return;
      const id = drawerId, seq = ++detailGeneration, key = detailKey(id); detailError = '';
      try { const r = await T.brain('e8_trader_detail',{trader_id:id,latency:state.latency,slippage:state.slippage}); if (seq !== detailGeneration || id !== drawerId) return; if (r?.ok === false) throw new Error(r.error || r.reason); detail = r.detail || {available:false,reason:'No saved detail returned.'}; details.set(key,detail); }
      catch(e) { if (seq === detailGeneration) detailError = e.message || String(e); }
      finally { if (seq === detailGeneration) { renderDetail(); if (detail?.available && !detailError) warmDetails(id,seq); } }
    }
    async function warmDetails(id,seq) {
      const jobs = [1,2,5,15].flatMap(latency => [0,1,2].map(slippage => ({trader_id:id,latency,slippage}))).filter(b => !details.has(`${id}:${b.latency}:${b.slippage}`));
      for (let i=0;i<jobs.length;i+=2) {
        if (seq !== detailGeneration || id !== drawerId || disposed || document.visibilityState === 'hidden') return;
        await Promise.all(jobs.slice(i,i+2).map(async body => { try { const r = await T.brain('e8_trader_detail',body); if (seq === detailGeneration && r?.ok !== false && r.detail) details.set(`${id}:${body.latency}:${body.slippage}`,r.detail); } catch (_) {} }));
      }
    }
    let returnFocus = null;
    function openDetail(id, trigger) { returnFocus = trigger; drawerId = id; detail = details.get(detailKey(id)) || null; detailError = ''; root.querySelector('.et-backdrop').hidden = false; root.querySelector('.et-drawer-scroll').scrollTop = 0; renderDetail(); root.querySelector('[data-et="close"]').focus({preventScroll:true}); loadDetail(); }
    function closeDetail() { drawerId = null; ++detailGeneration; root.querySelector('.et-backdrop').hidden = true; if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true}); }
    let typing;
    root.addEventListener('input',e => { const k = e.target.dataset.et; if (!['query','symbol','min_trades'].includes(k)) return; if (k === 'min_trades' && !e.target.validity.valid) return; state[k] = k === 'min_trades' ? Number(e.target.value || 0) : e.target.value; state.page = 0; ++generation; clearTimeout(typing); typing = setTimeout(changeView,250); });
    root.addEventListener('change',e => {
      const k = e.target.dataset.et;
      if (k === 'class_filter') { state.class_filter = e.target.value; state.page = 0; changeView(); }
      if (k === 'select') { if (e.target.checked && selected.size >= 50) { e.target.checked = false; invalidatePortfolio(); portfolioError = 'Select at most 50 traders for a saved portfolio.'; renderPortfolio(); } else { e.target.checked ? selected.add(e.target.dataset.id) : selected.delete(e.target.dataset.id); invalidatePortfolio(); } }
      if (k === 'book') invalidatePortfolio();
    });
    root.addEventListener('click',e => {
      const b = e.target.closest('[data-et]'); if (!b || b.disabled) return; const k = b.dataset.et;
      if (k === 'refresh') { views.clear(); details.clear(); load(); if (drawerId) loadDetail(); checkVersion(); }
      if (k === 'reload') location.reload();
      if (k === 'sort') { state.direction = state.sort === b.dataset.value && state.direction === 'desc' ? 'asc' : 'desc'; state.sort = b.dataset.value; state.page = 0; changeView(); }
      if (k === 'previous' || k === 'next') { state.page += k === 'next' ? 1 : -1; changeView(); }
      if (k === 'latency' || k === 'slippage') { state[k] = Number(b.dataset.value); state.page = 0; root.querySelectorAll(`[data-et="${k}"]`).forEach(n => n.setAttribute('aria-pressed',String(Number(n.dataset.value) === state[k]))); changeView(); }
      if (k === 'class') { state.class_filter = state.class_filter === b.dataset.value ? '' : b.dataset.value; root.querySelector('[data-et="class_filter"]').value = state.class_filter; state.page = 0; changeView(); }
      if (k === 'detail') openDetail(b.dataset.id,b);
      if (k === 'close' || k === 'backdrop' && e.target === b) closeDetail();
      if (k === 'retry-detail') { detailError = ''; renderDetail(); loadDetail(); }
      if (k === 'portfolio') loadPortfolio();
      if (k === 'clear') { selected.clear(); invalidatePortfolio(); renderRows(); }
    });
    const onKey = e => {
      if (!drawerId) return;
      if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
      if (e.key === 'Tab') { const nodes = [...root.querySelector('.et-drawer').querySelectorAll('button:not(:disabled),input,select,[tabindex="0"]')].filter(n => n.getClientRects().length); const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) {e.preventDefault();last?.focus();} else if (!e.shiftKey && document.activeElement === last) {e.preventDefault();first?.focus();} }
    };
    document.addEventListener('keydown',onKey);
    const poll = () => { if (document.visibilityState !== 'hidden') { load(); if (drawerId) loadDetail(); checkVersion(); } };
    const intervalId = setInterval(poll,90000);
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange',onVisible);
    const destroy = () => { disposed = true; ++generation; ++detailGeneration; ++portfolioGeneration; ++warmGeneration; clearInterval(intervalId); clearTimeout(typing); document.removeEventListener('keydown',onKey); document.removeEventListener('visibilitychange',onVisible); };
    window.addEventListener('pagehide',destroy,{once:true});
    root.e8TraderPerformance = { refresh:poll, destroy };
    render(); renderPortfolio(); load();
    return root.e8TraderPerformance;
  }
  window.E8TraderPerformance = { mount };
  mount(document.getElementById('e8traders'));
})();
