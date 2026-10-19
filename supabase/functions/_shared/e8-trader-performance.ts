// Owner-only cache reads. The caller must pass the Brain owner + MFA gate first.
type CacheDB = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }> };
const ACTIONS = new Set(["e8_trader_performance", "e8_trader_detail", "e8_trader_portfolio"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLASSES = new Set(["", "INSUFFICIENT_DATA", "COST_BLED", "COPY_CANDIDATE", "REVERSE_CANDIDATE", "UNSTABLE", "TAIL_RISK", "E8_INCOMPATIBLE", "STOPPED_TRADING"]);
const SORTS = new Set(["trader", "trades", "active_days", "a_net", "b_net", "gross_per_trade", "cost_per_trade", "p_copy", "p_reverse", "q_copy", "q_reverse", "evidence_class"]);

export async function e8TraderPerformanceRead(db: CacheDB, action: string, body: Record<string, unknown>) {
  if (!ACTIONS.has(action)) return null;
  const latency = Number(body.latency ?? 2), slippage = Number(body.slippage ?? 0);
  if (![1, 2, 5, 15].includes(latency) || ![0, 1, 2].includes(slippage)) return { status: 400, body: { ok: false, error: "Choose a saved latency and slippage scenario." } };
  let fn: string, args: Record<string, unknown>, key: string;
  if (action === "e8_trader_performance") {
    const page = Number(body.page ?? 0), limit = Number(body.limit ?? 100), min = Number(body.min_trades ?? 0);
    const query = String(body.query ?? "").trim(), cls = String(body.class_filter ?? ""), sort = String(body.sort ?? "a_net");
    const symbol = String(body.symbol ?? "").trim();
    if (!Number.isSafeInteger(page) || page < 0 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(min) || min < 0 || min > 1000000 || query.length > 120 || symbol.length > 30 || !CLASSES.has(cls) || !SORTS.has(sort) || !["asc", "desc"].includes(String(body.direction ?? "desc"))) {
      return { status: 400, body: { ok: false, error: "Invalid trader performance filter." } };
    }
    fn = "ab_e8_trader_perf_read"; key = "performance";
    args = { p_latency: latency, p_slippage: slippage, p_page: page, p_limit: limit, p_query: query,
      p_class: cls, p_symbol: symbol, p_min_trades: min, p_sort: sort, p_desc: String(body.direction ?? "desc") === "desc" };
  } else if (action === "e8_trader_detail") {
    const id = String(body.trader_id ?? "");
    if (!UUID.test(id)) return { status: 400, body: { ok: false, error: "Choose a trader." } };
    fn = "ab_e8_trader_perf_detail"; key = "detail";
    args = { p_trader_id: id, p_latency: latency, p_slippage: slippage };
  } else {
    const ids = body.trader_ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(ids).size !== ids.length || !["a", "b"].includes(String(body.book))) {
      return { status: 400, body: { ok: false, error: "Select 1–50 different traders and one book." } };
    }
    fn = "ab_e8_trader_perf_portfolio"; key = "portfolio";
    args = { p_trader_ids: ids, p_book: body.book, p_latency: latency, p_slippage: slippage };
  }
  const { data, error } = await db.rpc(fn, args);
  if (error) return { status: 503, body: { ok: false, error: "Saved trader analysis is unavailable. Try again shortly." } };
  const result = { ok: true, [key]: data ?? { available: false, reason: "The first saved calculation is still pending." } };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 1_500_000) return { status: 413, body: { ok: false, error: "This saved view is too large. Narrow the selection." } };
  return { status: 200, body: result };
}
