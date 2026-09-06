"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@lib/supabase-browser";

// report §10.1/§16.3: MFA required for owner/admin. This is a two-step
// flow: password sign-in (gets to AAL1), then a TOTP challenge against
// an already-enrolled factor (gets to AAL2). Enrollment itself (first-
// time factor setup) is intentionally NOT built here — that is a
// one-time admin-onboarding action better done carefully by hand
// against Supabase's own Auth UI than rushed into this pass.
type Stage = "password" | "mfa" | "error";

export default function LoginForm() {
  const [stage, setStage] = useState<Stage>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createBrowserSupabase();

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) { setError(signInError.message); return; }

    const { data: factors } = await supabase.auth.mfa.listFactors();
    const totp = factors?.totp?.[0];
    if (!totp) {
      setError("No MFA factor enrolled on this account. An existing owner must help you enroll one before you can access the dashboard — see report §16.3, MFA is required, not optional, for owner/admin access.");
      return;
    }
    setFactorId(totp.id);
    setStage("mfa");
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!factorId) return;
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
    if (challengeError) { setError(challengeError.message); return; }
    const { error: verifyError } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
    if (verifyError) { setError(verifyError.message); return; }
    router.push("/review-queue");
    router.refresh();
  }

  return (
    <main style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center" }}>
      <div className="panel" style={{ width: 340 }}>
        <h1 style={{ fontSize: "1rem", marginBottom: "1rem" }}>IPFX Capital — Owner Sign In</h1>
        {stage === "password" && (
          <form onSubmit={handlePasswordSubmit} style={{ display: "flex", flexDirection: "column", gap: ".6rem" }}>
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required
              style={{ padding: ".5rem", background: "var(--bg)", border: "1px solid var(--line)", color: "var(--text)", borderRadius: 6 }} />
            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required
              style={{ padding: ".5rem", background: "var(--bg)", border: "1px solid var(--line)", color: "var(--text)", borderRadius: 6 }} />
            <button type="submit" style={{ padding: ".5rem", background: "var(--focus)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}>Continue</button>
          </form>
        )}
        {stage === "mfa" && (
          <form onSubmit={handleMfaSubmit} style={{ display: "flex", flexDirection: "column", gap: ".6rem" }}>
            <p className="label">Enter the 6-digit code from your authenticator app.</p>
            <input type="text" inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} required
              style={{ padding: ".5rem", background: "var(--bg)", border: "1px solid var(--line)", color: "var(--text)", borderRadius: 6 }} />
            <button type="submit" style={{ padding: ".5rem", background: "var(--focus)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}>Verify</button>
          </form>
        )}
        {error && <p className="neg" style={{ marginTop: ".75rem", fontSize: ".8rem" }}>{error}</p>}
      </div>
    </main>
  );
}
