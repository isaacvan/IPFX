// ============================================================
// IPFX Capital — server-only Supabase clients
//
// Two distinct clients, never confused:
//   - createSessionClient(): anon key + the caller's own cookies, used
//     to find out WHO is asking (auth.getUser(), MFA AAL level).
//   - createServiceClient(): service-role key, used ONLY to check
//     admin status and read owner-only tables server-side. This file
//     has no "use client" directive and imports nothing from a
//     NEXT_PUBLIC_* env var for the service key, so Next.js can never
//     bundle the service-role key into client JS — that boundary is
//     enforced by the framework's server/client module graph, not by
//     convention alone.
//
// report §10.1: "Supabase RLS as an additional layer, never as the
// only layer... Service-role secrets only in trusted server
// functions." requireOwner() below is that server-side layer.
//
// NOT EXECUTED IN THIS ENVIRONMENT — authored without Node.js/Next.js
// available to actually run `next dev` and catch integration issues.
// The @supabase/ssr cookie-adapter shape here matches its current
// documented API as of authoring; verify against installed package
// version once `npm install` actually runs.
// ============================================================

import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing_env: ${name} is not set — see internal-control/dashboard/.env.example`);
  return v;
}

/** Session-bound client: knows who's asking, respects RLS. */
export function createSessionClient() {
  const cookieStore = cookies();
  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component with no response to attach
            // to — safe to ignore as long as middleware.ts is also
            // refreshing the session (it is, see middleware.ts).
          }
        },
      },
    }
  );
}

/** Service-role client — server-only, bypasses RLS. Use narrowly:
 * admin-status checks and owner-only reads, never anything a trader's
 * own request should be able to trigger unfiltered. */
export function createServiceClient() {
  return createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface OwnerContext {
  userId: string;
  email: string | null;
}

/**
 * The single server-side authorization gate every owner route/layout
 * must call. Report requirements enforced here:
 *   - server-side session validation (not client-side route hiding)
 *   - MFA (AAL2) required for owner/admin
 *   - admin status checked via service-role (not trusting RLS alone)
 * Redirects rather than throws so a page composing this into a layout
 * gets clean navigation behavior for free.
 */
export async function requireOwner(): Promise<OwnerContext> {
  const session = createSessionClient();
  const { data: { user }, error } = await session.auth.getUser();
  if (error || !user) redirect("/login");

  const { data: aal } = await session.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== "aal2") {
    // Report §10.1/§16.3: MFA required for owner/admin. Sends them to
    // the MFA challenge rather than silently letting an aal1 session
    // (password-only) through.
    redirect("/login?mfa_required=1");
  }

  const service = createServiceClient();
  const { data: adminRow } = await service.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!adminRow) {
    // Fail closed: no admin row, no access, regardless of what the
    // session looks like otherwise.
    redirect("/not-authorized");
  }

  return { userId: user.id, email: user.email ?? null };
}
