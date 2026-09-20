// Fills prices and challenge rules on marketing pages from the live
// challenge_presets table, so the website can never drift from what the
// trading engine actually enforces or what checkout actually charges.
//
// Markup:  <span data-preset="trad_25k_p1" data-field="fee">$199</span>
// The text already in the element is the fallback shown if the request
// fails; data-prefix / data-suffix wrap the generated value.
// Fields: fee, size, balance, target, target_rev, target_pct, target_amt,
//   daily, daily_rev, daily_amt, dd, dd_rev, dd_amt, min_days, min_trades, split, risk, risk_pct,
//   profit_cap, profitable_days
// An element with data-preset-price="ID" gets data-price set to the fee.
// Fires `ipfx:presets` on document with { detail: { [id]: preset } }.
(function () {
  "use strict";
  var URL_BASE = "https://agulweemteoeagscmppy.supabase.co/rest/v1/challenge_presets";
  var ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndWx3ZWVtdGVvZWFnc2NtcHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MzU0ODIsImV4cCI6MjA4MTQxMTQ4Mn0.I70jN5DCuCn8OtISqvTRzuzGFaYd2pV8vviEED6gFlQ";
  var CACHE_KEY = "ipfx_presets_v1";
  var CACHE_MS = 5 * 60 * 1000;

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(n) {
    n = num(n);
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function pct(p) { return String(Number(num(p).toFixed(2))) + "%"; }

  function value(p, field) {
    var bal = num(p.starting_balance);
    var amt = function (x) { return money(bal * num(x) / 100); };
    switch (field) {
      case "fee": return money(p.fee_usd);
      case "size": return "$" + String(bal / 1000).replace(/\.0+$/, "") + "K";
      case "balance": return money(bal);
      case "target": return amt(p.profit_target_pct) + " (" + pct(p.profit_target_pct) + ")";
      case "target_rev": return pct(p.profit_target_pct) + " (" + amt(p.profit_target_pct) + ")";
      case "target_pct": return pct(p.profit_target_pct);
      case "target_amt": return amt(p.profit_target_pct);
      case "daily": return amt(p.daily_loss_pct) + " (" + pct(p.daily_loss_pct) + ")";
      case "daily_rev": return pct(p.daily_loss_pct) + " (" + amt(p.daily_loss_pct) + ")";
      case "dd": return amt(p.max_drawdown_pct) + " (" + pct(p.max_drawdown_pct) + ")";
      case "dd_rev": return pct(p.max_drawdown_pct) + " (" + amt(p.max_drawdown_pct) + ")";
      case "daily_amt": return amt(p.daily_loss_pct);
      case "dd_amt": return amt(p.max_drawdown_pct);
      case "min_days": return String(num(p.min_trading_days));
      case "min_trades": return String(num(p.min_trades));
      case "split": return pct(p.profit_split_pct);
      case "risk": return p.max_risk_per_trade_pct == null ? "None" : pct(p.max_risk_per_trade_pct) + " (" + amt(p.max_risk_per_trade_pct) + ")";
      case "risk_pct": return p.max_risk_per_trade_pct == null ? "None" : pct(p.max_risk_per_trade_pct);
      case "profit_cap": return p.daily_profit_cap_pct == null ? "None" : pct(p.daily_profit_cap_pct) + " (" + amt(p.daily_profit_cap_pct) + ")";
      case "profitable_days": return p.min_profitable_days_pct == null ? "None" : pct(p.min_profitable_days_pct) + "+";
      default: return null;
    }
  }

  function apply(map) {
    var els = document.querySelectorAll("[data-preset][data-field]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i], p = map[el.getAttribute("data-preset")];
      if (!p) continue;
      var v = value(p, el.getAttribute("data-field"));
      if (v === null) continue;
      el.textContent = (el.getAttribute("data-prefix") || "") + v + (el.getAttribute("data-suffix") || "");
    }
    var cards = document.querySelectorAll("[data-preset-price]");
    for (var j = 0; j < cards.length; j++) {
      var pc = map[cards[j].getAttribute("data-preset-price")];
      if (pc) cards[j].setAttribute("data-price", String(num(pc.fee_usd)));
    }
    try { document.dispatchEvent(new CustomEvent("ipfx:presets", { detail: map })); } catch (_) {}
  }

  function load() {
    try {
      var cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
      if (cached && Date.now() - cached.t < CACHE_MS) { apply(cached.map); return; }
    } catch (_) {}
    fetch(URL_BASE + "?select=*", { headers: { apikey: ANON, Authorization: "Bearer " + ANON } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (!Array.isArray(rows) || !rows.length) return;
        var map = {};
        rows.forEach(function (r) { map[r.id] = r; });
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), map: map })); } catch (_) {}
        apply(map);
      })
      .catch(function () { /* keep the fallback text already on the page */ });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
