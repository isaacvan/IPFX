import { createSessionClient, createServiceClient } from "@lib/supabase-server";
import {
  netTradePnl, profitFactor, expectancy, winRate, payoffRatio,
  sharpeRatio, sortinoRatio, maxDrawdown, concentrationHHI,
  holdingTimeStats, bestDayShare, dailyReturnSeries,
  type ClosedTrade, type EquityPoint, type ExposureSnapshot,
} from "@shared/metrics";
import { detectStrategyFingerprint } from "@shared/strategy-profile";

// Trader profile — identity, real trade history, and performance metrics
// computed live via internal-control/lib/metrics.ts (report §6, unit
// tested in internal-control/tests/core.test.ts). Metrics are computed
// on-demand from this trader's own closed trades, not read from a
// metric_run table — there's no scheduled pipeline populating that table
// yet (see traders/page.tsx), but a single profile's numbers are cheap
// enough to compute per request, and doing so here means these numbers
// are real today rather than waiting on that pipeline.
//
// This platform tracks no separate commission/swap/spread/slippage
// figures, so costsKnown is always false on every trade below — metrics.ts
// surfaces that honestly as a "cost_unmodeled" warning rather than
// silently treating untracked costs as zero.

interface LiveTrade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  volume: number;
  open_price: number;
  close_price: number | null;
  sl: number | null;
  tp: number | null;
  status: string;
  pnl: number | null;
  opened_at: string;
  closed_at: string | null;
}

function fmtMoney(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return (n * 100).toFixed(1) + "%";
}
function fmtNum(n: number | null, digits = 2): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toFixed(digits);
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="stat-card" style={color ? ({ "--accent-color": color } as React.CSSProperties) : undefined}>
      <div className="label">{label}</div>
      <div className="stat-value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// Minimal inline SVG equity curve — no charting dependency, computed
// server-side from the same points fed to maxDrawdown()/dailyReturnSeries().
function EquityCurve({ points }: { points: EquityPoint[] }) {
  if (points.length < 2) return <p className="label">Not enough closed trades yet for an equity curve.</p>;
  const w = 640, h = 140, pad = 8;
  const values = points.map((p) => p.equity);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - min) / range) * (h - pad * 2);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
  const area = `${path} L${x(points.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`;
  const firstPoint = points[0]!;
  const lastPoint = points[points.length - 1]!;
  const up = lastPoint.equity >= firstPoint.equity;
  const stroke = up ? "var(--pos)" : "var(--neg)";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Realized equity curve">
      <defs>
        <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#eqfill)" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="2" />
    </svg>
  );
}

function WinLossDonut({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses;
  if (total === 0) return null;
  const r = 32, c = 2 * Math.PI * r;
  const winFrac = wins / total;
  return (
    <svg width="88" height="88" viewBox="0 0 88 88">
      <circle cx="44" cy="44" r={r} fill="none" stroke="var(--neg)" strokeWidth="12" />
      <circle cx="44" cy="44" r={r} fill="none" stroke="var(--pos)" strokeWidth="12"
        strokeDasharray={`${c * winFrac} ${c}`} strokeDashoffset={c * 0.25} transform="rotate(-90 44 44)" />
      <text x="44" y="48" textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--text)">{Math.round(winFrac * 100)}%</text>
    </svg>
  );
}

export default async function TraderProfilePage({ params }: { params: { personId: string } }) {
  const supabase = createSessionClient();
  const { data: person, error } = await supabase
    .from("person")
    .select("id, auth_user_id, country_code, kyc_status, risk_region, created_at")
    .eq("id", params.personId)
    .maybeSingle();

  if (error) return <p className="neg">Could not load trader: {error.message}</p>;
  if (!person) return <p className="label">Trader not found (or RLS is correctly hiding it — this page uses the RLS-respecting session client, not the service-role client).</p>;

  const { data: tokens } = await supabase
    .from("api_token")
    .select("id, key_fingerprint, scope_text, created_at, revoked_at, expires_at")
    .eq("person_id", person.id)
    .order("created_at", { ascending: false });

  const { data: governance } = await supabase
    .from("trading_account")
    .select("id, live_trading_account_id, account_kind, created_at")
    .eq("person_id", person.id)
    .order("created_at", { ascending: false });

  // Identity (name/email) and live trade data live outside this schema's
  // RLS (auth.users, and the pre-existing trading_accounts/trades tables
  // from before this governance layer existed) — service-role, server-
  // only, already gated by requireOwner() before this page ever renders.
  const service = createServiceClient();
  const { data: authUser } = await service.auth.admin.getUserById(person.auth_user_id);
  const meta = authUser?.user?.user_metadata as Record<string, unknown> | undefined;
  const displayName = (meta?.full_name as string) || (meta?.name as string) || authUser?.user?.email || "—";
  const email = authUser?.user?.email ?? "—";

  const liveAccountId = governance?.[0]?.live_trading_account_id ?? null;
  let liveAccount: { balance: number; starting_balance: number; label: string; status: string; created_at: string } | null = null;
  let closedTrades: LiveTrade[] = [];
  let openTrades: LiveTrade[] = [];
  let pendingOrders: { id: string; symbol: string; side: string; order_type: string; volume: number; trigger_price: number; status: string; created_at: string }[] = [];
  let orderIdByTrade: Record<string, string> = {};

  if (liveAccountId) {
    const [acctRes, closedRes, openRes, pendingRes] = await Promise.all([
      service.from("trading_accounts").select("balance, starting_balance, label, status, created_at").eq("id", liveAccountId).maybeSingle(),
      service.from("trades").select("*").eq("account_id", liveAccountId).eq("status", "closed").order("closed_at", { ascending: true }),
      service.from("trades").select("*").eq("account_id", liveAccountId).eq("status", "open").order("opened_at", { ascending: false }),
      service.from("pending_orders").select("id, symbol, side, order_type, volume, trigger_price, status, created_at").eq("account_id", liveAccountId).eq("status", "pending").order("created_at", { ascending: false }),
    ]);
    liveAccount = acctRes.data ?? null;
    closedTrades = closedRes.data ?? [];
    openTrades = openRes.data ?? [];
    pendingOrders = pendingRes.data ?? [];

    const allTradeIds = [...closedTrades.map((t) => t.id), ...openTrades.map((t) => t.id)];
    if (allTradeIds.length) {
      const { data: events } = await service.from("order_audit_events")
        .select("id, trade_id, server_ts").in("trade_id", allTradeIds).order("server_ts", { ascending: true });
      for (const e of events ?? []) {
        if (e.trade_id) orderIdByTrade[e.trade_id] = String(e.id);
      }
    }
  }

  // ---- Map to metrics.ts input shapes (report §6) ----
  // Kept paired with their raw row (not a second parallel array indexed
  // separately) so filtering out a trade with no pnl/closed_at can never
  // silently misalign a metric-shaped trade with the wrong raw trade.
  const closedPairs: { raw: LiveTrade; metric: ClosedTrade }[] = closedTrades
    .filter((t) => t.pnl !== null && t.closed_at)
    .map((t) => ({
      raw: t,
      metric: {
        id: t.id,
        openedAt: new Date(t.opened_at),
        closedAt: new Date(t.closed_at as string),
        pnlGross: Number(t.pnl),
        commission: null, swap: null, spreadCost: null, slippageCost: null,
        costsKnown: false,
      },
    }));
  const closedForMetrics: ClosedTrade[] = closedPairs.map((p) => p.metric);

  const startBalance = liveAccount ? Number(liveAccount.starting_balance) : 0;
  let running = startBalance;
  const equityPoints: EquityPoint[] = [
    { t: liveAccount ? new Date(liveAccount.created_at) : new Date(), equity: startBalance, externalFlow: 0 },
    ...closedForMetrics.map((t) => {
      running += netTradePnl(t);
      return { t: t.closedAt, equity: running, externalFlow: 0 };
    }),
  ];

  const pf = profitFactor(closedForMetrics);
  const exp = expectancy(closedForMetrics);
  const wr = winRate(closedForMetrics);
  const payoff = payoffRatio(closedForMetrics);
  const dd = maxDrawdown(equityPoints);
  const holding = holdingTimeStats(closedForMetrics);
  const returns = dailyReturnSeries(equityPoints);
  const sharpe = returns.value ? sharpeRatio(returns.value) : { value: null, status: "insufficient_evidence" as const, sampleSize: 0, warnings: [] };
  const sortino = returns.value ? sortinoRatio(returns.value) : { value: null, status: "insufficient_evidence" as const, sampleSize: 0, warnings: [] };
  const dailyPnlBuckets = new Map<string, number>();
  for (const t of closedForMetrics) {
    const day = t.closedAt.toISOString().slice(0, 10);
    dailyPnlBuckets.set(day, (dailyPnlBuckets.get(day) ?? 0) + netTradePnl(t));
  }
  const bestDay = bestDayShare([...dailyPnlBuckets.values()]);

  const exposureSnapshots: ExposureSnapshot[] = closedPairs.map(({ raw }) => (
    { symbol: raw.symbol, notional: Math.abs(raw.volume * raw.open_price), direction: raw.side === "buy" ? 1 : -1 }
  ));
  const hhi = concentrationHHI(exposureSnapshots);

  const totalNetPnl = closedForMetrics.reduce((s, t) => s + netTradePnl(t), 0);
  const wins = closedForMetrics.filter((t) => netTradePnl(t) > 0).length;
  const losses = closedForMetrics.filter((t) => netTradePnl(t) < 0).length;

  // ---- Per-instrument breakdown ----
  const bySymbol = new Map<string, ClosedTrade[]>();
  for (const { raw, metric } of closedPairs) {
    bySymbol.set(raw.symbol, [...(bySymbol.get(raw.symbol) ?? []), metric]);
  }
  const instrumentRows = [...bySymbol.entries()].map(([symbol, trades]) => {
    const pnl = trades.reduce((s, t) => s + netTradePnl(t), 0);
    const w = winRate(trades);
    return { symbol, count: trades.length, pnl, winRate: w.value };
  }).sort((a, b) => b.pnl - a.pnl);

  const strategyProfile = detectStrategyFingerprint(closedPairs.map(({ raw }) => ({
    id: raw.id,
    symbol: raw.symbol,
    side: raw.side,
    openedAt: new Date(raw.opened_at),
    closedAt: new Date(raw.closed_at as string),
    volume: Number(raw.volume),
    entryPrice: Number(raw.open_price),
    exitPrice: raw.close_price === null ? null : Number(raw.close_price),
    stopLoss: raw.sl === null ? null : Number(raw.sl),
    takeProfit: raw.tp === null ? null : Number(raw.tp),
    pnl: raw.pnl === null ? null : Number(raw.pnl),
  })));

  return (
    <div>
      <h1 style={{ fontSize: "1.3rem", marginBottom: ".2rem" }}>{displayName}</h1>
      <p className="label" style={{ marginBottom: "1.25rem" }}>{email} · Trader {person.id.slice(0, 8)} · Account {liveAccount?.label ?? "—"}</p>

      <div className="panel" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem", marginBottom: "1.25rem" }}>
        <div><div className="label">Country</div><div>{person.country_code ?? "—"}</div></div>
        <div><div className="label">KYC status</div><div>{person.kyc_status}</div></div>
        <div><div className="label">Risk region</div><div>{person.risk_region ?? "—"}</div></div>
      </div>

      {!liveAccountId && (
        <p className="label">No live trading account linked yet — this trader hasn't started a challenge.</p>
      )}

      {liveAccountId && (
        <>
          <div className="card-grid" style={{ marginBottom: "1.25rem" }}>
            <StatCard label="Balance" value={fmtMoney(liveAccount ? Number(liveAccount.balance) : null)} sub={liveAccount?.status} color="var(--focus)" />
            <StatCard label="Realized net P&L" value={fmtMoney(closedForMetrics.length ? totalNetPnl : null)} color={totalNetPnl >= 0 ? "var(--pos)" : "var(--neg)"} />
            <StatCard label="Win rate" value={fmtPct(wr.value)} sub={`${wins}W / ${losses}L`} color="var(--accent-teal)" />
            <StatCard label="Profit factor" value={fmtNum(pf.value)} sub={pf.status === "insufficient_evidence" ? pf.warnings.join(", ") : undefined} color="var(--accent-purple)" />
            <StatCard label="Expectancy / trade" value={fmtMoney(exp.value)} color="var(--accent-amber)" />
            <StatCard label="Payoff ratio" value={fmtNum(payoff.value)} sub={payoff.status === "insufficient_evidence" ? payoff.warnings.join(", ") : undefined} color="var(--accent-pink)" />
            <StatCard label="Sharpe (ann.)" value={fmtNum(sharpe.value)} sub={sharpe.status === "insufficient_evidence" ? "insufficient evidence" : undefined} color="var(--accent-purple)" />
            <StatCard label="Sortino (ann.)" value={fmtNum(sortino.value)} sub={sortino.status === "insufficient_evidence" ? "insufficient evidence" : undefined} color="var(--accent-teal)" />
            <StatCard label="Max drawdown" value={dd.value ? fmtPct(dd.value.maxDrawdownPct) : "—"} sub={dd.value ? `${dd.value.longestDurationDays.toFixed(1)}d longest` : undefined} color="var(--neg)" />
            <StatCard label="Best-day P&L share" value={fmtPct(bestDay.value)} sub={bestDay.status === "insufficient_evidence" ? "insufficient evidence" : undefined} color="var(--accent-amber)" />
            <StatCard label="Concentration (HHI)" value={fmtNum(hhi.value?.hhi ?? null)} sub={hhi.value ? `top1 ${fmtPct(hhi.value.top1Share)}` : undefined} color="var(--accent-pink)" />
            <StatCard label="Median hold time" value={holding.value ? `${holding.value.medianMinutes.toFixed(0)}m` : "—"} sub={holding.value ? `p90 ${holding.value.p90Minutes.toFixed(0)}m` : undefined} color="var(--focus)" />
          </div>

          <div className="panel" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "1.5rem", alignItems: "center", marginBottom: "1.25rem" }}>
            <div>
              <div className="label" style={{ marginBottom: ".5rem" }}>Realized equity curve</div>
              <EquityCurve points={equityPoints} />
            </div>
            <div style={{ textAlign: "center" }}>
              <div className="label" style={{ marginBottom: ".5rem" }}>Win / loss</div>
              <WinLossDonut wins={wins} losses={losses} />
            </div>
          </div>

          {(pf.status === "insufficient_evidence" && pf.warnings.includes("cost_unmodeled")) || closedForMetrics.some((t) => !t.costsKnown) ? (
            <p className="label" style={{ marginBottom: "1.25rem" }}>
              Commission/swap/slippage are not tracked separately on this platform — P&amp;L figures above are gross, not cost-adjusted.
            </p>
          ) : null}

          <h2 style={{ fontSize: ".95rem", margin: "0 0 .5rem" }}>Detected strategy profile</h2>
          <div className="panel" style={{ marginBottom: "1.25rem" }}>
            {strategyProfile.status === "insufficient_evidence" ? (
              <p className="label">At least 8 valid closed trades are required. {strategyProfile.sampleSize} available.</p>
            ) : (
              <>
                <div style={{ display: "flex", gap: ".75rem", alignItems: "baseline", flexWrap: "wrap", marginBottom: ".8rem" }}>
                  <strong style={{ textTransform: "capitalize" }}>{strategyProfile.primaryStyle.replaceAll("_", " ")}</strong>
                  <span className="label">{strategyProfile.sampleSize} trades · {Math.round(strategyProfile.coverage * 100)}% feature coverage · fingerprint v{strategyProfile.version}</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: ".45rem", marginBottom: "1rem" }}>
                  {strategyProfile.labels.length ? strategyProfile.labels.map((item) => (
                    <span key={item.label} title={item.summary} style={{ border: "1px solid var(--border)", borderRadius: "999px", padding: ".3rem .6rem", fontSize: ".72rem" }}>
                      {item.label.replaceAll("_", " ")} · {item.confidence}
                    </span>
                  )) : <span className="label">Mixed behaviour: no secondary pattern meets the evidence threshold.</span>}
                </div>
                {strategyProfile.labels.length ? (
                  <table>
                    <thead><tr><th>Observed pattern</th><th>Evidence</th><th>Confidence</th></tr></thead>
                    <tbody>{strategyProfile.labels.map((item) => (
                      <tr key={item.label}><td style={{ textTransform: "capitalize" }}>{item.label.replaceAll("_", " ")}</td><td>{item.summary}</td><td>{item.confidence}</td></tr>
                    ))}</tbody>
                  </table>
                ) : null}
                <details style={{ marginTop: ".8rem" }}>
                  <summary>Method limits</summary>
                  <ul>{strategyProfile.limitations.map((text) => <li key={text} className="label" style={{ marginTop: ".4rem" }}>{text}</li>)}</ul>
                </details>
              </>
            )}
          </div>

          <h2 style={{ fontSize: ".95rem", margin: "0 0 .5rem" }}>By instrument</h2>
          <div className="panel" style={{ marginBottom: "1.25rem" }}>
            {instrumentRows.length === 0 ? <p className="label">No closed trades yet.</p> : (
              <table>
                <thead><tr><th>Instrument</th><th>Trades</th><th>Win rate</th><th className="num">Net P&amp;L</th></tr></thead>
                <tbody>
                  {instrumentRows.map((r) => (
                    <tr key={r.symbol}>
                      <td>{r.symbol}</td>
                      <td>{r.count}</td>
                      <td>{fmtPct(r.winRate)}</td>
                      <td className={"num " + (r.pnl >= 0 ? "pos" : "neg")}>{fmtMoney(r.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <h2 style={{ fontSize: ".95rem", margin: "0 0 .5rem" }}>Open positions</h2>
          <div className="panel" style={{ marginBottom: "1.25rem" }}>
            {openTrades.length === 0 ? <p className="label">No open positions.</p> : (
              <table>
                <thead><tr><th>Position ID</th><th>Order ID</th><th>Instrument</th><th>Side</th><th>Volume</th><th>Open price</th><th>Opened</th></tr></thead>
                <tbody>
                  {openTrades.map((t) => (
                    <tr key={t.id}>
                      <td><code>{t.id.slice(0, 8)}</code></td>
                      <td><code>{orderIdByTrade[t.id]?.slice(0, 8) ?? "—"}</code></td>
                      <td>{t.symbol}</td>
                      <td>{t.side}</td>
                      <td>{t.volume}</td>
                      <td>{t.open_price}</td>
                      <td>{new Date(t.opened_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <h2 style={{ fontSize: ".95rem", margin: "0 0 .5rem" }}>Pending orders</h2>
          <div className="panel" style={{ marginBottom: "1.25rem" }}>
            {pendingOrders.length === 0 ? <p className="label">No pending orders.</p> : (
              <table>
                <thead><tr><th>Order ID</th><th>Instrument</th><th>Type</th><th>Side</th><th>Volume</th><th>Trigger</th><th>Created</th></tr></thead>
                <tbody>
                  {pendingOrders.map((o) => (
                    <tr key={o.id}>
                      <td><code>{o.id.slice(0, 8)}</code></td>
                      <td>{o.symbol}</td>
                      <td>{o.order_type}</td>
                      <td>{o.side}</td>
                      <td>{o.volume}</td>
                      <td>{o.trigger_price}</td>
                      <td>{new Date(o.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <h2 style={{ fontSize: ".95rem", margin: "0 0 .5rem" }}>Closed trade history</h2>
          <div className="panel" style={{ marginBottom: "1.25rem" }}>
            {closedTrades.length === 0 ? <p className="label">No closed trades yet.</p> : (
              <table>
                <thead><tr><th>Position ID</th><th>Order ID</th><th>Instrument</th><th>Side</th><th>Volume</th><th>Open</th><th>Close</th><th className="num">P&amp;L</th><th>Closed</th></tr></thead>
                <tbody>
                  {[...closedTrades].reverse().map((t) => (
                    <tr key={t.id}>
                      <td><code>{t.id.slice(0, 8)}</code></td>
                      <td><code>{orderIdByTrade[t.id]?.slice(0, 8) ?? "—"}</code></td>
                      <td>{t.symbol}</td>
                      <td>{t.side}</td>
                      <td>{t.volume}</td>
                      <td>{t.open_price}</td>
                      <td>{t.close_price ?? "—"}</td>
                      <td className={"num " + ((t.pnl ?? 0) >= 0 ? "pos" : "neg")}>{fmtMoney(t.pnl)}</td>
                      <td>{t.closed_at ? new Date(t.closed_at).toLocaleString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <h2 style={{ fontSize: ".95rem", margin: "0 0 .5rem" }}>Bot API keys</h2>
      <div className="panel">
        {!tokens || tokens.length === 0 ? (
          <p className="label">No bot API key issued yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Fingerprint</th><th>Scope</th><th>Issued</th><th>Status</th></tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const revoked = !!t.revoked_at;
                const expired = !!t.expires_at && new Date(t.expires_at) <= new Date();
                const status = revoked ? "Revoked" : expired ? "Expired" : "Active";
                return (
                  <tr key={t.id}>
                    <td><code>ipfx_bot_…{t.key_fingerprint}</code></td>
                    <td>{(t.scope_text ?? []).join(", ") || "—"}</td>
                    <td>{new Date(t.created_at).toLocaleDateString()}</td>
                    <td className={revoked || expired ? "neg" : "pos"}>{status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="label" style={{ marginTop: ".75rem" }}>
          The full key is never stored or shown here — only its fingerprint
          (last 6 characters) and a hash for verification. It was shown once,
          in full, on the trader's own dashboard at issuance.
        </p>
      </div>
    </div>
  );
}
