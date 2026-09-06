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

  // api_token is owner-only under RLS (fn_is_admin()), so this session
  // client can read it for any trader. Only metadata is ever queried here
  // — token_hash_sha256 is selected nowhere in this file, and there is no
  // plaintext column on this table to accidentally expose (see
  // bot-api-token-rollout.sql: the plaintext exists only transiently in
  // api_token_pending_reveal, which only the trader's own RLS-scoped
  // session can read, never this owner-side query).
  const { data: tokens } = await supabase
    .from("api_token")
    .select("id, key_fingerprint, scope_text, created_at, revoked_at, expires_at")
    .eq("person_id", person.id)
    .order("created_at", { ascending: false });

  return (
    <div>
      <h1 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Trader {person.id.slice(0, 8)}</h1>
      <div className="panel" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem" }}>
        <div><div className="label">Country</div><div>{person.country_code ?? "—"}</div></div>
        <div><div className="label">KYC status</div><div>{person.kyc_status}</div></div>
        <div><div className="label">Risk region</div><div>{person.risk_region ?? "—"}</div></div>
      </div>
      <h2 style={{ fontSize: ".95rem", margin: "1.5rem 0 .5rem" }}>Bot API keys</h2>
      <div className="panel">
        {!tokens || tokens.length === 0 ? (
          <p className="label">No bot API key issued yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".85rem" }}>
            <thead>
              <tr className="label">
                <th style={{ textAlign: "left", padding: ".4rem 0" }}>Fingerprint</th>
                <th style={{ textAlign: "left" }}>Scope</th>
                <th style={{ textAlign: "left" }}>Issued</th>
                <th style={{ textAlign: "left" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const revoked = !!t.revoked_at;
                const expired = !!t.expires_at && new Date(t.expires_at) <= new Date();
                const status = revoked ? "Revoked" : expired ? "Expired" : "Active";
                return (
                  <tr key={t.id}>
                    <td style={{ padding: ".4rem 0" }}>
                      <code>ipfx_bot_…{t.key_fingerprint}</code>
                    </td>
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

      <p className="label" style={{ marginTop: "1rem" }}>
        Performance, probability, trade-idea, exposure, and audit panels
        are not built yet — see the comment at the top of this file.
      </p>
    </div>
  );
}
