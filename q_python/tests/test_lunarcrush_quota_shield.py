"""
Smoke test for the LunarCrush quota shield (in-flight dedup + per-minute /
per-day gate + stale fallback).

Run from the q_python directory:

    .venv/Scripts/python.exe -m tests.test_lunarcrush_quota_shield

This test does NOT make any real network calls — the HTTP helpers on the
service are monkeypatched. The goal is to verify that the gate, dedup map,
and stats accounting all behave correctly.
"""
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

# Make `src` importable when running this file directly.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from src.services.data.lunarcrush_service import (  # noqa: E402
    LunarCrushService,
    LunarCrushQuotaGate,
    get_lunarcrush_service,
)


def _fresh_service(tmp_state_path: str, rpm: int, daily: int) -> LunarCrushService:
    """Build a LunarCrushService with a tiny gate for testing."""
    svc = LunarCrushService()
    svc.api_key = "test-key"  # bypass the "no key" early-return
    svc.SOCIAL_METRICS_TTL = 60  # short fresh window so we can age it out
    svc.NEWS_TTL = 60
    svc.MAX_STALE_SECS = 24 * 3600
    svc._gate = LunarCrushQuotaGate(rpm=rpm, daily=daily, state_path=tmp_state_path)
    # Reset stats / caches / inflight maps
    svc._social_metrics_cache.clear()
    svc._news_cache.clear()
    svc._inflight_social.clear()
    svc._inflight_news.clear()
    with svc._stats_lock:
        for k in svc.stats:
            svc.stats[k] = 0
    return svc


def test_inflight_dedup() -> None:
    """10 concurrent fetches for the same symbol should result in exactly 1 HTTP call."""
    state_path = os.path.join(HERE, "_tmp_quota_dedup.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=8, daily=100)

    call_counter = {"n": 0}
    counter_lock = threading.Lock()

    def fake_http(symbol: str):
        # Slow enough that 10 concurrent callers will pile up
        with counter_lock:
            call_counter["n"] += 1
        time.sleep(0.3)
        return {"galaxy_score": 50.0, "alt_rank": 1, "symbol": symbol}

    svc._fetch_social_metrics_http = fake_http  # type: ignore[assignment]

    results = []
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(svc.fetch_social_metrics, "BTC") for _ in range(10)]
        for f in as_completed(futures):
            results.append(f.result())

    snap = svc.get_stats()
    print(f"  http_calls={call_counter['n']}  stats={snap['stats']}")
    assert call_counter["n"] == 1, (
        f"expected exactly 1 underlying HTTP call, got {call_counter['n']}"
    )
    assert all(r.get("symbol") == "BTC" for r in results), "every caller should get the result"
    # 1 cache miss (the owner) + 9 dedup waiters (which read cache as fresh)
    # The non-owners go through the dedup-wait path, which counts as cache_hits or dedup_saves
    # depending on whether the owner had populated the cache before they re-checked.
    assert snap["stats"]["calls_made"] == 1
    assert snap["stats"]["cache_misses"] == 1
    # Either dedup_saves (read fresh after waiting) or cache_hits (raced and saw fresh first)
    deduped = snap["stats"]["dedup_saves"] + snap["stats"]["cache_hits"]
    assert deduped >= 9, f"expected >=9 deduped/cached reads, got {deduped}"
    print("  PASS: in-flight dedup")


def test_quota_gate_blocks_when_minute_exhausted() -> None:
    """With rpm=2, the 3rd unique-symbol call in the same minute should be blocked."""
    state_path = os.path.join(HERE, "_tmp_quota_minute.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=2, daily=100)

    def fake_http(symbol: str):
        return {"symbol": symbol, "galaxy_score": 1.0}

    svc._fetch_social_metrics_http = fake_http  # type: ignore[assignment]

    r1 = svc.fetch_social_metrics("BTC")
    r2 = svc.fetch_social_metrics("ETH")
    r3 = svc.fetch_social_metrics("SOL")  # should be blocked
    r4 = svc.fetch_social_metrics("DOGE")  # should be blocked

    snap = svc.get_stats()
    print(f"  stats={snap['stats']}  quota={snap['quota']}")
    assert r1.get("symbol") == "BTC"
    assert r2.get("symbol") == "ETH"
    assert r3 == {}, f"SOL should have been blocked (empty dict), got {r3}"
    assert r4 == {}, f"DOGE should have been blocked (empty dict), got {r4}"
    assert snap["stats"]["calls_made"] == 2
    assert snap["stats"]["blocked_by_quota"] == 2
    print("  PASS: minute gate blocks excess calls")


def test_quota_gate_blocks_when_daily_exhausted() -> None:
    """With daily=3, the 4th unique-symbol call should be blocked even if minute has tokens."""
    state_path = os.path.join(HERE, "_tmp_quota_daily.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=8, daily=3)

    def fake_http(symbol: str):
        return {"symbol": symbol}

    svc._fetch_social_metrics_http = fake_http  # type: ignore[assignment]

    svc.fetch_social_metrics("BTC")
    svc.fetch_social_metrics("ETH")
    svc.fetch_social_metrics("SOL")
    blocked = svc.fetch_social_metrics("DOGE")

    snap = svc.get_stats()
    print(f"  stats={snap['stats']}  quota={snap['quota']}")
    assert blocked == {}
    assert snap["stats"]["calls_made"] == 3
    assert snap["stats"]["blocked_by_quota"] == 1
    assert snap["quota"]["day_count"] == 3
    print("  PASS: daily gate blocks excess calls")


def test_stale_served_when_quota_blocked() -> None:
    """If we have stale cache and quota is exhausted, return stale instead of {}."""
    state_path = os.path.join(HERE, "_tmp_quota_stale.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=1, daily=100)

    def fake_http(symbol: str):
        return {"symbol": symbol, "galaxy_score": 99.0}

    svc._fetch_social_metrics_http = fake_http  # type: ignore[assignment]

    # First call: succeeds, populates cache
    first = svc.fetch_social_metrics("BTC")
    assert first.get("galaxy_score") == 99.0

    # Manually age the cache entry past TTL but within MAX_STALE_SECS
    cached_data, _ = svc._social_metrics_cache["BTC"]
    svc._social_metrics_cache["BTC"] = (cached_data, time.time() - (svc.SOCIAL_METRICS_TTL + 10))

    # Second call: cache expired AND minute quota exhausted -> stale fallback
    second = svc.fetch_social_metrics("BTC")
    snap = svc.get_stats()
    print(f"  stats={snap['stats']}")
    assert second.get("galaxy_score") == 99.0, "should serve stale cache, got " + repr(second)
    assert snap["stats"]["served_stale"] == 1
    assert snap["stats"]["blocked_by_quota"] == 1
    print("  PASS: stale fallback on quota block")


def test_state_persists_across_restart() -> None:
    """Restarting the service must not reset the daily counter."""
    state_path = os.path.join(HERE, "_tmp_quota_persist.json")
    if os.path.exists(state_path):
        os.remove(state_path)

    svc1 = _fresh_service(state_path, rpm=8, daily=100)

    def fake_http(symbol: str):
        return {"symbol": symbol}

    svc1._fetch_social_metrics_http = fake_http  # type: ignore[assignment]
    svc1.fetch_social_metrics("BTC")
    svc1.fetch_social_metrics("ETH")
    svc1.fetch_social_metrics("SOL")
    snap1 = svc1._gate.snapshot()
    assert snap1["day_count"] == 3, snap1

    # Simulate restart: brand new gate from the same state file
    gate2 = LunarCrushQuotaGate(rpm=8, daily=100, state_path=state_path)
    snap2 = gate2.snapshot()
    print(f"  pre-restart={snap1}  post-restart={snap2}")
    assert snap2["day_count"] == 3, f"expected day_count=3 after restart, got {snap2}"
    print("  PASS: daily counter persisted")


def test_force_minute_drain() -> None:
    """force_minute_drain should make subsequent try_acquire return False until next minute."""
    state_path = os.path.join(HERE, "_tmp_quota_drain.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    gate = LunarCrushQuotaGate(rpm=10, daily=100, state_path=state_path)
    assert gate.try_acquire() is True
    gate.force_minute_drain()
    assert gate.try_acquire() is False
    print("  PASS: force_minute_drain")


def test_singleton_identity() -> None:
    """get_lunarcrush_service() must return the same instance across calls."""
    a = get_lunarcrush_service()
    b = get_lunarcrush_service()
    assert a is b, "singleton factory returned two different instances"
    # And the engines must reach through the same factory, which would fail if
    # any of them still does `LunarCrushService()` directly.
    from src.services.engines.sentiment_engine import SentimentEngine
    from src.services.engines.fundamental_engine import FundamentalEngine
    from src.services.engines.event_risk_engine import EventRiskEngine
    assert SentimentEngine().lunarcrush_service is a
    assert FundamentalEngine().lunarcrush_service is a
    assert EventRiskEngine().lunarcrush_service is a
    print("  PASS: singleton identity across factory + engines")


def test_bulk_general_news_single_call() -> None:
    """fetch_general_crypto_news should make exactly 1 HTTP call on cache miss,
    use cache on immediate second call, and use dedup for concurrent callers."""
    state_path = os.path.join(HERE, "_tmp_quota_bulk_news.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=8, daily=100)

    call_counter = {"n": 0}

    def fake_http(limit: int):
        call_counter["n"] += 1
        time.sleep(0.2)
        return [{"title": "t1", "text": "body", "source": "lunarcrush",
                 "published_at": None, "url": "https://example.com/1"}] * limit

    svc._fetch_general_news_http = fake_http  # type: ignore[assignment]

    # First call: one HTTP
    r1 = svc.fetch_general_crypto_news(limit=5)
    assert len(r1) == 5
    assert call_counter["n"] == 1

    # Second call within TTL: cache hit, no extra HTTP
    r2 = svc.fetch_general_crypto_news(limit=5)
    assert len(r2) == 5
    assert call_counter["n"] == 1

    # 10 concurrent callers for a new limit: exactly 1 HTTP, rest deduped
    call_counter["n"] = 0
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(svc.fetch_general_crypto_news, 7) for _ in range(10)]
        results = [f.result() for f in as_completed(futures)]
    assert call_counter["n"] == 1, f"expected 1 HTTP call, got {call_counter['n']}"
    assert all(len(r) == 7 for r in results)
    print(f"  stats={svc.get_stats()['stats']}")
    print("  PASS: bulk general news — 1 call + cache + dedup")


def test_bulk_coins_list_warms_cache() -> None:
    """fetch_coins_list_bulk should warm the per-symbol cache so subsequent
    fetch_social_metrics(symbol) calls are free cache hits."""
    state_path = os.path.join(HERE, "_tmp_quota_bulk_coins.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=8, daily=100)

    bulk_calls = {"n": 0}
    per_symbol_calls = {"n": 0}

    def fake_per_symbol(symbol: str):
        per_symbol_calls["n"] += 1
        return {"symbol": symbol, "galaxy_score": 1.0}

    svc._fetch_social_metrics_http = fake_per_symbol  # type: ignore[assignment]

    # Monkey-patch the bulk fetch by replacing requests.get for the bulk URL
    import requests as _req
    original_get = _req.get

    def fake_bulk_get(url, **kwargs):
        if "/public/coins/list/v1" in url:
            bulk_calls["n"] += 1

            class FakeResp:
                status_code = 200
                def raise_for_status(self): pass
                def json(self):
                    return {"data": [
                        {"symbol": "BTC", "galaxy_score": 80, "alt_rank": 1, "price": 100000,
                         "volume_24h": 50000000000, "market_cap": 2000000000000,
                         "sentiment": 0.7, "social_dominance": 30},
                        {"symbol": "ETH", "galaxy_score": 70, "alt_rank": 2, "price": 3000,
                         "volume_24h": 10000000000, "market_cap": 400000000000,
                         "sentiment": 0.6, "social_dominance": 15},
                    ]}
            return FakeResp()
        return original_get(url, **kwargs)
    _req.get = fake_bulk_get  # type: ignore[assignment]

    try:
        result = svc.fetch_coins_list_bulk()
        assert bulk_calls["n"] == 1
        assert "BTC" in result and "ETH" in result
        assert result["BTC"]["galaxy_score"] == 80.0

        # Now per-symbol lookups should be cache hits, not trigger per-symbol HTTP
        btc = svc.fetch_social_metrics("BTC")
        eth = svc.fetch_social_metrics("ETH")
        assert btc["galaxy_score"] == 80.0
        assert eth["galaxy_score"] == 70.0
        assert per_symbol_calls["n"] == 0, (
            f"bulk pre-warm failed; per-symbol endpoint called {per_symbol_calls['n']} times"
        )
    finally:
        _req.get = original_get  # type: ignore[assignment]
    print("  PASS: bulk coins list warms per-symbol cache")


def main() -> int:
    failures = []
    for test in [
        test_inflight_dedup,
        test_quota_gate_blocks_when_minute_exhausted,
        test_quota_gate_blocks_when_daily_exhausted,
        test_stale_served_when_quota_blocked,
        test_state_persists_across_restart,
        test_force_minute_drain,
        test_singleton_identity,
        test_bulk_general_news_single_call,
        test_bulk_coins_list_warms_cache,
    ]:
        print(f"\n[{test.__name__}]")
        try:
            test()
        except AssertionError as e:
            print(f"  FAIL: {e}")
            failures.append(test.__name__)
        except Exception as e:
            print(f"  ERROR: {type(e).__name__}: {e}")
            failures.append(test.__name__)

    # Cleanup tmp state files
    for fname in os.listdir(HERE):
        if fname.startswith("_tmp_quota_") and fname.endswith(".json"):
            try:
                os.remove(os.path.join(HERE, fname))
            except OSError:
                pass

    print()
    if failures:
        print(f"FAILED: {len(failures)} test(s) — {failures}")
        return 1
    print("All LunarCrush quota shield tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
