// Live RLS probe: uses ONLY the public anon key (already shipped in the site) and asserts
// that no sensitive table returns rows to an unauthenticated caller.
// Usage: node scripts/anon-rls-probe.mjs      (exit code 1 on any leak)
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../trading.html', import.meta.url), 'utf8');
const url = (src.match(/SUPABASE_URL\s*=\s*'([^']+)'/) || [])[1];
const key = (src.match(/SUPABASE_KEY\s*=\s*'([^']+)'/) || [])[1];
if (!url || !key) { console.error('could not find public Supabase URL/anon key'); process.exit(2); }

const SENSITIVE = ['trading_accounts', 'trades', 'payouts', 'payout_methods', 'trader_kyc', 'kyc_submissions',
  'user_profiles', 'admins', 'admin_audit_log', 'mirror_targets', 'mirror_orders', 'tradelocker_demo_connections',
  'checkout_orders', 'receipts', 'referrals', 'referral_rewards', 'pending_orders', 'equity_snapshots',
  'account_breach_events', 'trader_risk', 'trader_stats', 'platform_config', 'email_events', 'accepted_terms', 'person'];

let leaks = 0;
for (const table of SENSITIVE) {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const body = await res.text();
  let rows = null; try { rows = JSON.parse(body); } catch { /* non-json */ }
  const leaked = res.ok && Array.isArray(rows) && rows.length > 0;
  if (leaked) leaks++;
  console.log(`${leaked ? 'LEAK' : 'ok  '} ${table.padEnd(30)} HTTP ${res.status}${Array.isArray(rows) ? ` rows=${rows.length}` : ''}`);
  // Anonymous writes must also be refused.
  const w = await fetch(`${url}/rest/v1/${table}`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: '{}' });
  if (w.ok) { leaks++; console.log(`LEAK ${table} accepted an anonymous INSERT (HTTP ${w.status})`); }
}
console.log(leaks ? `\n${leaks} exposure(s) found` : '\nno anonymous exposure');
process.exit(leaks ? 1 : 0);
