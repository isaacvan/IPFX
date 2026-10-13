// Owner-only diagnostics. Configuration is not execution proof; missing observations are never zero.
type Check = { id: string; title: string; state: 'checked' | 'action' | 'unknown'; detail: string; href: string };
type Inputs = {
  settings: Record<string, any> | null;
  accounts: Record<string, any>[];
  reviewDestinations?: Record<string, any>[];
  capacity: Record<string, any>[] | null;
  reference: Record<string, any> | null;
  developerConfigured: boolean;
  signupSecretsConfigured: boolean;
  errors: string[];
  ongoing?: {connections?:Record<string,any>[]} | null;
};
export function launchReadiness(input: Inputs, now = Date.now()) {
  const checks: Check[] = [];
  const add = (id: string, title: string, state: Check['state'], detail: string, href: string) => checks.push({id, title, state, detail, href});
  const monitors = input.accounts.filter(a => a.role === 'monitor' && a.execution_enabled === false);
  const demos = [...input.accounts.filter(a => a.role !== 'monitor' && a.api_env === 'demo' && ['shadow', 'ladder'].includes(a.role)),
    ...(input.reviewDestinations ?? []).filter(d => d.environment === 'demo' && d.status === 'connected').map(d => ({id:d.book,role:'review',capacity_book:d.book,execution_enabled:true}))];
  add('monitor', 'E8 monitoring connection', monitors.length ? 'checked' : 'action',
    monitors.length ? `${monitors.length} read-only account connection(s) saved. This does not prove sampling is running.` : 'Connect your E8 account yourself. It will remain read-only.', 'team-e8-monitor.html');
  const profiles = Array.isArray(input.reference?.accounts) ? input.reference.accounts : [];
  const monitorIds = new Set(monitors.map(a => String(a.id)));
  const recent = profiles.filter((p: any) => monitorIds.has(String(p.account_id ?? p.id)) && p.enabled === true && !p.error_code &&
    Number.isFinite(Date.parse(p.last_quote_at)) && now - Date.parse(p.last_quote_at) >= 0 && now - Date.parse(p.last_quote_at) <= Number(p.max_quote_age_ms ?? 15000));
  add('sampling', 'Recent E8 observations', input.reference == null ? 'unknown' : recent.length ? 'checked' : 'action',
    input.reference == null ? 'Monitor data could not be read.' : recent.length ? `${recent.length} monitor(s) received a recent API observation. Prices are samples, not confirmed fills.` : 'Start sampling on the E8 monitor page, or inspect its error and last-quote time. Closed markets can have no fresh prices.', 'team-e8-monitor.html#settings');
  add('demo', 'Execution demo connection', demos.length ? 'checked' : 'action',
    demos.length ? `${demos.length} demo connection(s) saved; ${demos.filter(a => a.execution_enabled === true).length} have copying switched on. Saved connections do not prove broker execution.` : 'Connect an approved broker demo. No funded account or monitor will be enabled by this checklist.', '#accountSetup');
  const limits = new Map((input.capacity ?? []).map(l => [l.book, l]));
  const ongoing=(input.ongoing?.connections??[]).filter(c=>c.connected);
  add('ongoing','Owner-selected A-book execution',input.ongoing===null?'unknown':ongoing.length?'checked':'action',input.ongoing===null?'Execution-control status could not be read.':`${ongoing.length} ongoing connection(s); ${ongoing.filter(c=>c.execution_on).length} execution ON. Only explicitly selected traders are eligible; monitoring remains a separate read-only service.`,'team-a-book.html');
  const documented = demos.filter(a => {
    const l = limits.get(a.capacity_book ?? (a.role === 'shadow' ? 's' : 'l') + a.id);
    return l && Number.isSafeInteger(Number(l.position_limit)) && Number(l.position_limit) > 0 && Number.isFinite(Number(l.margin_per_lot_usd)) && Number(l.margin_per_lot_usd) > 0 && String(l.provider_evidence ?? '').trim().length >= 10;
  });
  add('capacity', 'Documented broker capacity', input.capacity == null ? 'unknown' : demos.length && documented.length === demos.length && input.developerConfigured ? 'checked' : 'action',
    input.capacity == null ? 'Capacity settings could not be read.' : `${documented.length}/${demos.length} demos have recorded position and margin limits. Developer access is ${input.developerConfigured ? 'configured' : 'not configured'}. Provider approval, fresh inventory and actual margin mapping still need verification.`, '#ladderRows');
  const fills = Number(input.reference?.fills), complete = Number(input.reference?.fee_complete_fills);
  add('costs', 'Broker cost history', input.reference == null ? 'unknown' : fills > 0 && complete === fills ? 'checked' : 'action',
    input.reference == null ? 'Cost history could not be read.' : Number.isFinite(fills) && Number.isFinite(complete) ? `${complete}/${fills} retained reference fills have complete reported cost fields. This does not verify net profit for simulated copies or execution slippage.` : 'No complete broker cost evidence available.', 'team-e8-monitor.html');
  add('execution', 'Real copy validation', 'action', 'Confirm demo opens, stop changes, repeated partial closes, full closes and failure recovery against broker receipts. Internal estimates and E8 reference trades are separate evidence.', 'team-brain.html');
  const reserve = input.settings?.starting_reserve_usd;
  add('reserve', 'Cash reserve and reconciliation', 'action', reserve != null && Number.isFinite(Number(reserve)) && Number(reserve) >= 0 ? 'A reserve amount is recorded. Check it against available cash, paid fees and liabilities; recording a number is not bank reconciliation.' : 'Enter your actual available reserve in USD, then reconcile cash and fees.', '#reserveForm');
  add('signup', 'Signup protection setup', 'action', input.signupSecretsConfigured ? 'Signup secrets are configured. Verify the public widget and enabled Supabase signup hook with a controlled signup.' : 'Configure the Turnstile and signup-hook secrets, public site key and Auth hook. Enter secrets yourself in Supabase.', 'signup.html');
  add('scale', '2,000-trader trading capacity', 'action', 'Local stress results are preparation only. The full hosted order, database and provider path still needs an approved test window.', 'team-brain.html');
  return {as_of: new Date(now).toISOString(), checks, diagnostics_complete: input.errors.length === 0, errors: input.errors,
    monitor_read_only: true, execution_enablement_changed: false, production_capacity_verified: false};
}
