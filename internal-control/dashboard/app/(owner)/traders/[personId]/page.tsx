import { createSessionClient } from "@lib/supabase-server";

// report §10.2 "Trader profile" — this is a stub covering the identity
// panel only. The full profile (performance panel with CI, probability
// panel, trade-idea table, exposure/HHI, drawdown timeline, payout
// history, flags, audit log) needs the metric_run pipeline mentioned in
// traders/page.tsx to exist first; building the UI for data that can
// never be non-null yet would be exactly the "fabricate a number"
// failure mode the report spends its whole §6.10 warning against.
export default async function TraderProfilePage({ params }: { params: { personId: string } }) {
  const supabase = createSessionClient();
  const { data: person, error } = await supabase
    .from("person")
    .select("id, country_code, kyc_status, risk_region, created_at")
    .eq("id", params.personId)
    .maybeSingle();

  if (error) return <p className="neg">Could not load trader: {error.message}</p>;
  if (!person) return <p className="label">Trader not found (or RLS is correctly hiding it — this page uses the RLS-respecting session client, not the service-role client).</p>;

  return (
    <div>
      <h1 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Trader {person.id.slice(0, 8)}</h1>
      <div className="panel" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem" }}>
        <div><div className="label">Country</div><div>{person.country_code ?? "—"}</div></div>
        <div><div className="label">KYC status</div><div>{person.kyc_status}</div></div>
        <div><div className="label">Risk region</div><div>{person.risk_region ?? "—"}</div></div>
      </div>
      <p className="label" style={{ marginTop: "1rem" }}>
        Performance, probability, trade-idea, exposure, and audit panels
        are not built yet — see the comment at the top of this file.
      </p>
    </div>
  );
}
