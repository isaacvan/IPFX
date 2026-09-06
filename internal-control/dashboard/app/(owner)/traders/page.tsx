import { createSessionClient } from "@lib/supabase-server";

// report §10.2 "Trader list" — masked name/ID, country, product/stage/
// state, accepted rule version, equity, net PnL, drawdown, profit
// factor, expectancy, review status, flag count, payout history, last
// activity. This first pass covers the identity/status columns that
// read directly off the new schema; the performance columns (net PnL,
// drawdown, profit factor) require a metric_run/prob_estimate pipeline
// to actually populate metric_run for each trading_account, which
// hasn't been built as a scheduled job yet — internal-control/lib/
// metrics.ts has the pure calculation functions, but nothing runs them
// on a schedule and writes the results yet. That's the next real gap,
// not something to fake with placeholder numbers here.
export default async function TradersPage() {
  const supabase = createSessionClient();
  const { data: accounts, error } = await supabase
    .from("trading_account")
    .select(`
      id, account_kind, created_at,
      person:person_id ( id, country_code, kyc_status )
    `)
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div>
      <h1 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Traders</h1>
      {error && <p className="neg">Could not load traders: {error.message}</p>}
      {!error && (!accounts || accounts.length === 0) && (
        <p className="label">
          No trading_account rows in the internal-control schema yet — this
          table is populated going forward as accounts are onboarded into it;
          it does not backfill the existing live trading_accounts table
          automatically (see docs/risk-framework/phase-0-data-inventory.md).
        </p>
      )}
      {accounts && accounts.length > 0 && (
        <table>
          <thead><tr><th>Account</th><th>Kind</th><th>Country</th><th>KYC</th><th>Created</th></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td><a href={`/traders/${(a.person as unknown as { id: string } | null)?.id ?? ""}`}>{a.id.slice(0, 8)}</a></td>
                <td>{a.account_kind}</td>
                <td>{(a.person as unknown as { country_code: string | null } | null)?.country_code ?? "—"}</td>
                <td>{(a.person as unknown as { kyc_status: string } | null)?.kyc_status ?? "—"}</td>
                <td>{new Date(a.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
