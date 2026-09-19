// IPFX Capital — support chat widget (single shared script for every page).
//
// Talks to the public `support-chat` Edge Function. The assistant is automated,
// cannot see accounts, and answers only from IPFX's knowledge base and live
// challenge rules. Nothing is sent until the visitor sends a message; the
// conversation lives in sessionStorage only (cleared when the tab closes).
(function () {
  "use strict";
  if (window.top !== window.self) return; // never inside the dashboard iframe
  if (window.__ipfxSupportChat) return;
  window.__ipfxSupportChat = true;

  var ENDPOINT = "https://agulweemteoeagscmppy.supabase.co/functions/v1/support-chat";
  var EMAIL = "enquiries@ipfxcapital.com";
  var STORE = "ipfx_chat_v1";
  var MAX_LEN = 500;
  var DEFAULT_CHIPS = ["How does IPFX work?", "What are the fees?", "How do payouts work?", "Is the Infinity Challenge free?"];
  var WELCOME = "Hi! I'm IPFX's automated assistant. Ask me about our challenges, fees and rules, applications, payouts or policies.";

  var state = { msgs: [], ctx: null, chips: DEFAULT_CHIPS, welcomed: false };
  var busy = false;

  try {
    var saved = JSON.parse(sessionStorage.getItem(STORE) || "null");
    if (saved && Array.isArray(saved.msgs)) state = Object.assign(state, saved);
  } catch (_) { /* storage unavailable: run without persistence */ }
  function persist() {
    try { sessionStorage.setItem(STORE, JSON.stringify({ msgs: state.msgs.slice(-30), ctx: state.ctx, chips: state.chips })); } catch (_) { /* ignore */ }
  }

  // ---------- styles ----------
  var css = "\
.icw{position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;display:flex;flex-direction:column;align-items:flex-end;gap:.7rem;font-family:'Inter',system-ui,sans-serif}\
.icw *{box-sizing:border-box}\
.icw-fab{position:relative;width:54px;height:54px;border-radius:50%;background:#2563eb;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 24px rgba(37,99,235,.45);transition:transform .2s,box-shadow .2s}\
.icw-fab:hover{transform:scale(1.08);box-shadow:0 6px 32px rgba(37,99,235,.6)}\
.icw-fab:focus-visible,.icw-in:focus-visible,.icw-chip:focus-visible,.icw-x:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}\
.icw-fab svg{width:22px;height:22px;color:#fff}\
.icw-fab .icw-close{display:none}\
.icw.open .icw-fab .icw-open{display:none}.icw.open .icw-fab .icw-close{display:block}\
.icw-badge{position:absolute;top:-3px;right:-3px;width:16px;height:16px;background:#ef4444;border-radius:50%;border:2px solid #0a0a0c;font-size:.58rem;font-weight:700;color:#fff;display:flex;align-items:center;justify-content:center;pointer-events:none}\
.icw-panel{display:none;width:350px;max-width:calc(100vw - 2rem);height:520px;max-height:calc(100vh - 7rem);background:#111113;border:1px solid rgba(255,255,255,.1);border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.7);flex-direction:column;overflow:hidden}\
.icw.open .icw-panel{display:flex}\
.icw-head{display:flex;align-items:center;gap:.7rem;padding:.85rem 1rem;border-bottom:1px solid rgba(255,255,255,.08);background:#161618}\
.icw-av{width:32px;height:32px;border-radius:50%;background:#2563eb;display:flex;align-items:center;justify-content:center;flex-shrink:0}\
.icw-av svg{width:15px;height:15px;color:#fff}\
.icw-name{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:.86rem;color:#fff}\
.icw-status{font-size:.7rem;color:#9ca3af}\
.icw-hd{margin-left:auto;display:flex;gap:.25rem}\
.icw-x{background:none;border:0;color:#9ca3af;cursor:pointer;font-size:.72rem;padding:.3rem .45rem;border-radius:6px;font-family:inherit;white-space:nowrap}\
.icw-x:hover{color:#fff;background:rgba(255,255,255,.06)}\
.icw-msgs{flex:1 1 0;min-height:0;overflow-y:auto;padding:.85rem .9rem;display:flex;flex-direction:column;gap:.6rem;overscroll-behavior:contain}\
.icw-m{display:flex;flex-direction:column;max-width:90%}\
.icw-m.bot{align-self:flex-start}.icw-m.user{align-self:flex-end}\
.icw-b{padding:.55rem .8rem;border-radius:11px;font-size:.81rem;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere}\
.icw-m.bot .icw-b{background:#1a1a1d;border:1px solid rgba(255,255,255,.08);border-radius:11px 11px 11px 3px;color:#e5e7eb}\
.icw-m.user .icw-b{background:#2563eb;border-radius:11px 11px 3px 11px;color:#fff;white-space:pre-wrap}\
.icw-b p{margin:0 0 .45rem}.icw-b p:last-child{margin-bottom:0}\
.icw-b ul,.icw-b ol{margin:.15rem 0 .45rem;padding-left:1.15rem}.icw-b li{margin:.15rem 0}\
.icw-b a{color:#93c5fd;text-decoration:underline}.icw-b strong{color:#fff}\
.icw-gap{height:.35rem}\
.icw-t{font-size:.63rem;color:#6b7280;margin-top:.18rem;padding:0 .15rem}.icw-m.user .icw-t{text-align:right}\
.icw-mail{display:inline-block;margin-top:.4rem;font-size:.74rem;color:#93c5fd;border:1px solid rgba(147,197,253,.4);border-radius:999px;padding:.22rem .65rem;text-decoration:none}\
.icw-mail:hover{background:rgba(147,197,253,.1)}\
.icw-typing{display:flex;gap:3px;padding:.2rem .1rem}\
.icw-typing span{width:6px;height:6px;border-radius:50%;background:#6b7280;animation:icwd .9s ease infinite}\
.icw-typing span:nth-child(2){animation-delay:.2s}.icw-typing span:nth-child(3){animation-delay:.4s}\
@keyframes icwd{0%,80%,100%{transform:scale(.7);opacity:.5}40%{transform:scale(1);opacity:1}}\
@media (prefers-reduced-motion:reduce){.icw-typing span{animation:none}.icw-fab{transition:none}}\
.icw-chips{display:flex;flex-wrap:wrap;gap:.35rem;padding:.35rem .9rem .6rem}\
.icw-chip{padding:.28rem .6rem;border-radius:20px;border:1px solid rgba(255,255,255,.14);background:none;color:#b5b8be;font-size:.72rem;cursor:pointer;font-family:inherit;text-align:left}\
.icw-chip:hover{border-color:#2563eb;color:#93c5fd}\
.icw-form{display:flex;gap:.45rem;padding:.65rem .9rem;border-top:1px solid rgba(255,255,255,.08)}\
.icw-in{flex:1;min-width:0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:.5rem .85rem;color:#fff;font-size:16px;font-family:inherit}\
@media (min-width:481px){.icw-in{font-size:.82rem}}\
.icw-in::placeholder{color:#6b7280}\
.icw-send{width:34px;height:34px;border-radius:50%;background:#2563eb;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}\
.icw-send:disabled{opacity:.5;cursor:default}.icw-send svg{width:14px;height:14px;color:#fff}\
.icw-foot{padding:.15rem .9rem .6rem;font-size:.64rem;line-height:1.4;color:#6b7280}\
.icw-foot a{color:#9ca3af}\
.icw-head,.icw-chips,.icw-form,.icw-foot{flex-shrink:0}\
@media (max-height:560px){\
.icw{bottom:.75rem;right:.75rem}\
.icw-panel{height:calc(100vh - 5.5rem);max-height:none}\
.icw-foot,.icw-status{display:none}\
.icw-head{padding:.5rem .75rem}\
.icw-chips{flex-wrap:nowrap;overflow-x:auto;padding:.25rem .75rem .45rem}\
.icw-chip{white-space:nowrap;flex-shrink:0}\
.icw-form{padding:.5rem .75rem}\
}";

  // ---------- helpers ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function safeHref(u) {
    if (/^\/[A-Za-z0-9_\-./#?=&%]*$/.test(u)) return u;
    if (/^https:\/\/(?:www\.)?(?:ipfxcapital\.com|discord\.gg|trustpilot\.com)(?:[\/#?][A-Za-z0-9_\-./#?=&%]*)?$/.test(u)) return u;
    if (u === "mailto:" + EMAIL) return u;
    return null;
  }
  function inline(s) {
    // s is already HTML-escaped. Only links to our own domains / support email are allowed.
    s = s.replace(/(^|[\s(*])(enquiries@ipfxcapital\.com)/g, function (m, pre, mail) {
      return pre + "<a href=\"mailto:" + mail + "\">" + mail + "</a>";
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
      var href = safeHref(url.replace(/&amp;/g, "&"));
      if (!href) return text;
      return "<a href=\"" + esc(href) + "\"" + (href.charAt(0) === "/" ? "" : " target=\"_blank\" rel=\"noopener noreferrer\"") + ">" + text + "</a>";
    });
    return s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }
  function render(md) {
    var lines = esc(md).split("\n"), html = "", list = null, gap = false;
    lines.forEach(function (line) {
      var ul = line.match(/^\s*[-•]\s+(.*)$/), ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul || ol) {
        var type = ul ? "ul" : "ol";
        if (list !== type) { if (list) html += "</" + list + ">"; html += "<" + type + ">"; list = type; }
        html += "<li>" + inline((ul || ol)[1]) + "</li>"; gap = false; return;
      }
      if (list) { html += "</" + list + ">"; list = null; }
      if (!line.trim()) { if (!gap && html) html += "<div class=\"icw-gap\"></div>"; gap = true; return; }
      html += "<p>" + inline(line) + "</p>"; gap = false;
    });
    if (list) html += "</" + list + ">";
    return html;
  }
  function stamp(ts) {
    var d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  // ---------- DOM ----------
  var root = el("div", "icw");
  root.id = "ipfxChat";
  var style = el("style"); style.textContent = css;

  var panel = el("div", "icw-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "IPFX support assistant");

  var head = el("div", "icw-head");
  var av = el("div", "icw-av");
  av.innerHTML = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" aria-hidden=\"true\"><rect x=\"4\" y=\"8\" width=\"16\" height=\"11\" rx=\"3\"/><path d=\"M12 4v4M9 13h.01M15 13h.01\"/></svg>";
  var who = el("div");
  who.appendChild(el("div", "icw-name", "IPFX Support Assistant"));
  who.appendChild(el("div", "icw-status", "Automated • can't see your account"));
  var hd = el("div", "icw-hd");
  var newBtn = el("button", "icw-x", "New chat"); newBtn.type = "button"; newBtn.setAttribute("aria-label", "Start a new chat");
  var closeBtn = el("button", "icw-x", "✕"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", "Close chat");
  hd.appendChild(newBtn); hd.appendChild(closeBtn);
  head.appendChild(av); head.appendChild(who); head.appendChild(hd);

  var msgs = el("div", "icw-msgs");
  msgs.setAttribute("role", "log"); msgs.setAttribute("aria-live", "polite");
  var chips = el("div", "icw-chips");
  var form = el("form", "icw-form");
  var input = el("input", "icw-in");
  input.type = "text"; input.maxLength = MAX_LEN; input.placeholder = "Type your question…";
  input.setAttribute("aria-label", "Your question"); input.autocomplete = "off";
  var send = el("button", "icw-send"); send.type = "submit"; send.setAttribute("aria-label", "Send message");
  send.innerHTML = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" aria-hidden=\"true\"><line x1=\"22\" y1=\"2\" x2=\"11\" y2=\"13\"/><polygon points=\"22 2 15 22 11 13 2 9 22 2\"/></svg>";
  form.appendChild(input); form.appendChild(send);
  var foot = el("div", "icw-foot");
  foot.innerHTML = "Automated assistant — not financial advice. Please don't share passwords or personal/payment details. Questions are stored with personal details removed for up to 90 days to improve answers (<a href=\"/privacy.html\">Privacy</a>).";

  panel.appendChild(head); panel.appendChild(msgs); panel.appendChild(chips); panel.appendChild(form); panel.appendChild(foot);

  var fab = el("button", "icw-fab"); fab.type = "button";
  fab.setAttribute("aria-label", "Open support chat"); fab.setAttribute("aria-expanded", "false");
  fab.innerHTML = "<svg class=\"icw-open\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" aria-hidden=\"true\"><path d=\"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z\"/></svg>" +
    "<svg class=\"icw-close\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" aria-hidden=\"true\"><line x1=\"18\" y1=\"6\" x2=\"6\" y2=\"18\"/><line x1=\"6\" y1=\"6\" x2=\"18\" y2=\"18\"/></svg>";
  var badge = el("span", "icw-badge", "1");
  if (state.msgs.length) badge.style.display = "none";
  fab.appendChild(badge);

  root.appendChild(panel); root.appendChild(fab);

  // ---------- rendering ----------
  function addBubble(role, text, ts, handoff) {
    var m = el("div", "icw-m " + role);
    var b = el("div", "icw-b");
    if (role === "bot") b.innerHTML = render(text); else b.textContent = text;
    m.appendChild(b);
    if (handoff) {
      var a = el("a", "icw-mail", "Email support");
      a.href = "mailto:" + EMAIL;
      m.appendChild(a);
    }
    m.appendChild(el("div", "icw-t", stamp(ts)));
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
    return m;
  }
  function renderChips() {
    chips.textContent = "";
    (state.chips || DEFAULT_CHIPS).slice(0, 4).forEach(function (q) {
      var c = el("button", "icw-chip", q); c.type = "button";
      c.addEventListener("click", function () { ask(q); });
      chips.appendChild(c);
    });
  }
  function restore() {
    msgs.textContent = "";
    addBubble("bot", WELCOME, Date.now());
    state.msgs.forEach(function (m) { addBubble(m.role, m.text, m.ts, m.handoff); });
    renderChips();
  }
  function setBusy(v) {
    busy = v; send.disabled = v; input.disabled = v;
    if (!v) input.focus();
  }
  function typingOn() {
    var m = el("div", "icw-m bot"); m.id = "icwTyping";
    var b = el("div", "icw-b"); var t = el("div", "icw-typing");
    t.innerHTML = "<span></span><span></span><span></span>"; b.appendChild(t); m.appendChild(b);
    msgs.appendChild(m); msgs.scrollTop = msgs.scrollHeight;
  }
  function typingOff() { var t = document.getElementById("icwTyping"); if (t) t.remove(); }

  // ---------- conversation ----------
  function ask(text) {
    text = String(text || "").trim().slice(0, MAX_LEN);
    if (!text || busy) return;
    var history = state.msgs.slice(-6).map(function (m) { return { role: m.role === "bot" ? "assistant" : "user", text: m.text }; });
    var now = Date.now();
    state.msgs.push({ role: "user", text: text, ts: now });
    addBubble("user", text, now);
    input.value = "";
    chips.textContent = "";
    setBusy(true); typingOn();

    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 25000);
    fetch(ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history: history, ctx: state.ctx }),
      signal: ctl ? ctl.signal : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) { return { res: res, data: data }; });
    }).then(function (r) {
      var d = r.data;
      if (!r.res.ok || !d || d.ok !== true) {
        var msg = d && d.error ? String(d.error) : "";
        throw new Error(r.res.status === 429 || r.res.status === 400 ? msg : "");
      }
      var reply = String(d.reply || "");
      typingOff();
      var t = Date.now();
      state.msgs.push({ role: "bot", text: reply, ts: t, handoff: !!d.handoff });
      state.ctx = d.ctx || state.ctx;
      state.chips = Array.isArray(d.follow_ups) && d.follow_ups.length ? d.follow_ups : DEFAULT_CHIPS;
      addBubble("bot", reply, t, !!d.handoff);
      renderChips();
    }).catch(function (err) {
      typingOff();
      var t = Date.now();
      var text2 = err && err.message ? err.message : "Sorry — I couldn't reach the assistant just now. Please try again in a moment, or email " + EMAIL + ".";
      state.msgs.push({ role: "bot", text: text2, ts: t, handoff: true });
      addBubble("bot", text2, t, true);
      state.chips = DEFAULT_CHIPS; renderChips();
    }).then(function () {
      clearTimeout(timer); setBusy(false); persist();
    });
  }

  // ---------- events ----------
  function setOpen(open) {
    root.classList.toggle("open", open);
    fab.setAttribute("aria-expanded", open ? "true" : "false");
    fab.setAttribute("aria-label", open ? "Close support chat" : "Open support chat");
    badge.style.display = "none";
    if (open) { msgs.scrollTop = msgs.scrollHeight; setTimeout(function () { input.focus(); }, 30); }
  }
  fab.addEventListener("click", function () { setOpen(!root.classList.contains("open")); });
  closeBtn.addEventListener("click", function () { setOpen(false); fab.focus(); });
  newBtn.addEventListener("click", function () {
    if (busy) return;
    state = { msgs: [], ctx: null, chips: DEFAULT_CHIPS };
    persist(); restore(); input.focus();
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); ask(input.value); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && root.classList.contains("open")) { setOpen(false); fab.focus(); }
  });

  function mount() {
    document.head.appendChild(style);
    document.body.appendChild(root);
    restore();
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
