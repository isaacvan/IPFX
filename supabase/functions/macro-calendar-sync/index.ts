import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const countryCurrency: Record<string, string> = {
  "United States": "USD", "United Kingdom": "GBP", "Euro Area": "EUR",
  Japan: "JPY", Switzerland: "CHF", Canada: "CAD", Australia: "AUD",
  "New Zealand": "NZD", China: "CNY",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const expected = Deno.env.get("INTERNAL_CRON_SECRET");
  if (!expected || req.headers.get("x-internal-secret") !== expected) return new Response("unauthorized", { status: 401 });
  const apiKey = Deno.env.get("TRADING_ECONOMICS_API_KEY");
  if (!apiKey) return new Response(JSON.stringify({ ok: false, error: "TRADING_ECONOMICS_API_KEY is not configured" }), { status: 503 });

  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://api.tradingeconomics.com/calendar/country/all/${from}/${to}?c=${encodeURIComponent(apiKey)}&importance=1,2,3&f=json`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return new Response(JSON.stringify({ ok: false, error: `calendar provider HTTP ${response.status}` }), { status: 502 });
  const raw = await response.json();
  if (!Array.isArray(raw)) return new Response(JSON.stringify({ ok: false, error: "invalid calendar response" }), { status: 502 });

  const rows = raw.filter((event) => event?.CalendarId && event?.Date && event?.Event).map((event) => ({
    provider: "trading_economics",
    provider_event_id: String(event.CalendarId),
    event_at: new Date(event.Date).toISOString(),
    country: event.Country || null,
    currency: event.Currency || countryCurrency[String(event.Country)] || null,
    category: event.Category || null,
    event_name: String(event.Event),
    importance: Math.max(1, Math.min(3, Number(event.Importance) || 1)),
    source_url: event.SourceURL || null,
    raw: event,
    synced_at: new Date().toISOString(),
  }));
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await db.from("macro_calendar_events").upsert(rows, { onConflict: "provider,provider_event_id" });
  if (error) return new Response(JSON.stringify({ ok: false, error: "calendar storage failed" }), { status: 500 });
  return new Response(JSON.stringify({ ok: true, synced: rows.length, from, to }), { headers: { "Content-Type": "application/json" } });
});
