"""Synthetic, network-free checks for the options signal engine changes.

Run from quantiva_backend/q_python:  python test_options_engine_synthetic.py
"""
import sys

import src.services.engines.options_signal_engine as ose
from src.services.engines.options_signal_engine import OptionsSignalEngine

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


engine = OptionsSignalEngine()

# Keep every scenario offline: stub earnings (default 'unknown') and never
# let sentiment auto-fetch (pass sentiment_score explicitly).
engine._get_earnings = lambda symbol: ("error", None)

# 60-bar synthetic series
uptrend = [100 * (1.004 ** i) for i in range(60)]          # ~+27% over 60d
downtrend = [100 * (0.996 ** i) for i in range(60)]
flat = [100 + (0.05 if i % 2 else -0.05) for i in range(60)]
volumes = [1_000_000.0] * 60

print("\n[1] Stock uptrend -> bullish direction + directional strategies")
res = engine.calculate(
    asset_id="NVDA", asset_type="stock", venue="ALPACA",
    iv_rank=0.40, iv_value=0.30, spot_price=uptrend[-1],
    price_data=uptrend, volume_data=volumes, sentiment_score=0.0,
    contract_multiplier=100,
)
sigs = res["metadata"]["signals"]
strats = {s["strategy"] for s in sigs}
check("score > 0.1 (bullish)", res["score"] > 0.1, f"score={res['score']}")
check("directional strategy emitted", bool(strats & {"long_call", "bull_call_spread", "short_put"}), f"strats={strats}")
check("all signals bullish", all(s["direction"] == "bullish" for s in sigs), f"{[s['direction'] for s in sigs]}")

print("\n[2] Stock downtrend -> bearish")
res = engine.calculate(
    asset_id="TSLA", asset_type="stock", venue="ALPACA",
    iv_rank=0.40, iv_value=0.30, spot_price=downtrend[-1],
    price_data=downtrend, volume_data=volumes, sentiment_score=0.0,
    contract_multiplier=100,
)
strats = {s["strategy"] for s in res["metadata"]["signals"]}
check("score < -0.1 (bearish)", res["score"] < -0.1, f"score={res['score']}")
check("bearish strategy emitted", bool(strats & {"long_put", "bear_put_spread"}), f"strats={strats}")

print("\n[3] Flat stock -> neutral (chop measured, not assumed)")
res = engine.calculate(
    asset_id="SPY", asset_type="stock", venue="ALPACA",
    iv_rank=0.60, iv_value=0.18, spot_price=flat[-1],
    price_data=flat, volume_data=volumes, sentiment_score=0.0,
    contract_multiplier=100,
)
strats = {s["strategy"] for s in res["metadata"]["signals"]}
check("neutral score", abs(res["score"]) <= 0.1, f"score={res['score']}")
check("neutral strategies only", strats <= {"iron_condor", "long_butterfly", "calendar_spread", "long_straddle", "long_strangle"}, f"strats={strats}")

print("\n[4] No price bars + strong sentiment -> sentiment breaks the neutral lock")
res = engine.calculate(
    asset_id="AAPL", asset_type="stock", venue="ALPACA",
    iv_rank=0.40, iv_value=0.25, spot_price=200.0,
    price_data=None, volume_data=None, sentiment_score=0.9,
    contract_multiplier=100,
)
check("score = 0.9 * 0.15 = 0.135 -> bullish", res["score"] > 0.1, f"score={res['score']}")

print("\n[5] Catalyst gate: no earnings -> straddle/strangle confidence docked")
flat_low_iv = dict(
    asset_id="MSFT", asset_type="stock", venue="ALPACA",
    iv_rank=0.20, iv_value=0.18, spot_price=flat[-1],
    price_data=flat, volume_data=volumes, sentiment_score=0.0,
    contract_multiplier=100,
)
engine._get_earnings = lambda symbol: ("ok", None)  # definitively none
res_none = engine.calculate(**flat_low_iv)
engine._get_earnings = lambda symbol: (
    "ok",
    {"earnings_date": "2026-06-25", "days_until_earnings": 14},
)
res_earn = engine.calculate(**flat_low_iv)
def conf_of(res, strat):
    return next((s["confidence"] for s in res["metadata"]["signals"] if s["strategy"] == strat), None)
c_none = conf_of(res_none, "long_straddle")
c_earn = conf_of(res_earn, "long_straddle")
check("straddle present in both runs", c_none is not None and c_earn is not None, f"{c_none} {c_earn}")
if c_none is not None and c_earn is not None:
    # Gap ~0.20: earnings boost (+0.10) minus the softened no-catalyst dock
    # (-0.10, was -0.15). The iv-rich penalty applies to both runs so it
    # cancels in the difference.
    check("earnings boost > no-catalyst penalty (gap ~0.20)", round(c_earn - c_none, 2) >= 0.15, f"earn={c_earn} none={c_none}")
earn_sig = next(s for s in res_earn["metadata"]["signals"] if s["strategy"] == "long_straddle")
none_sig = next(s for s in res_none["metadata"]["signals"] if s["strategy"] == "long_straddle")
check("earnings reasoning mentions catalyst", "Earnings on 2026-06-25" in earn_sig["reasoning"], earn_sig["reasoning"])
check("no-catalyst reasoning mentions it", "No earnings catalyst" in none_sig["reasoning"], none_sig["reasoning"])

# Low-IV neutral coverage: a calendar spread is now eligible at iv_rank 0.20
# (floor lowered from 0.30 to 0.0) and is NOT catalyst-gated, so a quiet
# low-IV large cap surfaces a neutral play even with no earnings ahead.
check(
    "low-IV neutral emits calendar_spread",
    "calendar_spread" in {s["strategy"] for s in res_none["metadata"]["signals"]},
    f"strats={ {s['strategy'] for s in res_none['metadata']['signals']} }",
)

print("\n[6] Catalyst gate drop mode suppresses the signal")
import os
os.environ["OPTIONS_VOL_CATALYST_MODE"] = "drop"
engine._get_earnings = lambda symbol: ("ok", None)
res_drop = engine.calculate(**flat_low_iv)
strats_drop = {s["strategy"] for s in res_drop["metadata"]["signals"]}
check("straddle/strangle suppressed", not (strats_drop & {"long_straddle", "long_strangle"}), f"strats={strats_drop}")
del os.environ["OPTIONS_VOL_CATALYST_MODE"]

print("\n[7] IV-rich-vs-realized penalty")
engine._get_earnings = lambda symbol: ("error", None)  # isolate the iv/rv term
# flat series has tiny realized vol; iv 0.18 / rv(tiny) >> 1.25 -> penalty fires
res_rich = engine.calculate(**flat_low_iv)
rich_sig = next((s for s in res_rich["metadata"]["signals"] if s["strategy"] == "long_straddle"), None)
check("iv-rich note present", rich_sig is not None and "Implied vol is rich vs realized" in rich_sig["reasoning"], getattr(rich_sig, "reasoning", None) if rich_sig is None else rich_sig["reasoning"])

print("\n[8] Crypto path untouched (no sentiment fetch, old thresholds)")
res = engine.calculate(
    asset_id="BTC", asset_type="crypto", venue="BINANCE",
    iv_rank=0.40, iv_value=0.60, spot_price=uptrend[-1] * 1000,
    price_data=uptrend, volume_data=volumes,
    contract_multiplier=0.01,
)
check("crypto signals generated", len(res["metadata"]["signals"]) > 0)

print("\n[9] _earnings_before_expiry")
f = OptionsSignalEngine._earnings_before_expiry
check("before", f("2026-06-25", "2026-07-10T08:00:00Z") is True)
check("after", f("2026-07-15", "2026-07-10T08:00:00Z") is False)
check("none", f(None, "2026-07-10T08:00:00Z") is False)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
