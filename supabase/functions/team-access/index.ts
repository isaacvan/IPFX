import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://ipfxcapital.com",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json({ ok: false, team_access: false }, 401);

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authorization } } },
  );
  const { data: { user }, error: userError } = await client.auth.getUser();
  if (userError || !user) return json({ ok: false, team_access: false }, 401);

  const ownerEmail = String(Deno.env.get("IPFX_OWNER_EMAIL") || "paulade491@gmail.com").trim().toLowerCase();
  if (String(user.email || "").trim().toLowerCase() !== ownerEmail) {
    return json({ ok: true, team_access: false });
  }

  // public.admins has a read-self RLS policy, so this query cannot inspect
  // anybody else's membership and does not require the service-role secret.
  const { data: admin, error: adminError } = await client.from("admins")
    .select("user_id").eq("user_id", user.id).maybeSingle();
  if (adminError) return json({ ok: false, team_access: false }, 503);
  return json({ ok: true, team_access: !!admin });
});
