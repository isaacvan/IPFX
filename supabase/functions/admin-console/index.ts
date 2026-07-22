// ============================================================
// IPFX Capital — admin-console Edge Function
//
// Powers the admin/verification page. Every action requires the
// caller to be listed in public.admins (fail-closed). Uses the
// service role internally so the browser never holds it.
//
// Actions (POST JSON):
//   { action:"overview" }
//       -> { is_admin, traders:[...] } for every trader/account
//   { action:"set_mirror", user_id, enabled, metaapi_account_id?, region?, volume_multiplier? }
//       -> enable/disable live mirroring for one trader
//   { action:"payout_create", account_id }
//       -> snapshot current owed into a pending payout
//   { action:"payout_mark_paid", payout_id }
//   { action:"set_split", user_id, profit_split_pct }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => json({ ok: false, error: m }, s);

// deno-lint-ignore no-explicit-any
type Db = any;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return err("POST only", 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return err("bad json"); }

  // authenticate
  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return err("Not signed in", 401);

  const db: Db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // admin gate (fail-closed)
  const { data: adminRow } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  const isAdmin = !!adminRow;
  if (!isAdmin) return json({ ok: true, is_admin: false, traders: [] });

  const action = body.action;

  if (action === "overview") {
    const [{ data: accounts }, { data: profiles }, { data: targets }, { data: summary }, { data: payouts }] =
      await Promise.all([
        db.from("trading_accounts").select("*").order("created_at", { ascending: false }),
        db.from("user_profiles").select("user_id,full_name,referral_code"),
        db.from("mirror_targets").select("*"),
        db.from("trader_payout_summary").select("*"),
        db.from("payouts").select("*").order("created_at", { ascending: false }),
      ]);

    // emails via admin API (one page covers a small firm)
    const emailById = new Map<string, string>();
    try {
      const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      for (const u of list?.users ?? []) emailById.set(u.id, u.email ?? "");
    } catch (_) { /* emails optional */ }

    const nameById = new Map<string, string>();
    for (const p of profiles ?? []) nameById.set(p.user_id, p.full_name ?? "");
    const targetByUser = new Map<string, Record<string, unknown>>();
    for (const t of targets ?? []) targetByUser.set(t.user_id, t);
    const sumByAcct = new Map<string, Record<string, unknown>>();
    for (const s of summary ?? []) sumByAcct.set(s.account_id, s);

    const traders = (accounts ?? []).map((a: Record<string, unknown>) => {
      const s = sumByAcct.get(a.id as string);
      const tg = targetByUser.get(a.user_id as string);
      const start = Number(a.starting_balance);
      const bal = Number(a.balance);
      return {
        user_id: a.user_id,
        account_id: a.id,
        full_name: nameById.get(a.user_id as string) || "—",
        email: emailById.get(a.user_id as string) || "",
        status: a.status,
        starting_balance: start,
        balance: bal,
        realized_pnl: Math.round((bal - start) * 100) / 100,
        profit_split_pct: Number(a.profit_split_pct ?? 80),
        realized_profit_unpaid: s ? Number(s.realized_profit_unpaid) : 0,
        trader_share_owed: s ? Number(s.trader_share_owed) : 0,
        mirror_enabled: !!a.mirror_enabled,
        mirror_target: tg ? { metaapi_account_id: tg.metaapi_account_id, region: tg.region, enabled: tg.enabled, volume_multiplier: tg.volume_multiplier } : null,
      };
    });

    return json({ ok: true, is_admin: true, traders, payouts: payouts ?? [] });
  }

  if (action === "set_mirror") {
    const target_user = String(body.user_id ?? "");
    if (!target_user) return err("user_id required");
    const enabled = body.enabled === true;

    if (enabled) {
      const acctId = body.metaapi_account_id ? String(body.metaapi_account_id).trim() : "";
      if (!acctId) return err("metaapi_account_id required to enable");
      const region = body.region ? String(body.region) : "new-york";
      const mult = Number(body.volume_multiplier ?? 1) || 1;

      // one target per user: update if present, else insert
      const { data: existing } = await db.from("mirror_targets").select("id").eq("user_id", target_user).maybeSingle();
      if (existing) {
        await db.from("mirror_targets").update({
          metaapi_account_id: acctId, region, volume_multiplier: mult, enabled: true, updated_at: new Date().toISOString(),
        }).eq("id", existing.id);
      } else {
        await db.from("mirror_targets").insert({
          user_id: target_user, metaapi_account_id: acctId, region, volume_multiplier: mult, enabled: true,
        });
      }
    } else {
      await db.from("mirror_targets").update({ enabled: false, updated_at: new Date().toISOString() }).eq("user_id", target_user);
    }

    // the engine reads trading_accounts.mirror_enabled on the active account
    await db.from("trading_accounts").update({ mirror_enabled: enabled }).eq("user_id", target_user).eq("status", "active");
    return json({ ok: true });
  }

  if (action === "set_split") {
    const target_user = String(body.user_id ?? "");
    const pct = Number(body.profit_split_pct);
    if (!target_user || !isFinite(pct) || pct < 0 || pct > 100) return err("bad split");
    await db.from("trading_accounts").update({ profit_split_pct: pct }).eq("user_id", target_user).eq("status", "active");
    return json({ ok: true });
  }

  if (action === "payout_create") {
    const account_id = String(body.account_id ?? "");
    if (!account_id) return err("account_id required");
    const { data: s } = await db.from("trader_payout_summary").select("*").eq("account_id", account_id).maybeSingle();
    if (!s) return err("nothing to pay out", 404);
    const gross = Number(s.realized_profit_unpaid);
    const split = Number(s.profit_split_pct);
    const share = Math.round(Math.max(gross, 0) * split / 100 * 100) / 100;
    const { error } = await db.from("payouts").insert({
      user_id: s.user_id, account_id, period_end: new Date().toISOString(),
      gross_profit: Math.round(gross * 100) / 100, split_pct: split, trader_share: share, status: "pending",
    });
    if (error) return err("could not create payout", 500);
    return json({ ok: true, trader_share: share });
  }

  if (action === "payout_mark_paid") {
    const payout_id = String(body.payout_id ?? "");
    if (!payout_id) return err("payout_id required");
    await db.from("payouts").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", payout_id);
    return json({ ok: true });
  }

  return err("unknown action");
});
