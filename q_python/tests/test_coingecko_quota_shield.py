"""
Smoke test for the CoinGecko quota shield (cache + per-minute / per-month
gate + singleton + symbol-id cache).

Run from the q_python directory:

    .venv/Scripts/python.exe -m tests.test_coingecko_quota_shield

This test does NOT make any real network calls — the HTTP layer is
monkeypatched.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from src.services.data.coingecko_service import (  # noqa: E402
    CoinGeckoQuotaGate,
    CoinGeckoService,
    get_coingecko_service,
)


def _fresh_service(tmp_state_path: str, rpm: int, monthly: int) -> CoinGeckoService:
    """Build a CoinGeckoService with a tiny gate for testing."""
    svc = CoinGeckoService()
    svc.api_key = "CG-test-key"
    svc.is_pro_api = True
    svc.base_url = svc.PRO_BASE_URL
    svc.DETAILS_TTL = 60
    svc.MAX_STALE_SECS = 24 * 3600
    svc._gate = CoinGeckoQuotaGate(rpm=rpm, monthly=monthly, state_path=tmp_state_path)
    svc._details_cache.clear()
    svc._symbol_id_cache.clear()
    with svc._stats_lock:
        for k in svc.stats:
            svc.stats[k] = 0
    return svc


_COIN_ID_BY_SYMBOL = {"BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "DOGE": "dogecoin"}
# Reverse lookup so callers can pass either "BTC" or "bitcoin"
_SYMBOL_BY_COIN_ID = {v: k for k, v in _COIN_ID_BY_SYMBOL.items()}

def _stub_details(symbol_or_id: str, gscore: float = 50.0):
    """Build a fake CoinGecko coin-details response for monkeypatching.

    Accepts either a symbol ("BTC") or a coingecko id ("bitcoin"). Always
    returns the canonical coingecko id in the `id` field.
    """
    upper = symbol_or_id.upper()
    if upper in _COIN_ID_BY_SYMBOL:
        coin_id = _COIN_ID_BY_SYMBOL[upper]
        symbol = upper
    elif symbol_or_id.lower() in _SYMBOL_BY_COIN_ID:
        coin_id = symbol_or_id.lower()
        symbol = _SYMBOL_BY_COIN_ID[coin_id]
    else:
        coin_id = symbol_or_id.lower()
        symbol = symbol_or_id.upper()
    return {
        "id": coin_id,
        "symbol": symbol,
        "name": symbol,
        "developer_data": {
            "code_additions_deletions_4_weeks": {"additions": 1000, "deletions": 200},
            "forks": 100, "stars": 5000, "subscribers": 50,
            "total_issues": 100, "closed_issues": 80,
            "pull_requests_merged": 30, "pull_requests_open": 5,
        },
        "market_data": {
            "circulating_supply": 19_000_000,
            "total_supply": 21_000_000,
            "max_supply": 21_000_000,
            "market_cap": {"usd": 1_500_000_000_000},
            "fully_diluted_valuation": {"usd": 1_700_000_000_000},
        },
        "community_data": {},
    }


def test_cache_dedup_dev_then_tokenomics() -> None:
    """get_developer_activity_score then get_tokenomics_score for the same
    symbol must result in exactly ONE underlying /coins/{id} HTTP call."""
    state_path = os.path.join(HERE, "_tmp_cg_dedup.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=400, monthly=1000)

    call_counter = {"n": 0}

    def fake_fetch_http(coin_id: str):  # not actually used; we replace fetch_coin_details internals
        pass

    # Monkeypatch the network bits: replace `requests.get` and `_symbol_to_coin_id`
    import requests as _req
    original_get = _req.get

    def fake_get(url, **kwargs):
        if "/coins/bitcoin" in url:
            call_counter["n"] += 1

            class FakeResp:
                status_code = 200
                def raise_for_status(self): pass
                def json(self): return _stub_details("BTC")
            return FakeResp()
        return original_get(url, **kwargs)
    _req.get = fake_get  # type: ignore[assignment]

    try:
        dev = svc.get_developer_activity_score("BTC")
        tok = svc.get_tokenomics_score("BTC")
        assert dev["activity_score"] >= 0
        assert tok["tokenomics_score"] >= 0
        assert call_counter["n"] == 1, (
            f"expected exactly 1 HTTP call (cache dedup), got {call_counter['n']}"
        )
        snap = svc.get_stats()
        assert snap["stats"]["calls_made"] == 1
        assert snap["stats"]["cache_hits"] == 1
    finally:
        _req.get = original_get  # type: ignore[assignment]
    print("  PASS: cache dedups dev+tokenomics into 1 HTTP call")


def test_minute_gate_blocks() -> None:
    """rpm=2; 3rd unique-coin call returns {} (blocked)."""
    state_path = os.path.join(HERE, "_tmp_cg_minute.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=2, monthly=1000)

    import requests as _req
    original_get = _req.get

    def fake_get(url, **kwargs):
        coin_id = url.rsplit("/coins/", 1)[-1].split("?")[0]

        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return _stub_details(coin_id)
        return FakeResp()
    _req.get = fake_get  # type: ignore[assignment]

    try:
        r1 = svc.fetch_coin_details("BTC")
        r2 = svc.fetch_coin_details("ETH")
        r3 = svc.fetch_coin_details("SOL")  # blocked
        assert r1.get("id") == "bitcoin"
        assert r2.get("id") == "ethereum"
        assert r3 == {}, f"SOL should have been blocked, got {r3}"
        snap = svc.get_stats()
        assert snap["stats"]["calls_made"] == 2
        assert snap["stats"]["blocked_by_quota"] == 1
    finally:
        _req.get = original_get  # type: ignore[assignment]
    print("  PASS: minute gate blocks the 3rd call")


def test_monthly_gate_blocks() -> None:
    """monthly=3; 4th unique-coin call returns {}."""
    state_path = os.path.join(HERE, "_tmp_cg_monthly.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=400, monthly=3)

    import requests as _req
    original_get = _req.get

    def fake_get(url, **kwargs):
        coin_id = url.rsplit("/coins/", 1)[-1].split("?")[0]

        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return _stub_details(coin_id)
        return FakeResp()
    _req.get = fake_get  # type: ignore[assignment]

    try:
        svc.fetch_coin_details("BTC")
        svc.fetch_coin_details("ETH")
        svc.fetch_coin_details("SOL")
        blocked = svc.fetch_coin_details("DOGE")
        assert blocked == {}
        snap = svc.get_stats()
        assert snap["stats"]["calls_made"] == 3
        assert snap["stats"]["blocked_by_quota"] == 1
        assert snap["quota"]["month_count"] == 3
    finally:
        _req.get = original_get  # type: ignore[assignment]
    print("  PASS: monthly gate blocks the 4th call")


def test_stale_fallback_when_blocked() -> None:
    """If quota is blocked but stale cache exists, return stale instead of {}.

    Use monthly=1 (not rpm=1) so a wall-clock minute boundary mid-test
    can't refill the bucket and let the second call slip through.
    """
    state_path = os.path.join(HERE, "_tmp_cg_stale.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=400, monthly=1)

    import requests as _req
    original_get = _req.get

    def fake_get(url, **kwargs):
        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return _stub_details("BTC")
        return FakeResp()
    _req.get = fake_get  # type: ignore[assignment]

    try:
        first = svc.fetch_coin_details("BTC")
        assert first.get("id") == "bitcoin"

        # Age the cached entry past TTL but within MAX_STALE_SECS
        cached_data, _ = svc._details_cache["bitcoin"]
        svc._details_cache["bitcoin"] = (cached_data, time.time() - (svc.DETAILS_TTL + 10))

        # Second call: cache stale + monthly quota exhausted -> stale fallback
        second = svc.fetch_coin_details("BTC")
        snap = svc.get_stats()
        assert second.get("id") == first.get("id"), f"should serve stale, got {second}"
        assert snap["stats"]["served_stale"] == 1, f"served_stale={snap['stats']['served_stale']}"
        assert snap["stats"]["blocked_by_quota"] == 1, f"blocked_by_quota={snap['stats']['blocked_by_quota']}"
    finally:
        _req.get = original_get  # type: ignore[assignment]
    print("  PASS: stale fallback on quota block")


def test_singleton_identity() -> None:
    """get_coingecko_service() returns the same instance, and FundamentalEngine uses it."""
    a = get_coingecko_service()
    b = get_coingecko_service()
    assert a is b, "singleton broken"
    from src.services.engines.fundamental_engine import FundamentalEngine
    fe = FundamentalEngine()
    assert fe.coingecko_service is a, "FundamentalEngine uses its own instance"
    print("  PASS: singleton identity (factory + FundamentalEngine)")


def test_month_persistence_resets_on_new_month() -> None:
    """A state file dated last month should NOT carry forward into the current month."""
    state_path = os.path.join(HERE, "_tmp_cg_month_persist.json")
    # Write a state file claiming last month
    last_month = "2020-01"  # arbitrary historical
    with open(state_path, "w", encoding="utf-8") as f:
        import json as _json
        _json.dump({"month": last_month, "count": 999_999}, f)

    gate = CoinGeckoQuotaGate(rpm=400, monthly=10, state_path=state_path)
    snap = gate.snapshot()
    assert snap["month_count"] == 0, f"stale-month state should NOT load, got {snap}"
    print(f"  PASS: stale-month state ignored ({last_month} -> reset to 0)")


def test_symbol_id_cache() -> None:
    """Two consecutive _symbol_to_coin_id('XYZ') for an unmapped symbol must
    fire /search exactly once."""
    state_path = os.path.join(HERE, "_tmp_cg_symbol_id.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=400, monthly=1000)

    search_calls = {"n": 0}
    import requests as _req
    original_get = _req.get

    def fake_get(url, **kwargs):
        if "/search" in url:
            search_calls["n"] += 1

            class FakeResp:
                status_code = 200
                def raise_for_status(self): pass
                def json(self): return {"coins": [{"id": "made-up-coin"}]}
            return FakeResp()
        return original_get(url, **kwargs)
    _req.get = fake_get  # type: ignore[assignment]

    try:
        a = svc._symbol_to_coin_id("ZZUNK")
        b = svc._symbol_to_coin_id("ZZUNK")
        assert a == "made-up-coin"
        assert b == "made-up-coin"
        assert search_calls["n"] == 1, (
            f"second _symbol_to_coin_id should be a cache hit, /search fired {search_calls['n']} times"
        )
    finally:
        _req.get = original_get  # type: ignore[assignment]
    print("  PASS: symbol-id cache prevents repeat /search")


def main() -> int:
    failures = []
    for test in [
        test_cache_dedup_dev_then_tokenomics,
        test_minute_gate_blocks,
        test_monthly_gate_blocks,
        test_stale_fallback_when_blocked,
        test_singleton_identity,
        test_month_persistence_resets_on_new_month,
        test_symbol_id_cache,
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
        if fname.startswith("_tmp_cg_") and fname.endswith(".json"):
            try:
                os.remove(os.path.join(HERE, fname))
            except OSError:
                pass

    print()
    if failures:
        print(f"FAILED: {len(failures)} test(s) — {failures}")
        return 1
    print("All CoinGecko quota shield tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
