"""Copier bridge helpers: python tests/bridge_helpers_test.py (no IBKR connection needed)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bridge"))
from ibkr_copier import round_to_tick, round_units

# Long copy: entry BUY limit never loosens the tolerance (down); its SELL exits round down too (more likely to fill).
assert round_to_tick(1.100034, 0.00005, "buy", "entry") == 1.1
assert round_to_tick(1.100034, 0.00005, "buy", "exit") == 1.1
# Short copy: up, for the same reasons.
assert round_to_tick(1.099966, 0.00005, "sell", "entry") == 1.1
assert round_to_tick(2650.07, 0.01, "buy", "entry") == 2650.07
assert round_to_tick(1.2345, 0, "buy", "entry") == 1.2345
# Units: whole increments, never above the request, 0 when under the minimum.
assert round_units(12345.6, 1, 1) == 12345
assert round_units(0.4, 1, 1) == 0
assert round_units(150, 100, 100) == 100
print("bridge helpers ok")
