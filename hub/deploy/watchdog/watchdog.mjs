// IPFX watchdog (runs on the Oracle server once a minute from a systemd timer).
// Checks the hub's own health and that the Supabase API answers, and sends a phone push (ntfy.sh) when things are down
// for 5 checks in a row, again every hour while still down, and once when they recover. It never changes anything.
import fs from 'node:fs';
const ENV = process.env;
const STATE = '/var/lib/ipfx-watchdog/state.json';
const TOPIC = ENV.NTFY_TOPIC, URL_ = ENV.SUPABASE_URL, KEY = ENV.SUPABASE_ANON_KEY;
const timeout = (ms) => AbortSignal.timeout(ms);
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { bad: 0, alertedAt: 0 }; } };
const save = (s) => { fs.mkdirSync('/var/lib/ipfx-watchdog', { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); };
async function push(title, message, priority = 'high') {
  if (!TOPIC) return;
  try { await fetch('https://ntfy.sh/' + TOPIC, { method: 'POST', headers: { Title: title, Priority: priority, Tags: priority === 'high' ? 'warning' : 'white_check_mark' }, body: message, signal: timeout(10000) }); } catch { /* the next run tries again */ }
}
async function check() {
  const problems = [];
  try {
    const h = await (await fetch('http://127.0.0.1:' + (ENV.PORT || 8080) + '/health', { signal: timeout(10000) })).json();
    if (!h.risk || h.risk.healthy !== true) problems.push('risk engine unhealthy (queue ' + (h.risk && h.risk.queue) + ', last full check ' + (h.risk && h.risk.lastFullAgoS) + 's ago)');
    if (h.ingestAgeMs != null && h.ingestAgeMs > 60000) problems.push('price feed stale (' + Math.round(h.ingestAgeMs / 1000) + 's)');
  } catch (e) { problems.push('hub not answering'); }
  const t0 = Date.now();
  try {
    const r = await fetch(URL_ + '/rest/v1/live_quotes?select=symbol&limit=1', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }, signal: timeout(10000) });
    if (r.status >= 500 || r.status === 402 || r.status === 429) problems.push('Supabase API returned ' + r.status);
    else if (Date.now() - t0 > 6000) problems.push('Supabase API slow (' + Math.round((Date.now() - t0) / 1000) + 's)');
  } catch (e) { problems.push('Supabase API not answering'); }
  return problems;
}
const s = load(), problems = await check(), now = Date.now();
if (problems.length) {
  s.bad = (s.bad || 0) + 1;
  if (s.bad >= 5 && now - (s.alertedAt || 0) > 3600_000) {
    await push('IPFX is having trouble', problems.join('; ') + '. Fix: Supabase dashboard, Project Settings, General, Restart project.');
    s.alertedAt = now;
  }
} else {
  if (s.alertedAt) await push('IPFX recovered', 'Hub and Supabase API are healthy again.', 'default');
  s.bad = 0; s.alertedAt = 0;
}
save(s);
