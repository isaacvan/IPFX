export default function NotAuthorized() {
  return (
    <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center" }}>
      <div className="panel" style={{ maxWidth: 420, textAlign: "center" }}>
        <h1 style={{ fontSize: "1.1rem" }}>Not authorized</h1>
        <p className="label" style={{ marginTop: ".5rem" }}>
          This account is not on the owner/admin allow-list, or hasn&apos;t
          completed multi-factor authentication. This page never appears due
          to a client-side check — it is reached only after a server-side
          session and admin-status check both ran and failed. Contact an
          existing owner to be added to <code>public.admins</code>.
        </p>
      </div>
    </main>
  );
}
