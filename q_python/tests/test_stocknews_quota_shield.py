"""
Smoke test for the StockNewsAPI quota shield (cache + per-minute / per-month
gate + singleton).

Run from the q_python directory:

    .venv/Scripts/python.exe -m tests.test_stocknews_quota_shield
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from src.services.data.stock_news_service import (  # noqa: E402
    StockNewsQuotaGate,
    StockNewsService,
    get_stock_news_service,
)


def _fresh_service(tmp_state_path: str, rpm: int, monthly: int) -> StockNewsService:
    svc = StockNewsService()
    svc.api_key = "test-key"
    svc.finnhub_api_key = "finnhub-test-key"  # enable fallback in tests
    svc.CACHE_TTL = 60
    svc.MAX_STALE_SECS = 24 * 3600
    svc._gate = StockNewsQuotaGate(rpm=rpm, monthly=monthly, state_path=tmp_state_path)
    svc._news_cache.clear()
    with svc._stats_lock:
        for k in svc.stats:
            svc.stats[k] = 0
    return svc


def _fake_articles(symbol: str, n: int = 3):
    return [
        {"title": f"{symbol} news {i}", "text": f"Body {i}", "source": "test",
         "date": "2026-04-16", "url": f"https://example.com/{symbol}/{i}"}
        for i in range(n)
    ]


def test_cache_dedup() -> None:
    """Two consecutive fetch_news('AAPL') → exactly 1 HTTP call."""
    state_path = os.path.join(HERE, "_tmp_sn_dedup.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=20, monthly=100)

    call_counter = {"n": 0}
    import requests as _req
    original_get = _req.get

    def fake_get(url, **kwargs):
        call_counter["n"] += 1

        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return {"data": _fake_articles("AAPL")}
        return FakeResp()
    _req.get = fake_get  # type: ignore

    try:
        r1 = svc.fetch_news("AAPL", limit=3)
        r2 = svc.fetch_news("AAPL", limit=3)
        assert len(r1) == 3
        assert len(r2) == 3
        assert call_counter["n"] == 1, f"expected 1 HTTP, got {call_counter['n']}"
        snap = svc.get_stats()
        assert snap["stats"]["cache_hits"] == 1
        assert snap["stats"]["calls_made"] == 1
    finally:
        _req.get = original_get  # type: ignore
    print("  PASS: cache dedup (2 calls -> 1 HTTP)")


def test_minute_gate_blocks() -> None:
    """rpm=2; 3rd unique-symbol call returns []."""
    state_path = os.path.join(HERE, "_tmp_sn_minute.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=2, monthly=100)

    import requests as _req
    original_get = _req.get

    def fake_get(url, **kwargs):
        tickers = kwargs.get("params", {}).get("tickers", "X")

        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return {"data": _fake_articles(tickers, 1)}
        return FakeResp()
    _req.get = fake_get  # type: ignore

    try:
        svc.fetch_news("AAPL")
        svc.fetch_news("TSLA")
        blocked = svc.fetch_news("GOOGL")
        assert blocked == [], f"GOOGL should be blocked, got {blocked}"
        snap = svc.get_stats()
        assert snap["stats"]["calls_made"] == 2
        assert snap["stats"]["blocked_by_quota"] == 1
    finally:
        _req.get = original_get  # type: ignore
    print("  PASS: minute gate blocks the 3rd call")


def test_monthly_gate_blocks() -> None:
    """monthly=2; 3rd unique-symbol call returns []."""
    state_path = os.path.join(HERE, "_tmp_sn_monthly.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=20, monthly=2)

    import requests as _req
    original_get = _req.get

    def fake_get(url, **kwargs):
        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return {"data": _fake_articles("X", 1)}
        return FakeResp()
    _req.get = fake_get  # type: ignore

    try:
        svc.fetch_news("AAPL")
        svc.fetch_news("TSLA")
        blocked = svc.fetch_news("GOOGL")
        assert blocked == []
        snap = svc.get_stats()
        assert snap["stats"]["calls_made"] == 2
        assert snap["stats"]["blocked_by_quota"] == 1
        assert snap["quota"]["month_count"] == 2
    finally:
        _req.get = original_get  # type: ignore
    print("  PASS: monthly gate blocks the 3rd call")


def test_stale_fallback_when_blocked() -> None:
    """Cached → expire → block → returns stale (not [])."""
    state_path = os.path.join(HERE, "_tmp_sn_stale.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=20, monthly=1)

    import requests as _req
    original_get = _req.get

    def fake_get(url, **kwargs):
        class FakeResp:
            status_code = 200
            def raise_for_status(self): pass
            def json(self): return {"data": _fake_articles("AAPL", 2)}
        return FakeResp()
    _req.get = fake_get  # type: ignore

    try:
        first = svc.fetch_news("AAPL", limit=2)
        assert len(first) == 2

        # Age cache past TTL but within MAX_STALE
        cache_key = "AAPL_2"
        cached_data, _ = svc._news_cache[cache_key]
        svc._news_cache[cache_key] = (cached_data, time.time() - (svc.CACHE_TTL + 10))

        # Monthly exhausted → should serve stale
        second = svc.fetch_news("AAPL", limit=2)
        assert len(second) == 2, f"should serve stale, got {second}"
        snap = svc.get_stats()
        assert snap["stats"]["served_stale"] == 1, f"served_stale={snap['stats']['served_stale']}"
        assert snap["stats"]["blocked_by_quota"] == 1
    finally:
        _req.get = original_get  # type: ignore
    print("  PASS: stale fallback on quota block")


def test_singleton_identity() -> None:
    """get_stock_news_service() is get_stock_news_service()."""
    a = get_stock_news_service()
    b = get_stock_news_service()
    assert a is b, "singleton broken"

    from src.services.engines.sentiment_engine import SentimentEngine
    from src.services.engines.fundamental_engine import FundamentalEngine
    from src.services.engines.event_risk_engine import EventRiskEngine
    assert SentimentEngine().stock_news_service is a
    assert FundamentalEngine().stock_news_service is a
    assert EventRiskEngine().stock_news_service is a
    print("  PASS: singleton identity (factory + all 3 engines)")


def test_http_403_handling() -> None:
    """HTTP 403 → force_minute_drain + serve stale."""
    state_path = os.path.join(HERE, "_tmp_sn_403.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=20, monthly=100)

    import requests as _req
    original_get = _req.get

    call_count = {"ok": 0, "err": 0}

    def fake_get(url, **kwargs):
        if call_count["ok"] == 0:
            call_count["ok"] += 1

            class OkResp:
                status_code = 200
                def raise_for_status(self): pass
                def json(self): return {"data": _fake_articles("MSFT", 2)}
            return OkResp()
        else:
            call_count["err"] += 1
            resp = _req.models.Response()
            resp.status_code = 403
            resp._content = b'{"message":"API calls limit reached"}'
            raise _req.exceptions.HTTPError(response=resp)

    _req.get = fake_get  # type: ignore

    try:
        # First call succeeds + caches
        first = svc.fetch_news("MSFT", limit=2)
        assert len(first) == 2

        # Age the cache
        cache_key = "MSFT_2"
        cached_data, _ = svc._news_cache[cache_key]
        svc._news_cache[cache_key] = (cached_data, time.time() - (svc.CACHE_TTL + 10))

        # Second call gets 403 from StockNewsAPI; Finnhub fallback ALSO gets
        # a 403 (same fake_get regardless of URL), so we fall through to stale.
        second = svc.fetch_news("MSFT", limit=2)
        assert len(second) == 2, f"should serve stale, got {second}"
        snap = svc.get_stats()
        assert snap["stats"]["http_403s"] == 1
        assert snap["stats"]["served_stale"] == 1
        # Finnhub was attempted but failed (same mocked error)
        assert snap["stats"]["finnhub_errors"] >= 1
    finally:
        _req.get = original_get  # type: ignore
    print("  PASS: HTTP 403 + Finnhub also fails -> drain + serve stale")


def test_finnhub_fallback_on_stocknews_403() -> None:
    """StockNewsAPI returns 403; Finnhub fallback serves fresh items."""
    state_path = os.path.join(HERE, "_tmp_sn_fallback_403.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    svc = _fresh_service(state_path, rpm=20, monthly=100)

    import requests as _req
    original_get = _req.get

    sn_calls = {"n": 0}
    fh_calls = {"n": 0}

    def fake_get(url, **kwargs):
        if "stocknewsapi.com" in url:
            sn_calls["n"] += 1
            resp = _req.models.Response()
            resp.status_code = 403
            resp._content = b'{"message":"API calls limit reached"}'
            raise _req.exceptions.HTTPError(response=resp)
        elif "finnhub.io" in url:
            fh_calls["n"] += 1

            class FhResp:
                status_code = 200
                def raise_for_status(self): pass
                def json(self):
                    return [
                        {
                            "headline": f"AAPL earnings article {i}",
                            "summary": f"summary text {i}",
                            "source": "Reuters",
                            "datetime": int(time.time()) - 3600,
                            "url": f"https://example.com/finnhub/{i}",
                            "related": "AAPL",
                        }
                        for i in range(3)
                    ]
            return FhResp()
        raise ValueError(f"unexpected URL: {url}")

    _req.get = fake_get  # type: ignore

    try:
        result = svc.fetch_news("AAPL", limit=3)
        assert len(result) == 3, f"expected 3 items from Finnhub, got {len(result)}"
        assert result[0]["source"] == "Reuters"
        assert "example.com/finnhub" in result[0]["url"]

        snap = svc.get_stats()
        assert snap["stats"]["http_403s"] == 1, "StockNewsAPI 403 should be recorded"
        assert sn_calls["n"] == 1, "StockNewsAPI was called once"
        assert fh_calls["n"] == 1, "Finnhub was called exactly once as fallback"
        assert snap["stats"]["finnhub_calls_made"] == 1
        assert snap["stats"]["finnhub_fallbacks_served"] == 1
        assert snap["stats"]["finnhub_errors"] == 0
    finally:
        _req.get = original_get  # type: ignore
    print("  PASS: StockNewsAPI 403 -> Finnhub fallback serves fresh data")


def test_finnhub_fallback_on_own_quota_block() -> None:
    """Our own monthly gate blocks StockNewsAPI; Finnhub still serves data."""
    state_path = os.path.join(HERE, "_tmp_sn_fallback_gate.json")
    if os.path.exists(state_path):
        os.remove(state_path)
    # monthly=0 so the gate denies every call up front
    svc = _fresh_service(state_path, rpm=20, monthly=1)
    # Pre-consume the single monthly token
    assert svc._gate.try_acquire() is True
    # Now the gate will deny

    import requests as _req
    original_get = _req.get

    sn_calls = {"n": 0}
    fh_calls = {"n": 0}

    def fake_get(url, **kwargs):
        if "stocknewsapi.com" in url:
            sn_calls["n"] += 1
            raise AssertionError(
                "StockNewsAPI should NOT have been called when our gate denies"
            )
        elif "finnhub.io" in url:
            fh_calls["n"] += 1

            class FhResp:
                status_code = 200
                def raise_for_status(self): pass
                def json(self):
                    return [
                        {
                            "headline": "Market rally on Fed news",
                            "summary": "Stocks jumped after...",
                            "source": "Bloomberg",
                            "datetime": int(time.time()) - 600,
                            "url": "https://example.com/finnhub/general-1",
                            "related": "AAPL,MSFT",
                        }
                    ]
            return FhResp()
        raise ValueError(f"unexpected URL: {url}")

    _req.get = fake_get  # type: ignore

    try:
        result = svc.fetch_general_news(limit=5)
        assert len(result) == 1, f"expected Finnhub fallback, got {result}"
        assert result[0]["source"] == "Bloomberg"
        assert result[0].get("symbol") == "AAPL"  # first ticker from related CSV

        snap = svc.get_stats()
        assert snap["stats"]["blocked_by_quota"] == 1
        assert sn_calls["n"] == 0
        assert fh_calls["n"] == 1
        assert snap["stats"]["finnhub_calls_made"] == 1
        assert snap["stats"]["finnhub_fallbacks_served"] == 1
    finally:
        _req.get = original_get  # type: ignore
    print("  PASS: own-gate blocks StockNewsAPI -> Finnhub fallback serves fresh data")


def main() -> int:
    failures = []
    for test in [
        test_cache_dedup,
        test_minute_gate_blocks,
        test_monthly_gate_blocks,
        test_stale_fallback_when_blocked,
        test_singleton_identity,
        test_http_403_handling,
        test_finnhub_fallback_on_stocknews_403,
        test_finnhub_fallback_on_own_quota_block,
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

    for fname in os.listdir(HERE):
        if fname.startswith("_tmp_sn_") and fname.endswith(".json"):
            try:
                os.remove(os.path.join(HERE, fname))
            except OSError:
                pass

    print()
    if failures:
        print(f"FAILED: {len(failures)} test(s) — {failures}")
        return 1
    print("All StockNewsAPI quota shield tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
