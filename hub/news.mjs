// High-impact news blackout for the copier (copier v2, 26 Nov 2026).
// Source: the public weekly economic calendar JSON (faireconomy), read every 30 minutes and kept on disk so a restart
// still knows the week. Only "High" impact events count. Nothing personal is ever sent: a plain GET with a generic agent.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const URL_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

export function parseCalendar(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || String(e.impact).toLowerCase() !== 'high') continue;
    const at = Date.parse(e.date);
    const cur = String(e.country || '').toUpperCase();
    if (!Number.isFinite(at) || !/^[A-Z]{3}$/.test(cur)) continue;
    out.push({ at, cur, title: String(e.title || 'News').slice(0, 80) });
  }
  return out.sort((a, b) => a.at - b.at);
}

// The first high-impact event for any of these currencies within +-windowS of atMs, or null.
export function blackout(events, currencies, atMs, windowS) {
  if (!windowS || !events.length || !currencies?.length) return null;
  const w = windowS * 1000;
  for (const e of events) {
    if (e.at > atMs + w) break;
    if (e.at >= atMs - w && currencies.includes(e.cur)) return e;
  }
  return null;
}

export class News {
  constructor({ path, log, fetchImpl = fetch }) { this.path = path; this.log = log; this.fetch = fetchImpl; this.events = []; this.fetchedAt = 0; this.error = null; }
  load() {
    try { const v = JSON.parse(readFileSync(this.path, 'utf8')); if (Array.isArray(v.events)) { this.events = v.events; this.fetchedAt = v.fetchedAt || 0; } } catch { /* first run */ }
    return this.events.length;
  }
  async refresh() {
    try {
      const r = await this.fetch(URL_THIS_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; calendar-reader)', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error('calendar HTTP ' + r.status);
      const events = parseCalendar(await r.json());
      if (events.length) {
        // keep last week's tail so a Monday-morning restart still knows Friday's late events
        const cutoff = Date.now() - 2 * 86_400_000;
        this.events = [...this.events.filter((e) => e.at >= cutoff && e.at < events[0].at), ...events];
        this.fetchedAt = Date.now(); this.error = null;
        try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify({ fetchedAt: this.fetchedAt, events: this.events })); } catch { /* disk is optional */ }
      }
    } catch (e) { this.error = String(e.message || e).slice(0, 120); this.log?.('news refresh failed', this.error); }
  }
  start() { this.load(); this.refresh(); setInterval(() => this.refresh(), 30 * 60_000).unref(); }
  check(currencies, atMs, windowS) { return blackout(this.events, currencies, atMs, windowS); }
  summary() { const now = Date.now(); return { events: this.events.length, next: this.events.find((e) => e.at > now) || null, fetchedAgoS: this.fetchedAt ? Math.round((now - this.fetchedAt) / 1000) : null, error: this.error }; }
}
