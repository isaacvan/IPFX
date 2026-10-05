// IPFX hub (hub.ipfxcapital.com, free Oracle Cloud server). Streams live prices to IPFX Markets over one
// WebSocket per trader (instead of Supabase Realtime, billed per message per viewer) and runs the tick-by-tick
// position watcher (risk.mjs). Holds no service key: only the anon key and a dedicated hub secret.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Risk } from './risk.mjs';

const env = process.env;
const PORT = Number(env.PORT || 8080);
const SB_URL = env.SUPABASE_URL, SB_ANON = env.SUPABASE_ANON_KEY, SECRET = env.HUB_SECRET || '';
const RISK_MODE = env.RISK_MODE === 'active' ? 'active' : 'shadow';
const LOADTEST_KEY = env.LOADTEST_KEY && env.LOADTEST_KEY.length >= 32 ? env.LOADTEST_KEY : '';
const MAX_CLIENTS = 20_000, MAX_PER_IP = 30, MAX_SUBS = 60;
const SYMBOL_RE = /^[A-Z0-9:._-]{2,20}$/;
if (!SB_URL || !SB_ANON || SECRET.length < 32) { console.error('missing SUPABASE_URL / SUPABASE_ANON_KEY / HUB_SECRET'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);
const secretOk = (got) => {
  const a = Buffer.from(String(got ?? '')), b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function rpc(name, args) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: SECRET, ...args }), signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`${name} ${r.status} ${(await r.text()).slice(0, 120)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function engine(body) {
  const r = await fetch(`${SB_URL}/functions/v1/trading-engine`, {
    method: 'POST', headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, 'Content-Type': 'application/json', 'x-hub-secret': SECRET },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`engine ${r.status}`);
  return r.json();
}

// ---------- prices ----------
const quotes = new Map();                         // symbol -> {s,b,a,m,sp,d,pt,rt,at}
const subsBySymbol = new Map();                   // symbol -> Set<ws>
const risk = new Risk({ quotes, rpc, engine, mode: RISK_MODE, log });
const counters = { ingests: 0, quotesIn: 0, framesOut: 0, dropsSlow: 0, authOk: 0, authFail: 0 };
let lastIngestAt = 0;

function ingest(list) {
  const now = Date.now();
  lastIngestAt = now; counters.ingests++;
  const perClient = new Map();
  for (const x of list) {
    if (!x || !SYMBOL_RE.test(x.s) || !(x.b > 0) || !(x.a > 0)) continue;
    const q = { s: x.s, b: x.b, a: x.a, m: x.m ?? (x.b + x.a) / 2, sp: x.sp ?? x.a - x.b, d: x.d, pt: x.pt, rt: x.rt, at: now };
    quotes.set(q.s, q); counters.quotesIn++;
    const frag = JSON.stringify({ s: q.s, b: q.b, a: q.a, m: q.m, sp: q.sp, d: q.d, pt: q.pt, rt: q.rt });
    for (const ws of subsBySymbol.get(q.s) ?? []) {
      if (!perClient.has(ws)) perClient.set(ws, []);
      perClient.get(ws).push(frag);
    }
    try { risk.onQuote(q); } catch (e) { log('risk error', String(e)); }
  }
  for (const [ws, frags] of perClient) {
    if (ws.readyState !== 1) continue;
    if (ws.bufferedAmount > 512 * 1024) { counters.dropsSlow++; continue; }   // never let one slow phone back up the hub
    ws.send(`{"t":"q","q":[${frags.join(',')}]}`); counters.framesOut++;
  }
}

// ---------- auth ----------
const authCache = new Map();                       // sha256(token) -> {uid, exp}
async function verify(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return null;
  if (LOADTEST_KEY && token.length === LOADTEST_KEY.length && timingSafeEqual(Buffer.from(token), Buffer.from(LOADTEST_KEY))) return 'loadtest';
  const key = createHash('sha256').update(token).digest('hex');
  const hit = authCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.uid;
  let exp = Date.now() + 300_000;
  try { const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); if (p.exp) exp = Math.min(exp, p.exp * 1000); } catch { return null; }
  if (exp <= Date.now()) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!r || !r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u?.id) return null;
  authCache.set(key, { uid: u.id, exp });
  if (authCache.size > 50_000) for (const [k, v] of authCache) if (v.exp < Date.now()) authCache.delete(k);
  return u.id;
}

// ---------- HTTP ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, clients: wss.clients.size, quotes: quotes.size, ingestAgeMs: lastIngestAt ? Date.now() - lastIngestAt : null, risk: { mode: RISK_MODE, healthy: risk.healthy() } });
    }
    if (req.method === 'POST' && (req.url === '/ingest' || req.url === '/event')) {
      if (!secretOk(req.headers['x-hub-secret'])) return send(res, 401, { ok: false });
      const body = JSON.parse(await readBody(req, 512 * 1024) || '{}');
      if (req.url === '/ingest') { ingest(Array.isArray(body.q) ? body.q : []); return send(res, 200, { ok: true }); }
      if (typeof body.account_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.account_id)) risk.refreshAccount(body.account_id);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { ok: false });
  } catch { send(res, 400, { ok: false }); }
});

// ---------- WebSocket ----------
const perIp = new Map();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
function unsubscribeAll(ws) { for (const s of ws.subs) subsBySymbol.get(s)?.delete(ws); ws.subs.clear(); }

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (wss.clients.size > MAX_CLIENTS || (perIp.get(ip) ?? 0) >= MAX_PER_IP) { ws.close(1013, 'busy'); return; }
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  ws.ip = ip; ws.uid = null; ws.subs = new Set(); ws.alive = true;
  const authTimer = setTimeout(() => { if (!ws.uid) ws.close(4401, 'auth timeout'); }, 10_000);
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'auth') {
      const uid = await verify(m.token);
      if (!uid) { counters.authFail++; ws.send('{"t":"auth","ok":false}'); return ws.close(4401, 'unauthorised'); }
      counters.authOk++; ws.uid = uid; clearTimeout(authTimer);
      return ws.send(JSON.stringify({ t: 'auth', ok: true, risk: RISK_MODE, rk: risk.healthy() }));
    }
    if (!ws.uid) return;
    if (m.t === 'sub' && Array.isArray(m.s)) {
      unsubscribeAll(ws);
      for (const s of m.s.slice(0, MAX_SUBS)) {
        if (typeof s !== 'string' || !SYMBOL_RE.test(s)) continue;
        ws.subs.add(s);
        if (!subsBySymbol.has(s)) subsBySymbol.set(s, new Set());
        subsBySymbol.get(s).add(ws);
      }
      const snap = [...ws.subs].map((s) => quotes.get(s)).filter(Boolean)
        .map((q) => JSON.stringify({ s: q.s, b: q.b, a: q.a, m: q.m, sp: q.sp, d: q.d, pt: q.pt, rt: q.rt }));
      if (snap.length) ws.send(`{"t":"q","q":[${snap.join(',')}]}`);
    }
  });
  ws.on('close', () => {
    clearTimeout(authTimer); unsubscribeAll(ws);
    const n = (perIp.get(ip) ?? 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
  });
  ws.on('error', () => {});
});

// keep-alive, and tell pages whether the hub's position watcher is active (they relax their own checks only then)
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
}, 30_000).unref();
setInterval(() => {
  const hb = JSON.stringify({ t: 'hb', risk: RISK_MODE, rk: risk.healthy(), feed: lastIngestAt ? Date.now() - lastIngestAt : null, at: Date.now() });
  for (const ws of wss.clients) if (ws.uid && ws.readyState === 1) ws.send(hb);
}, 5_000).unref();

// symbols the pump must keep pushing: everything viewers watch plus every open position / resting order
setInterval(() => {
  const syms = [...new Set([...[...subsBySymbol].filter(([, v]) => v.size).map(([k]) => k), ...risk.symbols()])];
  if (syms.length) rpc('hub_watch', { p_symbols: syms }).catch((e) => log('watch failed', String(e)));
}, 20_000).unref();

// heartbeat for the owner's Brain page
const started = Date.now();
setInterval(() => {
  const mem = process.memoryUsage();
  const detail = { ok: risk.healthy() && (!lastIngestAt || Date.now() - lastIngestAt < 60_000), clients: wss.clients.size,
    authed: [...wss.clients].filter((w) => w.uid).length, ingestAgeMs: lastIngestAt ? Date.now() - lastIngestAt : null,
    quotes: quotes.size, uptimeS: Math.round((Date.now() - started) / 1000), rssMb: Math.round(mem.rss / 1048576), ...counters, risk: risk.summary() };
  rpc('hub_heartbeat', { p_detail: detail }).catch((e) => log('heartbeat failed', String(e)));
}, 30_000).unref();

server.listen(PORT, '127.0.0.1', () => log(`ipfx-hub listening on ${PORT}, risk ${RISK_MODE}`));
risk.start().then(() => log('risk watcher ready', JSON.stringify(risk.summary()))).catch((e) => log('risk start failed', String(e)));
