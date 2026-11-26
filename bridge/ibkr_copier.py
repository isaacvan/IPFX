"""IPFX copier v2: IBKR bridge (26 Nov 2026).

Runs next to IB Gateway (same machine), keeps ONE IBKR connection open and ONE WebSocket to the IPFX hub
(wss://hub.ipfxcapital.com/copier). The hub decides what to copy; this process only executes and reports, with a
timestamp at every step.

  entry    limit order at the trader's fill +- tolerance; whatever is not filled after timeout_ms is cancelled
           (missing a trade is cheaper than chasing it). Never a market order for an entry.
  rest     a trader's pending order copied as a resting LMT/STP at the broker the moment it is placed.
  protect  stop loss (STP) and take profit (LMT) rest at the broker as one OCA pair (one cancels the other),
           so exits never depend on this process being fast.
  exit     the trader closed: cancel the OCA pair and close with a marketable limit, widened until filled.
  cancel   cancel a resting copy (the trader cancelled, or high-impact news is about to be released).

PAPER ONLY: refuses to start unless every managed account is an IBKR paper account (DU... / DF...).

Environment: HUB_COPIER_URL, COPIER_SECRET (32+ chars, same as the hub's), IB_HOST (127.0.0.1), IB_PORT (4002 =
IB Gateway paper), IB_CLIENT_ID (77), MAX_UNITS_<SYMBOL> optional per-symbol size guard.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import sys
import time

try:
    from ib_insync import IB, Contract, LimitOrder, MarketOrder, StopOrder, util
except ImportError:  # maintained fork
    from ib_async import IB, Contract, LimitOrder, MarketOrder, StopOrder, util  # type: ignore
import websockets

now_ms = lambda: int(time.time() * 1000)
VERSION = "copier-bridge/1"


# ---------- pure helpers (tested in tests/bridge_helpers_test.py) ----------
def round_to_tick(price: float, tick: float, side: str, kind: str) -> float:
    """Round a price to the contract's tick. side is the COPY's side (buy = long copy), kind is 'entry' or 'exit'.
    A long copy rounds down: its entry (a BUY limit) never loosens the tolerance, and its exits (SELL orders)
    become slightly more likely to fill. A short copy rounds up for the same two reasons."""
    if not tick or tick <= 0:
        return price
    steps = price / tick
    steps = math.floor(steps + 1e-9) if side == "buy" else math.ceil(steps - 1e-9)
    return round(steps * tick, 10)


def round_units(units: float, increment: float, minimum: float) -> float:
    """Whole multiples of the contract's size increment, never above what was asked; 0 if under the minimum."""
    inc = increment if increment and increment > 0 else 1
    q = math.floor(units / inc + 1e-9) * inc
    q = round(q, 8)
    return q if q >= (minimum or inc) else 0


def make_contract(s: dict) -> Contract:
    return Contract(symbol=s["broker_symbol"], secType=s["sec_type"], exchange=s["exchange"], currency=s["currency"])


class Copy:
    def __init__(self, cid, sym, side):
        self.id, self.sym, self.side = cid, sym, side
        self.filled = 0.0
        self.avg = None
        self.entry = None      # Trade (ib_insync)
        self.sl = None
        self.tp = None
        self.lat = {}
        self.closing = False


class Bridge:
    def __init__(self):
        self.ib = IB()
        self.ws = None
        self.symbols = {}      # IPFX symbol -> {contract, tick, inc, min, pip}
        self.copies = {}       # id -> Copy
        self.last_quote = {}   # symbol -> ms (throttle)
        self.orders_minute = []
        self.account = None

    # ---------- IBKR ----------
    async def connect_ib(self):
        host, port = os.environ.get("IB_HOST", "127.0.0.1"), int(os.environ.get("IB_PORT", "4002"))
        await self.ib.connectAsync(host, port, clientId=int(os.environ.get("IB_CLIENT_ID", "77")), timeout=15)
        accounts = self.ib.managedAccounts()
        if not accounts or not all(a.upper().startswith(("DU", "DF")) for a in accounts):
            print("REFUSED: not an IBKR paper account", accounts, file=sys.stderr)
            self.ib.disconnect()
            sys.exit(2)
        self.account = accounts[0]
        self.ib.execDetailsEvent += self.on_exec
        self.ib.orderStatusEvent += self.on_status
        self.ib.pendingTickersEvent += self.on_tickers
        self.rebuild()

    def rebuild(self):
        """After a restart, find our own orders again by their orderRef (ipfx:<id>:<role>)."""
        for tr in self.ib.openTrades():
            ref = tr.order.orderRef or ""
            if not ref.startswith("ipfx:"):
                continue
            _, cid, role = (ref.split(":") + ["", ""])[:3]
            c = self.copies.setdefault(cid, Copy(cid, None, "buy" if tr.order.action == "BUY" else "sell"))
            setattr(c, {"entry": "entry", "rest": "entry", "sl": "sl", "tp": "tp"}.get(role, "entry"), tr)

    def rate_ok(self) -> bool:
        t = time.time()
        self.orders_minute = [x for x in self.orders_minute if t - x < 60]
        if len(self.orders_minute) >= 60:
            return False
        self.orders_minute.append(t)
        return True

    def guard_units(self, symbol: str, units: float) -> float:
        cap = os.environ.get("MAX_UNITS_" + symbol)
        return min(units, float(cap)) if cap else units

    async def configure(self, symbols):
        ok, missing = [], []
        for s in symbols:
            c = make_contract(s)
            try:
                q = await self.ib.qualifyContractsAsync(c)
                if not q:
                    raise ValueError("not found")
                det = await self.ib.reqContractDetailsAsync(q[0])
                d = det[0] if det else None
                self.symbols[s["symbol"]] = {"contract": q[0], "pip": float(s["pip"]),
                                             "tick": float(getattr(d, "minTick", 0) or 0),
                                             "inc": float(getattr(d, "sizeIncrement", 0) or 0) or 1,
                                             "min": float(getattr(d, "minSize", 0) or 0)}
                self.ib.reqMktData(q[0], "", False, False)
                ok.append(s["symbol"])
            except Exception as e:  # unsupported for this account (e.g. CFDs need permissions)
                missing.append(s["symbol"])
                print("contract missing", s["symbol"], e, file=sys.stderr)
        await self.send({"t": "contracts", "ok": ok, "missing": missing})

    # ---------- hub messages ----------
    async def handle(self, m: dict):
        rx = now_ms()
        t, cid = m.get("t"), str(m.get("id", ""))
        if t == "config":
            return await self.configure(m.get("symbols", []))
        if t == "entry":
            return await self.entry(m, rx)
        if t == "rest":
            return await self.rest(m, rx)
        if t == "protect":
            return self.protect(cid, m.get("sl"), m.get("tp"))
        if t == "cancel":
            c = self.copies.get(cid)
            if c and c.entry and not c.entry.isDone():
                self.ib.cancelOrder(c.entry.order)
            return
        if t == "exit":
            return await self.exit(cid, float(m.get("fraction") or 1), float(m.get("tolerance_pips") or 1), m.get("reason"))

    def order_ref(self, cid, role):
        return f"ipfx:{cid}:{role}"

    async def entry(self, m, rx):
        sym = self.symbols.get(m["symbol"])
        cid, side = str(m["id"]), m["side"]
        if not sym or not self.rate_ok():
            return await self.send({"t": "entry_missed", "id": cid, "reason": "unsupported" if not sym else "rate_limit", "bridge_rx": rx})
        units = round_units(self.guard_units(m["symbol"], float(m["units"])), sym["inc"], sym["min"])
        if units <= 0:
            return await self.send({"t": "entry_missed", "id": cid, "reason": "below_min_size", "bridge_rx": rx})
        px = round_to_tick(float(m["limit"]), sym["tick"], side, "entry")
        order = LimitOrder("BUY" if side == "buy" else "SELL", units, px, tif="DAY", orderRef=self.order_ref(cid, "entry"))
        c = self.copies[cid] = Copy(cid, m["symbol"], side)
        c.lat = {"bridge_rx": rx, "submit_ts": now_ms()}
        c.entry = self.ib.placeOrder(sym["contract"], order)
        deadline = time.time() + float(m.get("timeout_ms", 1500)) / 1000
        while time.time() < deadline and not c.entry.isDone():
            await asyncio.sleep(0.02)
        if not c.entry.isDone():
            self.ib.cancelOrder(c.entry.order)      # the rest is not chased
            await asyncio.sleep(0.2)
        filled = float(c.entry.orderStatus.filled or 0)
        if filled <= 0:
            self.copies.pop(cid, None)
            return await self.send({"t": "entry_missed", "id": cid, "reason": "not_filled_in_time", **c.lat})
        c.filled, c.avg = filled, float(c.entry.orderStatus.avgFillPrice)
        await self.send({"t": "entry_filled", "id": cid, "px": c.avg, "qty": filled, **c.lat})
        self.protect(cid, m.get("sl"), m.get("tp"))

    async def rest(self, m, rx):
        sym = self.symbols.get(m["symbol"])
        if not sym or not self.rate_ok():
            return
        cid, side = str(m["id"]), m["side"]
        units = round_units(self.guard_units(m["symbol"], float(m["units"])), sym["inc"], sym["min"])
        if units <= 0:
            return
        px = round_to_tick(float(m["price"]), sym["tick"], side, "entry")
        action = "BUY" if side == "buy" else "SELL"
        order = (LimitOrder(action, units, px, tif="GTC", orderRef=self.order_ref(cid, "rest")) if m["order"] == "limit"
                 else StopOrder(action, units, px, tif="GTC", orderRef=self.order_ref(cid, "rest")))
        c = self.copies[cid] = Copy(cid, m["symbol"], side)
        c.lat = {"bridge_rx": rx, "submit_ts": now_ms()}
        c.entry = self.ib.placeOrder(sym["contract"], order)
        c.pending_protect = (m.get("sl"), m.get("tp"))

    def protect(self, cid, sl, tp):
        c = self.copies.get(cid)
        if not c or c.filled <= 0 or c.closing:
            return
        sym = self.symbols.get(c.sym)
        if not sym:
            return
        exit_action = "SELL" if c.side == "buy" else "BUY"
        group = f"ipfx-oca-{cid}-{now_ms()}"
        for attr in ("sl", "tp"):
            tr = getattr(c, attr)
            if tr and not tr.isDone():
                self.ib.cancelOrder(tr.order)
            setattr(c, attr, None)
        if sl:
            o = StopOrder(exit_action, c.filled, round_to_tick(float(sl), sym["tick"], c.side, "exit"), tif="GTC",
                          orderRef=self.order_ref(cid, "sl"), ocaGroup=group, ocaType=1)
            c.sl = self.ib.placeOrder(sym["contract"], o)
        if tp:
            o = LimitOrder(exit_action, c.filled, round_to_tick(float(tp), sym["tick"], c.side, "exit"), tif="GTC",
                           orderRef=self.order_ref(cid, "tp"), ocaGroup=group, ocaType=1)
            c.tp = self.ib.placeOrder(sym["contract"], o)

    async def exit(self, cid, fraction, tol_pips, reason):
        c = self.copies.get(cid)
        if not c:
            return
        if c.entry and not c.entry.isDone():
            self.ib.cancelOrder(c.entry.order)
            await asyncio.sleep(0.2)
            c.filled = float(c.entry.orderStatus.filled or 0)
        if c.filled <= 0:
            self.copies.pop(cid, None)
            return
        sym = self.symbols[c.sym]
        qty = round_units(c.filled * fraction, sym["inc"], sym["min"]) if fraction < 1 else c.filled
        if qty <= 0:
            return
        c.closing = fraction >= 1
        if c.closing:
            for attr in ("sl", "tp"):
                tr = getattr(c, attr)
                if tr and not tr.isDone():
                    self.ib.cancelOrder(tr.order)
        action = "SELL" if c.side == "buy" else "BUY"
        t0, got, cost = now_ms(), 0.0, 0.0
        widen = tol_pips * sym["pip"]
        for attempt in range(6):
            tk = self.ib.ticker(sym["contract"])
            ref = (tk.bid if action == "SELL" else tk.ask) if tk else None
            if attempt == 5 or not ref or ref != ref:  # last resort, or no price: an exit must happen
                order = MarketOrder(action, qty - got, orderRef=self.order_ref(cid, "exit"))
            else:
                px = ref - widen if action == "SELL" else ref + widen
                order = LimitOrder(action, qty - got, round_to_tick(px, sym["tick"], c.side, "exit"), tif="DAY",
                                   orderRef=self.order_ref(cid, "exit"))
            tr = self.ib.placeOrder(sym["contract"], order)
            end = time.time() + 1.0
            while time.time() < end and not tr.isDone():
                await asyncio.sleep(0.02)
            if not tr.isDone():
                self.ib.cancelOrder(order)
                await asyncio.sleep(0.2)
            f = float(tr.orderStatus.filled or 0)
            if f > 0:
                cost += f * float(tr.orderStatus.avgFillPrice)
                got += f
            if got >= qty - 1e-9:
                break
            widen *= 2
        if got > 0:
            c.filled -= got
            if c.filled <= 1e-9:
                self.copies.pop(cid, None)
            elif not c.closing:
                self.protect(cid, c.sl.order.auxPrice if c.sl else None, c.tp.order.lmtPrice if c.tp else None)
            await self.send({"t": "exit_filled", "id": cid, "px": cost / got, "qty": got, "fraction": fraction,
                             "reason": reason, "submit_ts": t0, "fill_ts": now_ms()})

    # ---------- IBKR events ----------
    def on_status(self, trade):
        ref = trade.order.orderRef or ""
        if not ref.startswith("ipfx:"):
            return
        _, cid, role = (ref.split(":") + ["", ""])[:3]
        c = self.copies.get(cid)
        if c and "ack_ts" not in c.lat and trade.orderStatus.status in ("PreSubmitted", "Submitted", "Filled"):
            c.lat["ack_ts"] = now_ms()

    def on_exec(self, trade, fill):
        ref = trade.order.orderRef or ""
        if not ref.startswith("ipfx:"):
            return
        _, cid, role = (ref.split(":") + ["", ""])[:3]
        c = self.copies.get(cid)
        if not c:
            return
        if "fill_ts" not in c.lat:
            c.lat["fill_ts"] = now_ms()
        if role == "rest" and trade.isDone() and float(trade.orderStatus.filled or 0) > 0:
            c.filled, c.avg = float(trade.orderStatus.filled), float(trade.orderStatus.avgFillPrice)
            asyncio.ensure_future(self.send({"t": "rest_filled", "id": cid, "px": c.avg, "qty": c.filled, **c.lat}))
            sl, tp = getattr(c, "pending_protect", (None, None))
            self.protect(cid, sl, tp)
        elif role in ("sl", "tp") and trade.isDone():
            px = float(trade.orderStatus.avgFillPrice)
            self.copies.pop(cid, None)
            asyncio.ensure_future(self.send({"t": "exit_filled", "id": cid, "px": px, "qty": float(trade.orderStatus.filled),
                                             "fraction": 1, "reason": role, "fill_ts": now_ms()}))

    def on_tickers(self, tickers):
        t = now_ms()
        for tk in tickers:
            for name, s in self.symbols.items():
                if s["contract"].conId == tk.contract.conId:
                    if t - self.last_quote.get(name, 0) < 250 or not tk.bid or not tk.ask or tk.bid != tk.bid:
                        break
                    self.last_quote[name] = t
                    asyncio.ensure_future(self.send({"t": "q", "s": name, "b": tk.bid, "a": tk.ask, "ts": t}))
                    break

    # ---------- hub link ----------
    async def send(self, msg):
        if self.ws is not None:
            try:
                await self.ws.send(json.dumps(msg))
            except Exception:
                pass

    async def run(self):
        await self.connect_ib()
        url, secret = os.environ["HUB_COPIER_URL"], os.environ["COPIER_SECRET"]
        while True:
            try:
                async with websockets.connect(url, ping_interval=10, max_size=1 << 20) as ws:
                    self.ws = ws
                    await ws.send(json.dumps({"t": "hello", "secret": secret, "account": self.account, "paper": True, "version": VERSION}))
                    print("connected to hub", flush=True)
                    async for raw in ws:
                        try:
                            m = json.loads(raw)
                        except ValueError:
                            continue
                        asyncio.ensure_future(self.handle(m))
            except Exception as e:
                print("hub link down:", e, file=sys.stderr, flush=True)
            self.ws = None
            await asyncio.sleep(2)


if __name__ == "__main__":
    util.patchAsyncio() if hasattr(util, "patchAsyncio") else None
    asyncio.run(Bridge().run())
