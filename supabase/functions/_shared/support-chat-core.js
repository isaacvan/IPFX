// ============================================================
// IPFX Capital — support chat core (pure logic, no Deno/Node APIs)
//
// Used by the support-chat Edge Function and by the Node tests.
//
// Where answers come from, in order of authority:
//   1. challenge_presets  -> every fee / target / limit is generated from
//      the same table the trading engine enforces, so the bot cannot drift
//      from the real rules when a preset changes.
//   2. support_config     -> owner-editable facts (contact email, payout
//      minimums, review time ...).
//   3. support_kb         -> owner-editable Q&A entries. Answers may embed
//      live values with {{...}} tokens (see expandTemplate).
// ============================================================

// ---------- formatting ----------
const n = (v) => Number(v);
const trimNum = (x) => String(Number(Number(x).toFixed(2)));
export const money = (x) => "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 });
export const pct = (x) => `${trimNum(x)}%`;
export const sizeLabel = (bal) => (n(bal) >= 1000 ? `$${trimNum(n(bal) / 1000)}K` : money(bal));

export const LABEL = {
  infinity: "Infinity Challenge",
  traditional: "Traditional Challenge",
  futures: "Futures Challenge",
  pac: "Personalised Application Challenge (PAC)",
};
const UNIT = { infinity: "Stage", traditional: "Phase", futures: "Phase", pac: "Phase" };
const MODE = {
  static: "static (measured from your starting balance)",
  trailing_intraday: "trailing (follows your highest equity)",
  trailing_eod: "end-of-day trailing (follows your highest end-of-day balance)",
};
const MODE_SHORT = { static: "static", trailing_intraday: "trailing", trailing_eod: "end-of-day trailing" };

// ---------- text normalisation ----------
// Ordered: earlier rules win. Each maps a family of phrasings to one token so a
// visitor's wording and the knowledge-base wording meet in the middle.
const SYNONYMS = [
  [/\bblew\b|\bblown\b|\bblow(?:n|ing)? up\b|\bbreach(?:ed|es|ing)?\b|\bbusted\b/g, " breach "],
  [/\bwhat (?:happens|happen|will happen|would happen) (?:when|if|after|once)\b/g, " what happens if "],
  [/\b(?:verification|confirmation|confirm|verify) (?:my |the |your )?e-?mail\b|\be-?mail (?:verification|confirmation|not (?:arriving|received))\b/g, " emailverify "],
  [/\bdraw[\s-]?down\b|\bdd\b|\bmax(?:imum)? (?:overall |total )?loss\b|\boverall loss\b|\btotal loss\b|(?<!daily )\bloss limit\b(?! per day)/g, " drawdown "],
  [/\bwithdraw(?:al|als|s)?\b|\bcash[\s-]?out\b|\bpay[\s-]?outs?\b|\bget paid\b|\bpaid out\b|\bpaycheck\b|\bbe paid\b/g, " payout "],
  [/\bk\.?y\.?c\b|\bid check\b|\bverif(?:y|ication|ied)\b|\bidentity\b|\bproof of address\b|\bpassport\b|\bdriving licen[cs]e\b|\bid\b|\bdocuments?\b/g, " kyc "],
  [/(?<!execution |trading )\bcosts?\b|\bfees\b/g, " fee "],
  [/\brefunds?\b|\bmoney back\b|\bget my money\b|\brefunded\b|\brefundable\b/g, " refund "],
  [/\bsign[\s-]?up\b|\bregister\b|\bcreate (?:an |my )?account\b|\bopen (?:an |my )?account\b/g, " signup "],
  [/\bbots?\b|\beas?\b|\bexpert advisors?\b|\balgo(?:s|rithm|rithmic)?\b|\bautomated\b|\bautomation\b/g, " algo "],
  [/\bcopy[\s-]?trad(?:e|es|er|ers|ing)\b|\bsignals?\b|\bmirror(?:ing)?\b|\bcopier\b/g, " copytrade "],
  [/\bhedg(?:e|es|ed|ing)\b/g, " hedge "],
  [/\bscalp(?:s|er|ers|ing)?\b|\btick scalping\b|\blatency\b|\barbitrage\b|\bhft\b/g, " scalp "],
  [/\bover[\s-]?night\b|\bweek[\s-]?ends?\b|\bhold(?:ing)? (?:positions?|trades?)\b/g, " holdover "],
  [/\bleverage\b|\bmargin\b|\bgearing\b/g, " leverage "],
  [/\bdesktop\b|\bdownload\b|\binstall(?:er)?\b|\bmac(?:os)?\b|\bwindows app\b/g, " desktopapp "],
  [/(?<!daily )\bre[\s-]?set\b(?! (?:my |the |your )?password)|\bretry\b|\brestart\b|\bre[\s-]?attempt\b|\banother (?:attempt|go|try)\b|\btry again\b|\bstart over\b/g, " retry "],
  [/\bcontact\b|\breach out\b|\bget in touch\b|\bhuman\b|\bagent\b|\bspeak to\b|\btalk to\b|\bsupport team\b|\bcustomer service\b/g, " contact "],
  [/\bscam\b|\blegit(?:imate)?\b|\btrust(?:worthy)?\b|\bfraud\b|\bgenuine\b|\bfake\b|\breal company\b/g, " legit "],
  [/\bregulat(?:ed|ion)\b|\bfca\b|\blicen[cs]e[ds]?\b|\bauthori[sz]ed\b/g, " regulated "],
  [/\bstop[\s-]?loss\b|\bsl\b/g, " stoploss "],
  [/\btake[\s-]?profit\b|\btp\b/g, " takeprofit "],
  [/\bfund(?:ed)? account\b|\bget funded\b|\bfunded trader\b/g, " funded "],
  [/\bprofit split\b|\bsplit\b|\bprofit share\b|\bhow much (?:do i|will i|can i) (?:keep|earn|get)\b/g, " split "],
  [/\bapply\b|\bapplication\b|\bapplying\b/g, " application "],
  [/\bdeni(?:ed|al)\b|\brejected\b|\bdeclined\b|\bnot approved\b|\bturned down\b/g, " denied "],
  [/\bdemo\b|\bvirtual\b|\bsimulat(?:ed|ion)\b|\bfake money\b/g, " simulated "],
  [/\bcrypto(?:currency|currencies)?\b|\bbitcoin\b|\bbtc\b|\beth(?:ereum)?\b/g, " crypto "],
  [/\bgold\b|\bxauusd\b|\bsilver\b|\bmetals?\b/g, " metals "],
  [/\bindices\b|\bindex\b|\bnasdaq\b|\bs&p\b|\bsp500\b|\bdow\b|\bdax\b|\bftse\b/g, " indices "],
  [/\bforex\b|\bfx\b|\bcurrenc(?:y|ies)\b|\beurusd\b|\bgbpusd\b/g, " forex "],
];
const STOP = new Set(("a an the and or but if then so of to in on at by for from with as is are was were be been being am do does did done " +
  "i me my mine we our you your it its this that these those there here what which who whom whose how when where why can could would should will shall may might " +
  "please tell about into onto over under than too very just also any some more most other such no not only own same s t don now get got have has had " +
  "im ive ill wanna gonna want need like know ll ve re d m " +
  "challenge programme program guy guys mate bro pls quick really actually basically honestly exactly kindly hello hey work works think believe thought keep hi hiya howdy yo morning afternoon evening mean means meaning").split(/\s+/));

const CHAT = [
  [/\bwhat'?s\b/g, "what is"], [/\bhow'?s\b/g, "how is"], [/\bwhere'?s\b/g, "where is"], [/\bwho'?s\b/g, "who is"],
  [/\bthat'?s\b/g, "that is"], [/\bcan'?t\b/g, "can not"], [/\bwon'?t\b/g, "will not"],
  [/\bdon'?t\b/g, "do not"], [/\bdoesn'?t\b/g, "does not"], [/\bdidn'?t\b/g, "did not"], [/\bisn'?t\b/g, "is not"],
  [/\bhaven'?t\b/g, "have not"], [/\bhasn'?t\b/g, "has not"], [/\bwasn'?t\b/g, "was not"],
  [/\bi'?m\b/g, "i am"], [/\bu\b/g, "you"], [/\bur\b/g, "your"], [/\bpl[sz]\b/g, "please"], [/\bthx\b/g, "thanks"],
  [/\bpw\b/g, "password"], [/\bwat\b/g, "what"], [/\babt\b/g, "about"], [/\bwanna\b/g, "want to"], [/\bgonna\b/g, "going to"],
];
export function canon(text) {
  let t = String(text || "").toLowerCase().replace(/[’`]/g, "'").replace(/\$|£|€/g, " $ ");
  for (const [re, to] of CHAT) t = t.replace(re, to);
  for (const [re, to] of SYNONYMS) t = t.replace(re, to);
  return t;
}
// Conversational filler: still usable for matching, but never counts as
// "a word the knowledge base doesn't know" against a question.
const SOFT_WORDS = ("during while since until through without within between again still even ever never always already maybe probably anyway though " +
  "each every many much few lot lots bit thing things stuff something anything everything someone anyone everyone proper properly actually easy easily hard " +
  "long short big small good bad best better new old first last next same different right wrong real sure yes yeah people person way ways kind sort " +
  "time times day days week month year today tomorrow yesterday soon later quickly fast slow allowed allow possible able info information after before " +
  "hit go going come see look find try say ask let put make made take give use using pass passing ok okay fine straight away immediately instantly directly " +
  "definitely surely certainly forever earliest latest exactly just only ever whole overall together").split(" ");
function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(ss|us|is)$/.test(w)) return w;
  if (w.endsWith("s")) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}
const SOFT = new Set(SOFT_WORDS.map((w) => stem(w)));
const rawWords = (text) => canon(text).replace(/[^a-z0-9%$\s]/g, " ").split(/\s+/).filter(Boolean);
const ARTICLES = new Set(["the", "a", "an", "my", "your", "our", "their", "this", "that", "was", "is", "are", "am", "be", "been", "will", "would", "does", "do", "did"]);
const phraseWords = (text) => rawWords(text).filter((w) => !ARTICLES.has(w));
export function tokens(text) {
  return rawWords(text).filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w))).map(stem);
}

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev[j - 2] + 1);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// ---------- knowledge index (BM25-lite + exact-phrase bonus + coverage) ----------
export function buildIndex(entries) {
  const vocab = new Set();
  const docs = entries.map((e) => {
    const tf = new Map();
    const add = (text, weight) => { for (const t of tokens(text)) { tf.set(t, (tf.get(t) || 0) + weight); vocab.add(t); } };
    add(e.title, 4);
    for (const k of e.keywords || []) add(k, 5);
    add(String(e.answer || "").replace(/\{\{[^}]*\}\}/g, " "), 1);
    const head = new Set([...tokens(e.title), ...(e.keywords || []).flatMap(tokens)]);
    let len = 0; for (const v of tf.values()) len += v;
    const all = [e.title, ...(e.keywords || [])];
    const phrases = all.map((k) => phraseWords(k).join(" ")).filter((k) => k.split(" ").length >= 2 || k.length >= 6)
      .map((k) => " " + k + " ");
    // content-word phrases ("order denied" matches "my order was rejected")
    const cphrases = all.map((k) => tokens(k)).filter((t) => t.length >= 2).map((t) => " " + t.join(" ") + " ");
    return { e, tf, head, len, phrases, cphrases };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(docs.length, 1);
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const avg = docs.reduce((a, d) => a + d.len, 0) / N || 1;
  return { docs, idf, avg, vocab: [...vocab], vocabSet: vocab };
}

/** Fix a likely typo by snapping an unknown word to a close vocabulary word. */
function snap(index, t) {
  if (t.length < 5 || index.vocabSet.has(t)) return t;
  const max = t.length >= 11 ? 2 : 1;
  let best = t, bestD = max + 1;
  for (const v of index.vocab) {
    if (v.length < 4 || v[0] !== t[0]) continue; // typos rarely change the first letter
    const d = editDistance(t, v, max);
    if (d < bestD) { best = v; bestD = d; }
  }
  return bestD <= max ? best : t;
}

// A programme name in the question favours that programme's own entries over
// the generic overview / fee entries.
const TOPIC_OF = { infinity: "infinity", traditional: "traditional", futures: "futures", pac: "pac" };

export function search(index, query, limit = 5) {
  const qt = [...new Set(tokens(query).map((t) => snap(index, t)))];
  const qraw = " " + phraseWords(query).join(" ") + " ";
  const qcontent = " " + tokens(query).map((t) => snap(index, t)).join(" ") + " ";
  const ent = parseEntities(query);
  const k1 = 1.4, b = 0.4;
  // A word the knowledge base has never seen is evidence the question is about
  // something else, so it counts double against coverage.
  const weight = (t) => {
    const base = Math.max(index.idf(t), 1.2);
    if (SOFT.has(t)) return 0.3 * base;
    return index.vocabSet.has(t) ? base : 1.3 * base;
  };
  const totalW = qt.reduce((a, t) => a + weight(t), 0) || 1;
  const out = [];
  for (const d of index.docs) {
    let score = 0, headHits = 0, matchedW = 0;
    for (const t of qt) {
      const f = d.tf.get(t) || 0;
      if (!f) continue;
      score += index.idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / index.avg)));
      matchedW += weight(t);
      if (d.head.has(t)) headHits++;
    }
    if (qt.length) {
      const hc = headHits / qt.length;
      score += qt.length >= 2 ? 14 * hc * hc : 4 * headHits;
    }
    let phraseHit = false;
    let best = 0;
    for (const p of d.phrases) {
      if (qraw.includes(p)) { phraseHit = true; best = Math.max(best, 6 + 4 * Math.min(p.trim().split(" ").length, 6)); }
    }
    for (const p of d.cphrases) {
      if (qcontent.includes(p)) { phraseHit = true; best = Math.max(best, 4 * Math.min(p.trim().split(" ").length, 5)); }
    }
    score += best;
    if (ent.programme && TOPIC_OF[ent.programme] === d.e.topic && (headHits || phraseHit)) score += 10 + 6 * Math.min(headHits, 3);
    else if (ent.programme && ["programmes-overview", "how-it-works", "fees-overview", "which-programme"].includes(d.e.id)) score *= 0.7;
    const coverage = phraseHit && !qt.length ? 1 : Math.min(1, matchedW / totalW);
    // an answer that covers more of what was asked outranks one that merely scores high on a few words
    score *= 0.6 + 0.4 * coverage;
    if (score > 0) out.push({ e: d.e, score, headHits, phraseHit, coverage });
  }
  out.sort((a, b2) => b2.score - a.score);
  return out.slice(0, limit);
}

/** Decide whether the top hit is trustworthy enough to answer from. */
export function confident(hits) {
  if (!hits.length) return false;
  const [a, b] = hits;
  if (!a.headHits && !a.phraseHit) return false;
  if (a.coverage < 0.4) return false;
  if (a.score >= 5.5) return true;
  return a.coverage >= 0.85 && a.score >= 3 && (!b || a.score >= b.score * 1.03);
}

// ---------- live facts from challenge_presets ----------
function byType(K, type) {
  return K.presets.filter((p) => p.challenge_type === type);
}
/** One row per stage, using `size` (in $K) if given else the smallest account. */
function stageRows(K, type, sizeK) {
  const rows = byType(K, type);
  const stages = [...new Set(rows.map((r) => n(r.stage)))].sort((a, b) => a - b);
  return stages.map((st) => {
    const cand = rows.filter((r) => n(r.stage) === st).sort((a, b) => n(a.starting_balance) - n(b.starting_balance));
    return (sizeK && cand.find((r) => n(r.starting_balance) === sizeK * 1000)) || cand[0];
  });
}
export function sizesFor(K, type) {
  return [...new Set(byType(K, type).filter((r) => n(r.stage) === 1).map((r) => n(r.starting_balance)))].sort((a, b) => a - b);
}
const amt = (r, p) => money((n(r.starting_balance) * n(p)) / 100);
const withAmt = (r, p) => `${pct(p)} (${amt(r, p)})`;

const FIELD_FMT = {
  fee: (r, t) => (n(r.fee_usd) > 0 ? money(r.fee_usd) : t === "infinity" ? "Free" : "Free (included with Phase 1)"),
  target: (r, t) => (t === "pac" ? "no fixed evaluation target — agreed with you" : n(r.profit_target_pct) ? withAmt(r, r.profit_target_pct) : "no profit target (trade within the limits)"),
  daily: (r) => `${withAmt(r, r.daily_loss_pct)} per day`,
  drawdown: (r) => `${withAmt(r, r.max_drawdown_pct)}, ${MODE_SHORT[r.drawdown_mode] || r.drawdown_mode}`,
  min_days: (r) => (n(r.min_trading_days) ? `${r.min_trading_days} trading days` : "no minimum"),
  min_trades: (r) => (n(r.min_trades) ? `${r.min_trades} trades` : "no minimum"),
  risk: (r) => (r.max_risk_per_trade_pct == null ? "no fixed per-trade risk cap" : `${withAmt(r, r.max_risk_per_trade_pct)} max per trade`),
  stoploss: (r) => (r.require_stop_loss ? "stop-loss required on every order" : "stop-loss not mandatory"),
  split: (r) => (n(r.profit_split_pct) > 0 ? pct(r.profit_split_pct) : "no profit split at this stage (evaluation only)"),
  attempts: (r) => (r.max_attempts_per_month ? `up to ${r.max_attempts_per_month} per calendar month` : null),
  cap: (r) => (r.daily_profit_cap_pct == null ? null : `${withAmt(r, r.daily_profit_cap_pct)} max profit counted per day`),
  profitable_days: (r) => (r.min_profitable_days_pct == null ? null : `at least ${pct(r.min_profitable_days_pct)} of trading days must be profitable`),
  balance: (r) => money(r.starting_balance),
};
const FIELD_NAME = {
  fee: "Fee", target: "Profit target", daily: "Max daily loss", drawdown: "Max drawdown", min_days: "Minimum trading days",
  min_trades: "Minimum trades", risk: "Risk per trade", stoploss: "Stop-loss", split: "Profit split", attempts: "Attempts",
  cap: "Daily profit cap", profitable_days: "Profitable days", balance: "Account size",
};

function collapse(items, unit) {
  const vals = items.filter((x) => x != null);
  if (!vals.length) return null;
  if (vals.every((v) => v === vals[0])) return vals.length > 1 ? `${vals[0]} (every ${unit.toLowerCase()})` : vals[0];
  return items.map((v, i) => (v == null ? null : `${unit} ${i + 1}: ${v}`)).filter(Boolean).join(" · ");
}

/** "Field for each programme" comparison used by generic rule questions. */
export function compareField(K, field) {
  const lines = [];
  for (const t of ["infinity", "traditional", "futures", "pac"]) {
    const rows = stageRows(K, t);
    if (!rows.length) continue;
    const vals = rows.map((r) => FIELD_FMT[field](r, t));
    const text = t === "traditional" || t === "futures" || t === "pac"
      ? collapse(vals, UNIT[t])
      : vals.map((v, i) => (v == null ? null : `Stage ${i + 1}: ${v}`)).filter(Boolean).join(" · ");
    if (text) lines.push(`- **${LABEL[t].replace(" (PAC)", "")}:** ${text}`);
  }
  const note = ["target", "daily", "drawdown", "risk"].includes(field)
    ? "\nDollar amounts shown are for the smallest account of each programme; percentages are the same for every size."
    : "";
  return lines.join("\n") + note;
}

export function feesText(K, type) {
  const rows = byType(K, type).filter((r) => n(r.stage) === 1).sort((a, b) => n(a.starting_balance) - n(b.starting_balance));
  if (!rows.length) return "";
  if (type === "infinity") return "Free";
  return rows.map((r) => `${sizeLabel(r.starting_balance)} ${money(r.fee_usd)}`).join(" · ");
}

export function rulesText(K, type) {
  const rows = stageRows(K, type);
  if (!rows.length) return "";
  const u = UNIT[type];
  const lines = [];
  if (type === "infinity") {
    for (const [i, r] of rows.entries()) {
      const bits = [
        `${money(r.starting_balance)} account`,
        n(r.profit_target_pct) ? `target ${withAmt(r, r.profit_target_pct)}` : "no profit target",
        `max daily loss ${withAmt(r, r.daily_loss_pct)}`,
        `max drawdown ${withAmt(r, r.max_drawdown_pct)} (${MODE_SHORT[r.drawdown_mode]})`,
        n(r.min_trading_days) ? `min ${r.min_trading_days} trading days` : null,
        n(r.min_trades) ? `min ${r.min_trades} trades` : null,
        r.max_risk_per_trade_pct == null ? null : `risk ≤ ${withAmt(r, r.max_risk_per_trade_pct)} per trade`,
        r.require_stop_loss ? "stop-loss required" : null,
        r.daily_profit_cap_pct == null ? null : `daily profit cap ${withAmt(r, r.daily_profit_cap_pct)}`,
        r.min_profitable_days_pct == null ? null : `${pct(r.min_profitable_days_pct)}+ profitable days`,
        r.max_attempts_per_month ? `up to ${r.max_attempts_per_month} attempts per month` : null,
        n(r.profit_split_pct) > 0 ? `${pct(r.profit_split_pct)} profit split` : "free evaluation",
      ].filter(Boolean);
      lines.push(`- **Stage ${i + 1}:** ${bits.join(" · ")}`);
    }
    return lines.join("\n");
  }
  if (type === "pac") {
    const r = rows[0];
    return [
      `- No fixed evaluation phase — your parameters are agreed with you after our analysts review your strategy.`,
      `- Default framework: max daily loss ${pct(r.daily_loss_pct)} · max drawdown ${pct(r.max_drawdown_pct)} (${MODE_SHORT[r.drawdown_mode]}) — custom limits can be agreed.`,
      `- Default risk ceiling ${pct(r.max_risk_per_trade_pct)} of starting balance per trade · stop-loss required · a lower cap may be agreed.`,
      `- Profit split ${pct(r.profit_split_pct)}`,
    ].join("\n");
  }
  const same = (f) => new Set(rows.map((r) => f(r))).size === 1;
  const r0 = rows[0];
  lines.push(`- ${rows.length} ${u.toLowerCase()}s. Profit targets: ${rows.map((r, i) => `${u} ${i + 1} ${pct(r.profit_target_pct)}`).join(" · ")}`);
  const common = [
    [(r) => r.daily_loss_pct, `max daily loss ${pct(r0.daily_loss_pct)}`],
    [(r) => r.max_drawdown_pct + r.drawdown_mode, `max drawdown ${pct(r0.max_drawdown_pct)} (${MODE_SHORT[r0.drawdown_mode]})`],
    [(r) => r.min_trading_days + "/" + r.min_trades, `min ${r0.min_trading_days} trading days and ${r0.min_trades} trades per ${u.toLowerCase()}`],
    [(r) => r.max_risk_per_trade_pct, r0.max_risk_per_trade_pct == null ? null : `risk ≤ ${pct(r0.max_risk_per_trade_pct)} of starting balance per trade`],
    [(r) => r.require_stop_loss, r0.require_stop_loss ? "stop-loss required on every order" : null],
    [(r) => r.profit_split_pct, `${pct(r0.profit_split_pct)} profit split`],
  ];
  const shared = [], perStage = [];
  for (const [f, text] of common) {
    if (same(f)) { if (text) shared.push(text); } else perStage.push(f);
  }
  if (shared.length) lines.push(`- Every ${u.toLowerCase()}: ${shared.join(" · ")}`);
  if (perStage.length) {
    for (const [i, r] of rows.entries()) {
      const risk = r.max_risk_per_trade_pct == null ? "no fixed per-trade cap" : `risk ≤ ${pct(r.max_risk_per_trade_pct)} per trade`;
      lines.push(`- ${u} ${i + 1}: daily ${pct(r.daily_loss_pct)} · drawdown ${pct(r.max_drawdown_pct)} · ${risk} · ${r.min_trading_days} days / ${r.min_trades} trades`);
    }
  }
  return lines.join("\n");
}

export function instrumentsText(K) {
  const labels = { forex: "Forex", index: "Indices", metal: "Metals", crypto: "Crypto", future: "Futures", commodity: "Commodities" };
  const groups = {};
  for (const s of K.symbols || []) (groups[s.asset_class] ||= []).push(s.symbol);
  return Object.entries(groups).map(([k, v]) => `**${labels[k] || k}:** ${v.sort().join(", ")}`).join("\n");
}

const PRESET_FIELDS = {
  fee: (r) => money(r.fee_usd), balance: (r) => money(r.starting_balance), size: (r) => sizeLabel(r.starting_balance),
  target_pct: (r) => pct(r.profit_target_pct), target_amt: (r) => amt(r, r.profit_target_pct),
  daily_pct: (r) => pct(r.daily_loss_pct), daily_amt: (r) => amt(r, r.daily_loss_pct),
  dd_pct: (r) => pct(r.max_drawdown_pct), dd_amt: (r) => amt(r, r.max_drawdown_pct), dd_mode: (r) => MODE_SHORT[r.drawdown_mode] || r.drawdown_mode,
  min_days: (r) => String(r.min_trading_days), min_trades: (r) => String(r.min_trades),
  risk_pct: (r) => (r.max_risk_per_trade_pct == null ? "no fixed cap" : pct(r.max_risk_per_trade_pct)),
  risk_amt: (r) => (r.max_risk_per_trade_pct == null ? "n/a" : amt(r, r.max_risk_per_trade_pct)),
  cap_pct: (r) => (r.daily_profit_cap_pct == null ? "none" : pct(r.daily_profit_cap_pct)),
  prof_days_pct: (r) => (r.min_profitable_days_pct == null ? "none" : pct(r.min_profitable_days_pct)),
  split_pct: (r) => pct(r.profit_split_pct), attempts: (r) => String(r.max_attempts_per_month ?? "unlimited"),
};

/** Expand {{c:key}}, {{p:preset_id.field}}, {{fees:type}}, {{rules:type}}, {{cmp:field}}, {{instruments}}. */
export function expandTemplate(text, K, depth = 0) {
  return String(text || "").replace(/\{\{\s*([a-z_]+)(?::([^}]+?))?\s*\}\}/g, (whole, kind, arg) => {
    try {
      if (kind === "c") { const v = K.cfg?.[arg.trim()] ?? ""; return depth < 2 ? expandTemplate(v, K, depth + 1) : v; }
      if (kind === "p") {
        const [id, field] = arg.trim().split(".");
        const row = K.presets.find((p) => p.id === id);
        return row && PRESET_FIELDS[field] ? PRESET_FIELDS[field](row) : "";
      }
      if (kind === "fees") return feesText(K, arg.trim());
      if (kind === "rules") return rulesText(K, arg.trim());
      if (kind === "cmp") return compareField(K, arg.trim());
      if (kind === "instruments") return instrumentsText(K);
      if (kind === "futures_status") {
        const has = (K.symbols || []).some((s) => /^futures?$/i.test(s.asset_class) || /^(ES|MES|NQ|MNQ|YM|MYM|RTY|M2K|CL|MCL|GC|MGC|NG|ZB|ZN)$/i.test(s.symbol));
        return has ? "CME futures contracts are included in the list above." : "No CME futures contracts are in that list at the moment.";
      }
    } catch (_) { /* fall through */ }
    return "";
  });
}

// ---------- entity extraction & structured (rules) answers ----------
const PROGRAMMES = [
  ["infinity", /\binfinity\b|\bfree challenge\b|\bfree account\b/],
  ["futures", /\bfutures?\b|\bcme\b|\bmicro contracts?\b/],
  ["pac", /\bpac\b|\bapplication challenge\b|\bpersonali[sz]ed\b/],
  ["traditional", /\btraditional\b|\bstandard challenge\b|\b(?:3|three)[\s-]phase\b|\bpaid challenge\b|\bforex challenge\b/],
];
const NUM_STAGE = { first: 1, second: 2, third: 3, fourth: 4, "1st": 1, "2nd": 2, "3rd": 3, "4th": 4 };

export function parseEntities(q) {
  const t = String(q || "").toLowerCase();
  const out = {};
  for (const [name, re] of PROGRAMMES) if (re.test(t)) { out.programme = name; break; }
  const size = t.match(/\$?\s?\b(10|25|50|100|150|200|250)\s?k\b/) || t.match(/\$?\s?\b(10|25|50|100|150|200|250)[,.\s]?000\b/);
  if (size) out.size = Number(size[1]);
  const st = t.match(/\b(?:stage|phase|step)\s*(\d)\b/) || t.match(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+(?:stage|phase)\b/);
  if (st) out.stage = NUM_STAGE[st[1]] || Number(st[1]);
  return out;
}

const DEFINITION = /\b(what is|what's|what does|what do you mean|meaning of|explain|how does|how do)\b.*\b(mean|work|calculated|measured)\b|\bwhat (?:is|are) (?:a |an |the )?(?:drawdown|trailing|static|consistency)/i;

export function parseFields(q) {
  const c = canon(q);
  const f = [];
  const has = (re) => re.test(c);
  if (has(/\bdaily\b.*\b(loss|drawdown|limit)\b|\b(loss|limit)\b.*\bper day\b|\bdaily (?:loss|limit)\b/)) f.push("daily");
  if (has(/\bdrawdown\b/) && !(f.includes("daily") && !has(/\b(overall|total|max(?:imum)? drawdown|trailing|static)\b/))) f.push("drawdown");
  if (has(/\b(fee|price|prices|pricing|cost|costs)\b|\bhow much\b.*\b(buy|start|enter|cost)\b/)) f.push("fee");
  else if (has(/\bhow much\b/) && (parseEntities(q).size || parseEntities(q).programme) && !f.length) f.push("fee");
  if (has(/\b(profit )?target\b|\bprofit goal\b|\bhow much (?:profit|do i need)\b/)) f.push("target");
  if (has(/\bmin(?:imum)?\b.*\b(trading )?days?\b|\btrading days\b/)) f.push("min_days");
  if (has(/\bmin(?:imum)?\b.*\btrades?\b|\bnumber of trades\b|\bhow many trades\b/)) f.push("min_trades");
  if (has(/\brisk\b.*\b(trade|position)\b|\bmax(?:imum)? risk\b|\bper trade\b/)) f.push("risk");
  if (has(/\bstoploss\b.*\b(required|mandatory|need|must|have to|compulsory)\b|\b(required|mandatory|need|must|have to)\b.*\bstoploss\b/)) f.push("stoploss");
  if (has(/\bsplit\b/)) f.push("split");
  if (has(/\battempts?\b|\bhow many times\b|\bretry\b/)) f.push("attempts");
  if (has(/\bdaily profit\b|\bprofit cap\b|\bprofit limit\b/)) f.push("cap");
  if (has(/\bprofitable days?\b/)) f.push("profitable_days");
  if (has(/\baccount size\b|\bstarting balance\b|\bhow much capital\b|\bwhat sizes?\b|\bwhich sizes?\b/)) f.push("balance");
  return [...new Set(f)];
}

/**
 * Deterministic answer for "what's the <rule> on <programme/size/stage>?".
 * Returns null unless the question is clearly a rules lookup.
 */
export function structuredAnswer(q, ctx, K) {
  if (/\b(refund|refundable|credit(?:ed)?|discount|promo|cancel|allowed|prohibited|can i|could i|how do i|how can i|when do|when will|why)\b/i.test(q)) return null;
  const ent = parseEntities(q);
  if (DEFINITION.test(q) && !(ent.programme || ent.size || ent.stage)) return null;
  const fields = parseFields(q);
  const prev = ctx || {};
  let programme = ent.programme;
  const isFollowUp = tokens(q).length <= 7;
  if (!fields.length) {
    // "what about the 100k?" style follow-up reuses the previous rule question
    if (isFollowUp && prev.fields?.length && (ent.size || ent.programme || ent.stage)) {
      fields.push(...prev.fields);
    } else return null;
  }
  const size = ent.size ?? prev.size;
  const stage = ent.stage;
  if (!programme) {
    if (fields.includes("fee") && ent.size) return feeBySize(K, ent.size, fields);
    if (isFollowUp && prev.programme && (ent.size || ent.stage)) programme = prev.programme;
    else return null;
  }
  const rows = stageRows(K, programme, programme === "infinity" ? null : size);
  if (!rows.length) return null;
  const sizes = sizesFor(K, programme);
  if (size && programme !== "infinity" && !sizes.includes(size * 1000)) {
    return {
      text: `${LABEL[programme]} account sizes are ${sizes.map(sizeLabel).join(", ")} — there's no ${sizeLabel(size * 1000)} option.`,
      ctx: { programme, fields },
    };
  }
  const shown = stage ? rows.filter((r) => n(r.stage) === stage) : rows;
  if (!shown.length) {
    return { text: `The ${LABEL[programme].replace(" (PAC)", "")} has ${rows.length} ${UNIT[programme].toLowerCase()}${rows.length > 1 ? "s" : ""}, so there's no ${UNIT[programme].toLowerCase()} ${stage}.`, ctx: { programme, fields } };
  }
  const head = programme === "infinity" ? LABEL[programme] : `${LABEL[programme].replace(" (PAC)", "")}${size ? " " + sizeLabel(size * 1000) : ""}`;
  const lines = [];
  for (const f of fields) {
    if (!FIELD_FMT[f]) continue;
    if (f === "fee" && programme !== "infinity") {
      const first = rows[0];
      lines.push(size
        ? `- **Fee:** ${money(first.fee_usd)} one-off (${UNIT[programme]} 1)${rows.length > 1 ? `; later ${UNIT[programme].toLowerCase()}s are free` : ""}`
        : `- **Fee (${UNIT[programme]} 1, one-off):** ${feesText(K, programme)}${rows.length > 1 ? `. Later ${UNIT[programme].toLowerCase()}s are free.` : ""}`);
      continue;
    }
    const vals = shown.map((r) => FIELD_FMT[f](r, programme));
    if (vals.every((v) => v == null)) {
      lines.push(`- **${FIELD_NAME[f]}:** not applicable to this programme.`);
      continue;
    }
    const text = shown.length === 1
      ? `${vals[0]}${programme !== "pac" && rows.length > 1 ? ` (${UNIT[programme]} ${shown[0].stage})` : ""}`
      : programme === "infinity"
        ? shown.map((r, i) => (vals[i] == null ? null : `Stage ${r.stage}: ${vals[i]}`)).filter(Boolean).join(" · ")
        : collapse(vals, UNIT[programme]);
    lines.push(`- **${FIELD_NAME[f]}:** ${text}`);
  }
  let out = `**${head}**\n${lines.join("\n")}`;
  if (!size && programme !== "infinity" && fields.some((f) => ["target", "daily", "drawdown", "risk"].includes(f))) {
    out += `\n\nPercentages apply to every account size; dollar amounts shown are for the smallest account (${sizeLabel(sizes[0])}). Tell me your size (e.g. "$50K") and I'll work it out.`;
  }
  if (!ent.programme && !ent.size && !ent.stage) return null;
  return { text: out, ctx: { programme, size: size || null, fields } };
}

function feeBySize(K, sizeK, fields) {
  const bal = sizeK * 1000;
  const parts = [];
  for (const t of ["traditional", "futures", "pac"]) {
    const r = byType(K, t).find((x) => n(x.stage) === 1 && n(x.starting_balance) === bal);
    if (r) parts.push(`- **${LABEL[t].replace(" (PAC)", "")}:** ${money(r.fee_usd)}`);
  }
  if (!parts.length) return { text: `We don't have a ${sizeLabel(bal)} paid programme. Use "What are the fees?" to see the available sizes.`, ctx: { fields } };
  return { text: `Fees for a ${sizeLabel(bal)} account:\n${parts.join("\n")}\n\nThe Infinity Challenge is free (it starts at $1,000).`, ctx: { size: sizeK, fields } };
}

// ---------- guards ----------
export const PII = {
  email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  passwordShare: /\b(my|the) (password|passcode|pin|otp|2fa code|seed phrase)\b.{0,20}\b(is|=|:)/i,
};
// A run of digits that looks like a phone number or card: >= 9 digits, allowing
// single spaces, hyphens, brackets and a leading +. Plain lists of small numbers
// separated by spaces ("25 50 100") are not treated as personal data.
const DIGIT_RUN = /\+?\d[\d ()-]{7,}\d/g;
function runLooksPersonal(run) {
  const digits = run.replace(/\D/g, "").length;
  if (digits < 9) return false;
  const groups = run.trim().split(/[\s()-]+/).filter(Boolean);
  const plainList = !/[+()-]/.test(run) && groups.every((g) => g.length <= 3);
  return !plainList;
}
function digitRunPii(t) {
  return (String(t).match(DIGIT_RUN) || []).some(runLooksPersonal);
}
export function redact(text) {
  return String(text || "")
    .replace(new RegExp(PII.email.source, "gi"), "[email]")
    .replace(DIGIT_RUN, (run) => (runLooksPersonal(run) ? "[number]" : run))
    .slice(0, 300);
}
export function containsPii(text) {
  const t = String(text || "");
  return PII.email.test(t) || PII.passwordShare.test(t) || digitRunPii(t);
}

const INJECTION = /forget (?:everything|all(?: of)? (?:that|this|your)|your (?:rules|instructions|training)|previous)|act as (?:my |an? )?(?:financial|investment|trading|tax|legal) (?:advis[eo]r|coach|consultant|expert)|ignore (?:all |any |the |your )?(?:previous|prior|above|earlier|system)|disregard (?:all |any |the |your )?(?:previous|prior|above|instructions|rules)|(?:system|developer|hidden) (?:prompt|message|instructions?)|(?:reveal|show|print|repeat|output|leak) (?:your |the )?(?:prompt|instructions|rules|context|knowledge base)|you are now\b|from now on you|act as (?:an? )?(?:developer|admin|root|dan|unrestricted|jailbroken)|pretend (?:you are|to be|that you)|developer mode|jailbreak|\bdan mode\b|override (?:your|the) (?:rules|instructions|safety)/i;
const SECRETS = /\b(api[\s-]?keys?|secret[\s-]?keys?|service[\s-]?role|anon(?:ymous)? key|access token|bearer token|jwt|webhook secret|cron secret|environment variables?|\.env\b|database (?:url|password|schema|credentials)|connection string|admin (?:password|login|panel|console|dashboard|access)|owner'?s? (?:email|password|phone|number|address)|ceo'?s? (?:email|phone|number|address|home)|source code|backend code|edge functions?|supabase (?:key|url|project|dashboard))\b/i;
const OTHER_USERS = /\bwhich (?:traders?|users?|customers?|members?|accounts?) (?:got|were|was|have|has|are|is|did|made|won)\b|\b(?:another|other|someone else'?s?|somebody else'?s?|a (?:customer|user|trader|member)'?s?|their|his|her) (?:traders?|users?|customers?|members?|persons?|people'?s?)?'?s? ?(?:account|balance|email|phone|details|password|payouts?|data|info|documents?|address)\b|\b(?:email|phone|number|address|password|balance|payouts?|details|data|info(?:rmation)?|account|identity|documents?|kyc)\b(?: details)? (?:of|for|about|belonging to) (?:another|other|a|any|some|the|that|this|his|her|their) (?:trader|user|customer|member|person|client|guy|girl|winner|account holder)s?\b|\b(?:show|give|tell|list|reveal|send|share|find|look up|leak) (?:me )?(?:the |all |every |a list of )?(?:other |another |all |every )?(?:traders?|users?|customers?|members?|clients?|accounts?)(?:'s| emails?| data| details| info| names| balances| passwords)\b|\b(?:list|show|give|dump|export|reveal|leak)(?: me)? (?:a list of |the list of )?(?:all |every |the )?(?:other )?(?:users?|traders?|customers?|members?|clients?)\b(?! (?:rules|limits|fees|work))|\bwho (?:is|are) (?:the )?(?:top|richest|biggest|best) traders?\b|\bwho (?:got|has been|was) (?:paid|funded|breached)\b/i;
const DETECTION = /\b(?:fraud|cheat(?:ing)?|copy[\s-]?trading|abuse|arbitrage|risk) (?:detection|monitoring|surveillance|systems?|engine)\b|\byour (?:fraud|risk|monitoring|detection|surveillance)\b|\bhow (?:do|does|will|would|can) (?:you|ipfx|the (?:system|platform|firm|company)|they) (?:detect|catch|spot|find|flag|monitor|identify|track|know)\b|\b(?:detection|monitoring|flagging) (?:methods?|systems?|thresholds?|logic|rules?|algorithms?|engine)\b|\b(?:avoid|evade|bypass|beat|dodge|get around|circumvent|trick|fool|cheat) (?:the )?(?:detection|rules?|checks?|limits?|drawdown|system|platform|monitoring|engine|kyc|consistency)\b|\bavoid (?:being |getting )?(?:detected|caught|flagged|banned)\b|\bloopholes?\b|\bexploit (?:the |a )?(?:platform|system|rules?|price|feed|bug)\b|\bhack\b/i;
const ADVICE = /\bshould i (?:buy|sell|trade|go long|go short|short|long)\b|\bwhich (?:pair|stock|instrument|currency|market|asset|coin)s? (?:should|to|will|is best)\b|\bbest (?:strategy|indicator|pair|setup|system) (?:to|for) (?:pass|win|profit|make)\b|\bgive me (?:a |some )?(?:signals?|trade ideas?|tips?|setups?|entries)\b|\bwill (?:btc|bitcoin|eurusd|gold|the market|the dollar|usd|gbp|nasdaq|spx|oil)\b.{0,25}\b(?:go|rise|fall|drop|pump|crash|moon|hit)\b|\bis (?:now|today) a good time (?:to )?(?:buy|sell|trade)\b|\bmarket (?:prediction|forecast|outlook)\b|\bpredict\b.{0,15}\b(?:price|market|move)\b/i;
const PERSONAL_ACCOUNT = /\b(?:check|look up|lookup|see|view|pull up|tell me|whats?|what(?:'s| is)|where(?:'s| is)) (?:the )?(?:status of )?my (?:account|application|payout|payment|challenge|kyc|documents?|balance|order|trade|breach|verification|withdrawal)\b|\bmy (?:account|application|payout|challenge|kyc|documents?|verification|payment|withdrawal|balance)\b.{0,50}\b(?:status|pending|stuck|delayed|rejected|denied|breached|closed|missing|disappeared|hasn'?t|wasn'?t|isn'?t|didn'?t|not (?:working|showing|arrived|approved|received|updated)|still waiting)\b|\bwhy (?:was|is|did|has|hasn'?t|haven'?t) (?:my|i|the)\b.{0,40}\b(?:account|application|payout|breach|breached|closed|denied|rejected|banned|suspended|approved|paid|verified)\b|\bam i (?:approved|verified|banned|breached|funded)\b|\bstatus of my\b/i;
const GREETING = /^\s*(?:hi+|hello+|hey+|heya|hiya|yo|sup|howdy|good (?:morning|afternoon|evening)|greetings)\b[\s!.,?]*(?:there|team|ipfx|bot)?[\s!.?]*$/i;
const ACK = new Set("thanks thank you thx ty cheers ta much appreciated great perfect awesome brilliant nice cool ok okay got it sounds good alright so a lot mate very for that the help info lovely fab fantastic amazing".split(" "));
const ACK_KEY = new Set(["thanks", "thank", "thx", "ty", "cheers", "ta", "great", "perfect", "awesome", "brilliant", "nice", "cool", "ok", "okay", "alright", "lovely", "fab", "fantastic", "amazing", "appreciated", "got", "sounds"]);
const isThanks = (t) => { const w = String(t).toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean); return w.length > 0 && w.length <= 6 && w.every((x) => ACK.has(x)) && w.some((x) => ACK_KEY.has(x)); };
const GOODBYE = /^\s*(?:bye+|goodbye|see (?:you|ya)|cya|later|that'?s all|nothing else|no thanks?|i'?m good|all good)[\s!.]*$/i;

const OFF_TOPIC = /\b(president|prime minister|weather|recipe|cook(?:ing)?|pasta|pizza|football|soccer|basketball|nba|movie|film|song|lyrics|poem|poetry|joke|homework|essay|translate|python|javascript|horoscope|celebrity|election|vaccine|holiday|flight|hotel|capital of)\b/i;
const DOMAIN = /\b(ipfx|challenge|payout|payouts|drawdown|funded|trader|trading|kyc|infinity|traditional|futures|pac|profit|account|prop|evaluation)\b/i;
export const isOffTopic = (t) => OFF_TOPIC.test(String(t)) && !DOMAIN.test(String(t));

/** Classify a message that must NOT be answered from knowledge. */
export function classify(text) {
  const t = String(text || "");
  if (containsPii(t)) return "pii";
  if (INJECTION.test(t)) return "injection";
  if (SECRETS.test(t)) return "secret";
  if (OTHER_USERS.test(t)) return "other_user";
  if (DETECTION.test(t)) return "detection";
  if (ADVICE.test(t)) return "advice";
  if (GREETING.test(t)) return "greeting";
  if (isThanks(t)) return "thanks";
  if (GOODBYE.test(t)) return "goodbye";
  if (PERSONAL_ACCOUNT.test(t)) return "personal_account";
  return null;
}

// ---------- LLM context ----------
export function buildDigest(K) {
  const parts = [];
  for (const t of ["infinity", "traditional", "futures", "pac"]) {
    const fees = feesText(K, t);
    parts.push(`### ${LABEL[t]}\n${rulesText(K, t)}${t === "infinity" ? "" : `\n- Fees (${UNIT[t]} 1, USD): ${fees}`}`);
  }
  parts.push(`### Instruments enabled in IPFX Markets\n${instrumentsText(K)}`);
  return parts.join("\n\n");
}

export function cfgBlock(K) {
  return Object.entries(K.cfg || {})
    .filter(([k]) => !/message|disclaimer/.test(k))
    .map(([k, v]) => `- ${k}: ${v}`).join("\n");
}

// ---------- routing (shared by the Edge Function and the tests) ----------
export function mergeCtx(raw, add) {
  const c = raw && typeof raw === "object" ? raw : {};
  const programme = ["infinity", "traditional", "futures", "pac"].includes(c.programme) ? c.programme : null;
  const size = [10, 25, 50, 100, 150, 200, 250].includes(Number(c.size)) ? Number(c.size) : null;
  const fields = Array.isArray(c.fields) ? c.fields.filter((f) => typeof f === "string").slice(0, 4) : [];
  return {
    programme: add?.programme ?? programme,
    size: add?.size ?? size,
    fields: add?.fields?.length ? add.fields : fields,
  };
}

export function fixedReplies(email) {
  return {
    pii: `For your security please don't share personal or payment details, passwords, or ID numbers in this chat — I can't see accounts anyway, and the team will never ask for them here. Ask your question without them, or email **${email}**.`,
    injection: "I can only help with questions about IPFX Capital — our programmes, rules, payouts and policies. I can't change how I work or share internal instructions. What would you like to know about IPFX?",
    secret: `I can't help with that — I don't have access to credentials, internal systems or anyone's personal contact details, and I can't share them. For anything about IPFX itself, just ask, or email **${email}**.`,
    other_user: "I can't share anything about other traders or their accounts — everyone's data is private. I can explain how our programmes, rules and payouts work in general, though.",
    detection: "I can't discuss how we monitor or detect rule breaches, or ways around the rules — that's confidential, and trying to evade it is itself a breach. The prohibited practices are set out in section 8 of the [Terms](/terms.html) and I'm happy to summarise them. Trading within the rules is exactly what we want to see.",
    personal_account: `I can't see or look up individual accounts, applications or payouts. Your [dashboard](/dashboard.html) shows live status; for anything else email **${email}** from your registered address (please don't include passwords, ID documents or card numbers) and the team will look into it.`,
    greeting: "Hi! I'm IPFX's automated assistant. I can answer questions about our challenges, fees and rules, payouts, applications and policies. What would you like to know?",
    thanks: "You're welcome! Anything else I can help with?",
    goodbye: `Thanks for stopping by. If you need anything else I'm here — or email **${email}**.`,
  };
}

/**
 * Decide how to handle a message. Pure: no network, no LLM.
 * kind: guard | smalltalk | advice | facts | kb | fallback
 */
export function route(message, prevCtx, K, index, qvec = null) {
  const useSem = !!qvec && hasVectors(index);
  const find = (q) => (useSem ? searchHybrid(index, q, qvec, 5) : search(index, q, 5));
  const sure = (h) => (useSem ? confidentHybrid(h) : confident(h));
  const cls = classify(message);
  if (cls === "advice") return { kind: "advice", cls, ctx: mergeCtx(prevCtx, null) };
  if (cls === "personal_account") {
    const hits = find(message);
    return { kind: "personal", cls, hits, ok: sure(hits), ctx: mergeCtx(prevCtx, null) };
  }
  if (cls) return { kind: ["greeting", "thanks", "goodbye"].includes(cls) ? "smalltalk" : "guard", cls, ctx: mergeCtx(prevCtx, null) };
  if (isOffTopic(message)) return { kind: "fallback", hits: [], ok: false, offTopic: true, ctx: mergeCtx(prevCtx, null) };
  const st = structuredAnswer(message, mergeCtx(prevCtx, null), K);
  const hits = find(message);
  const ok = sure(hits);
  const ent = parseEntities(message);
  const ctx = mergeCtx(prevCtx, st?.ctx ?? { programme: ent.programme, size: ent.size, fields: parseFields(message) });
  if (st) return { kind: "facts", st, hits, ok, ctx };
  return { kind: ok ? "kb" : "fallback", hits, ok, ctx };
}

export function fallbackText(K, email) {
  return K.cfg?.fallback_message
    ? expandTemplate(K.cfg.fallback_message, K)
    : `I'm not able to answer that reliably. For anything I can't help with, please email **${email}** and the team will get back to you. I can help with IPFX's programmes, fees and rules, applications and verification, payouts, refunds, referrals and data privacy.`;
}

// ---------- semantic (embedding) blending ----------
// Keyword matching is precise but brittle to paraphrase; embeddings (gte-small)
// are robust to paraphrase but noisy. Blending them was measured to lift accuracy
// on unseen questions from ~61% to ~79%. Vectors are optional: without them
// everything above still works.
export const embeddingTexts = (e) => ({
  d: `${e.title}. ${(e.keywords || []).slice(0, 10).join(". ")}`,
  t: e.title,
});
export function textHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
export const embeddingKey = (e) => { const t = embeddingTexts(e); return textHash(t.d + "|" + t.t); };

const dotp = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Attach stored vectors ({h, d, t}) to the index; entries whose text changed are ignored. */
export function attachVectors(index, rows) {
  let n = 0;
  for (const d of index.docs) {
    const raw = rows[d.e.id];
    if (!raw || raw.h !== embeddingKey(d.e)) { d.vecD = d.vecT = null; continue; }
    d.vecD = raw.d; d.vecT = raw.t; n++;
  }
  index.vectorCount = n;
  return n;
}
export const hasVectors = (index) => (index.vectorCount || 0) >= Math.max(3, Math.floor(index.docs.length * 0.6));

const SEM_FLOOR = 0.78, SEM_WEIGHT = 100, SEM_ANSWER = 0.87, SEM_GAP = 0.005;

export function searchHybrid(index, query, qvec, limit = 5) {
  const lex = search(index, query, 8);
  const semAll = index.docs.filter((d) => d.vecD)
    .map((d) => ({ d, s: Math.max(dotp(qvec, d.vecD), d.vecT ? dotp(qvec, d.vecT) : 0) }))
    .sort((a, b) => b.s - a.s);
  const sem = new Map(semAll.map((x) => [x.d.e.id, x.s]));
  const cand = new Map();
  for (const h of lex) cand.set(h.e.id, h);
  for (const x of semAll.slice(0, 5)) if (!cand.has(x.d.e.id)) cand.set(x.d.e.id, { e: x.d.e, score: 0, headHits: 0, phraseHit: false, coverage: 0 });
  const gap = semAll.length > 1 ? semAll[0].s - semAll[1].s : 0;
  const out = [...cand.values()].map((h) => {
    const s = sem.get(h.e.id) ?? 0;
    return { ...h, lex: h.score, sem: s, score: h.score + SEM_WEIGHT * Math.max(0, s - SEM_FLOOR), isSemTop: semAll[0]?.d.e.id === h.e.id, semGap: gap };
  });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

export function confidentHybrid(hits) {
  if (!hits.length) return false;
  const a = hits[0];
  const lexical = (a.headHits > 0 || a.phraseHit) && a.coverage >= 0.4 &&
    (a.lex >= 5.5 || (a.coverage >= 0.85 && a.lex >= 3));
  const semantic = a.isSemTop && a.sem >= SEM_ANSWER && a.semGap >= SEM_GAP;
  return lexical || semantic;
}
