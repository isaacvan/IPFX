"""Prepare a masked local test input from the existing frozen research archive.

No network, database, broker or financial-record writes. Output is private test
data: do not commit it, even though identities are replaced with UUID5 aliases.
Usage: python scripts/e8-trader-perf-export-frozen.py ARCHIVE.zip OUTPUT.json
"""
import collections
import gzip
import hashlib
import json
import sys
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

archive, destination = map(Path, sys.argv[1:3])
base = "infinity-v3/research/infinity-v3/"
with zipfile.ZipFile(archive) as z:
    core = json.loads(gzip.decompress(z.read(base + "data/core.json.gz")))["rows"][0]["snapshot"]
    benchmark = json.loads(gzip.decompress(z.read(base + "data/books_benchmark.json.gz")))["rows"][0]
    baseline = json.loads(z.read(base + "baseline.json"))
source = {t["id"]: t for t in core["trades"]}
ledger = {t["trade_id"]: t for t in core["ledger"]}
aliases = {}
trades = []
def seconds(a, b):
    return (datetime.fromisoformat(a) - datetime.fromisoformat(b)).total_seconds()
for b in benchmark["benchmark"]:
    t = source[b["trade_id"]]
    l = ledger.get(t["id"], {})
    person = l.get("person_id", t["user_id"])
    alias = str(uuid.uuid5(uuid.NAMESPACE_URL, "ipfx-masked-trader/" + person))
    aliases.setdefault(alias, f"trader-{len(aliases)+1:03}@example.invalid")
    row = dict(trade_id=str(uuid.uuid5(uuid.NAMESPACE_URL, "ipfx-masked-trade/" + t["id"])),
               trader_id=alias, trader=aliases[alias], symbol=b["symbol"], side=b["side"],
               opened_at=b["opened_at"], closed_at=b["closed_at"], available_at=l.get("created_at", b["closed_at"]),
               ledger_publication_identified=bool(l.get("created_at")),
               source_pnl=t["pnl"], source_volume=t["volume"], source_sl=t["sl"], source_tp=t["tp"], reason=b["reason"])
    if not b["reason"]:
        a, reverse = float(b["a_net"]), float(b["b_net"])
        row.update(lots=float(b["lots"]), gross=(a-reverse)/2, spread=float(b["spread"]),
                   commission=float(b["commission"]), slippage=0, a_net=a, b_net=reverse,
                   hold_s=seconds(b["closed_at"], b["opened_at"]), mid_in=(float(b["in_bid"])+float(b["in_ask"]))/2,
                   mid_out=(float(b["out_bid"])+float(b["out_ask"]))/2,
                   spread_multiple=((a-reverse)/2)/float(b["spread"]) if float(b["spread"]) else None,
                   markouts=[], risk_b_net=None)
    trades.append(row)
payload = dict(cutoff=core["cutoff"], exported_at=benchmark["exported_at"],
               archive_sha256=hashlib.file_digest(archive.open("rb"), "sha256").hexdigest(),
               control={"a_net": baseline["books"]["a"]["net"], "b_net": baseline["books"]["b"]["net"]},
               trades=trades)
destination.write_text(json.dumps(payload), encoding="utf-8")
print(json.dumps({"masked_people": len(aliases), "source_rows": len(trades), "output": str(destination)}))
