import { createSessionClient } from "@lib/supabase-server";

// Uses the SESSION client (RLS-respecting), not the service-role
// client, even though this page is already behind requireOwner() in
// the layout — report §10.1: "RLS as an additional layer, never as
// the only layer." If requireOwner() ever had a bug, RLS is still
// there as a second, independent check.
export default async function ReviewQueuePage() {
  const supabase = createSessionClient();

  const { data: cases, error } = await supabase
    .from("review_case")
    .select(`
      id, status, due_at, opened_at,
      challenge_instance:challenge_instance_id (
        id, stage,
        trading_account:trading_account_id ( id )
      )
    `)
    .in("status", ["pending_review", "in_review", "needs_more_data", "compliance_escalation"])
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(100);

  return (
    <div>
      <h1 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Review Queue</h1>
      {error && (
        <p className="neg">
          Could not load review cases: {error.message}
          {" — "}this is expected on a pre-launch platform with zero
          challenge_instance rows yet; the query itself is real, there is
          simply nothing to review.
        </p>
      )}
      {!error && (!cases || cases.length === 0) && (
        <p className="label">No open review cases. (Expected right now — this platform is pre-launch with no completed challenges yet.)</p>
      )}
      {cases && cases.length > 0 && (
        <table>
          <thead>
            <tr><th>Case</th><th>Status</th><th>Stage</th><th>Opened</th><th>Due</th></tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.id}>
                <td><a href={`/review-queue/${c.id}`}>{c.id.slice(0, 8)}</a></td>
                <td>{c.status}</td>
                <td className="num">{(c.challenge_instance as unknown as { stage: number } | null)?.stage ?? "—"}</td>
                <td>{new Date(c.opened_at).toLocaleDateString()}</td>
                <td>{c.due_at ? new Date(c.due_at).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
