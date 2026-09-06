import { requireOwner } from "@lib/supabase-server";

// Every route under this group runs requireOwner() before rendering
// anything — that's the server-side authorization the report requires
// (§10.1: "Server-side authorization for every route and API... Client-
// side hiding never counts as authorization"). A page here that forgets
// to call it is still protected, because the layout calls it first.
export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const owner = await requireOwner();

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav className="panel" style={{ width: 200, flexShrink: 0, borderRadius: 0, borderTop: "none", borderLeft: "none", borderBottom: "none" }}>
        <div className="label" style={{ marginBottom: "1rem" }}>{owner.email}</div>
        <a href="/review-queue" style={{ display: "block", padding: ".4rem 0", color: "var(--text)", textDecoration: "none" }}>Review Queue</a>
        <a href="/traders" style={{ display: "block", padding: ".4rem 0", color: "var(--text)", textDecoration: "none" }}>Traders</a>
      </nav>
      <main style={{ flex: 1, padding: "1.5rem" }}>{children}</main>
    </div>
  );
}
