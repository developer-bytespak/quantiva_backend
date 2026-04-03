"""
Test script to verify all data sources and signal generation pipeline.
Tests 3rd party APIs, NestJS system candles, and signal generation end-to-end.
Run from q_python root: .venv/Scripts/python.exe test_data_pipeline.py
"""
import sys
import os
import json
import traceback

# Add src to path so imports work
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

# Load environment
from src.config import *

PASS = "PASS"
FAIL = "FAIL"
WARN = "WARN"
results = []

def log_result(test_name, status, detail=""):
    results.append((test_name, status, detail))
    symbol = {"PASS": "[OK]", "FAIL": "[FAIL]", "WARN": "[WARN]"}[status]
    print(f"  {symbol} {test_name}")
    if detail:
        # Truncate long details
        detail_str = str(detail)
        if len(detail_str) > 300:
            detail_str = detail_str[:300] + "..."
        print(f"       {detail_str}")


def test_env_vars():
    """Test that all required environment variables are set."""
    print("\n=== 1. Environment Variables ===")

    required = {
        "LUNARCRUSH_API_KEY": LUNARCRUSH_API_KEY,
        "COINGECKO_API_KEY": COINGECKO_API_KEY,
        "STOCK_NEWS_API_KEY": STOCK_NEWS_API_KEY,
        "FINNHUB_API_KEY": FINNHUB_API_KEY,
        "NESTJS_API_URL": NESTJS_API_URL,
    }

    optional = {
        "INTERNAL_API_KEY": os.getenv("INTERNAL_API_KEY"),
        "OPENAI_API_KEY": os.getenv("OPENAI_API_KEY"),
        "BINANCE_API_KEY": os.getenv("BINANCE_API_KEY"),
        "ALPACA_API_KEY": os.getenv("ALPACA_API_KEY"),
    }

    for name, val in required.items():
        if val:
            log_result(f"ENV {name}", PASS, f"Set ({val[:8]}...)")
        else:
            log_result(f"ENV {name}", FAIL, "NOT SET - this API will not work")

    for name, val in optional.items():
        if val:
            log_result(f"ENV {name}", PASS, f"Set ({val[:8]}...)")
        else:
            log_result(f"ENV {name}", WARN, "Not set")


def test_lunarcrush():
    """Test LunarCrush API for crypto sentiment data."""
    print("\n=== 2. LunarCrush API (Crypto Sentiment) ===")
    import requests

    if not LUNARCRUSH_API_KEY:
        log_result("LunarCrush API", FAIL, "API key not set")
        return

    try:
        # Test coin data endpoint
        url = "https://lunarcrush.com/api4/public/coins/list/v2"
        headers = {"Authorization": f"Bearer {LUNARCRUSH_API_KEY}"}
        resp = requests.get(url, headers=headers, timeout=15)

        if resp.status_code == 200:
            data = resp.json()
            coins = data.get("data", [])
            log_result("LunarCrush coins list", PASS, f"Got {len(coins)} coins")

            if coins:
                sample = coins[0]
                log_result("LunarCrush coin sample", PASS,
                    f"symbol={sample.get('symbol')}, galaxy_score={sample.get('galaxy_score')}, "
                    f"alt_rank={sample.get('alt_rank')}")
        else:
            log_result("LunarCrush coins list", FAIL, f"HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log_result("LunarCrush API", FAIL, str(e))

    # Test coin-specific data (BTC)
    try:
        url = "https://lunarcrush.com/api4/public/coins/BTC/v1"
        headers = {"Authorization": f"Bearer {LUNARCRUSH_API_KEY}"}
        resp = requests.get(url, headers=headers, timeout=15)

        if resp.status_code == 200:
            data = resp.json().get("data", {})
            log_result("LunarCrush BTC data", PASS,
                f"price={data.get('price')}, galaxy_score={data.get('galaxy_score')}, "
                f"social_volume={data.get('social_volume')}")
        else:
            log_result("LunarCrush BTC data", FAIL, f"HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log_result("LunarCrush BTC data", FAIL, str(e))


def test_coingecko():
    """Test CoinGecko API for crypto fundamental data."""
    print("\n=== 3. CoinGecko API (Crypto Fundamentals) ===")
    import requests

    try:
        # CoinGecko simple price
        url = "https://api.coingecko.com/api/v3/simple/price"
        params = {"ids": "bitcoin", "vs_currencies": "usd", "include_24hr_vol": "true", "include_24hr_change": "true"}
        headers = {}
        if COINGECKO_API_KEY:
            headers["x-cg-demo-key"] = COINGECKO_API_KEY

        resp = requests.get(url, params=params, headers=headers, timeout=15)

        if resp.status_code == 200:
            data = resp.json()
            btc = data.get("bitcoin", {})
            log_result("CoinGecko BTC price", PASS,
                f"price=${btc.get('usd')}, vol=${btc.get('usd_24h_vol')}, change={btc.get('usd_24h_change')}%")
        else:
            log_result("CoinGecko BTC price", FAIL, f"HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log_result("CoinGecko BTC price", FAIL, str(e))

    # Test coin details (dev activity, etc.)
    try:
        url = "https://api.coingecko.com/api/v3/coins/bitcoin"
        params = {"localization": "false", "tickers": "false", "community_data": "true", "developer_data": "true"}
        headers = {}
        if COINGECKO_API_KEY:
            headers["x-cg-demo-key"] = COINGECKO_API_KEY

        resp = requests.get(url, params=params, headers=headers, timeout=15)

        if resp.status_code == 200:
            data = resp.json()
            dev = data.get("developer_data", {})
            log_result("CoinGecko BTC details", PASS,
                f"commits_4w={dev.get('commit_count_4_weeks')}, "
                f"market_cap_rank={data.get('market_cap_rank')}")
        elif resp.status_code == 429:
            log_result("CoinGecko BTC details", WARN, "Rate limited (429) - API key may need upgrading")
        else:
            log_result("CoinGecko BTC details", FAIL, f"HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log_result("CoinGecko BTC details", FAIL, str(e))


def test_stock_news():
    """Test Stock News API for stock sentiment data."""
    print("\n=== 4. Stock News API (Stock Sentiment) ===")
    import requests

    if not STOCK_NEWS_API_KEY:
        log_result("Stock News API", FAIL, "API key not set")
        return

    try:
        url = "https://stocknewsapi.com/api/v1"
        params = {
            "tickers": "AAPL",
            "items": 5,
            "token": STOCK_NEWS_API_KEY,
        }
        resp = requests.get(url, params=params, timeout=15)

        if resp.status_code == 200:
            data = resp.json()
            articles = data.get("data", [])
            log_result("Stock News AAPL", PASS, f"Got {len(articles)} articles")
            if articles:
                sample = articles[0]
                log_result("Stock News sample", PASS,
                    f"title={sample.get('title', '')[:80]}, sentiment={sample.get('sentiment')}")
        else:
            log_result("Stock News AAPL", FAIL, f"HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log_result("Stock News API", FAIL, str(e))


def test_finnhub():
    """Test Finnhub API for stock data."""
    print("\n=== 5. Finnhub API (Stock Data) ===")
    import requests

    if not FINNHUB_API_KEY:
        log_result("Finnhub API", FAIL, "API key not set")
        return

    try:
        url = "https://finnhub.io/api/v1/quote"
        params = {"symbol": "AAPL", "token": FINNHUB_API_KEY}
        resp = requests.get(url, params=params, timeout=15)

        if resp.status_code == 200:
            data = resp.json()
            log_result("Finnhub AAPL quote", PASS,
                f"current={data.get('c')}, high={data.get('h')}, low={data.get('l')}, "
                f"prev_close={data.get('pc')}")
        else:
            log_result("Finnhub AAPL quote", FAIL, f"HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        log_result("Finnhub API", FAIL, str(e))


def test_nestjs_candles():
    """Test NestJS system candles endpoint (OHLCV data for technical analysis)."""
    print("\n=== 6. NestJS System Candles (OHLCV Data) ===")
    import requests

    nestjs_url = NESTJS_API_URL.rstrip('/')

    # Test crypto candles (BTC via Binance)
    try:
        url = f"{nestjs_url}/candles/system/BTCUSDT"
        params = {"interval": "1d", "limit": "10", "asset_type": "crypto"}
        resp = requests.get(url, params=params, timeout=15)

        if resp.status_code == 200:
            data = resp.json()
            if data.get("success") and data.get("data"):
                candles = data["data"]
                sample = candles[0] if candles else {}
                log_result("NestJS crypto candles (BTC)", PASS,
                    f"Got {len(candles)} candles. Sample: open={sample.get('open')}, "
                    f"close={sample.get('close')}, volume={sample.get('volume')}")
            else:
                log_result("NestJS crypto candles (BTC)", FAIL, f"success=false or no data: {data}")
        else:
            log_result("NestJS crypto candles (BTC)", FAIL, f"HTTP {resp.status_code}: {resp.text[:200]}")
    except requests.ConnectionError:
        log_result("NestJS crypto candles (BTC)", FAIL,
            f"Connection refused at {nestjs_url} - NestJS server not running?")
    except Exception as e:
        log_result("NestJS crypto candles (BTC)", FAIL, str(e))

    # Test stock candles (AAPL via Alpaca)
    try:
        url = f"{nestjs_url}/candles/system/AAPL"
        params = {"interval": "1d", "limit": "10", "asset_type": "stock"}
        resp = requests.get(url, params=params, timeout=15)

        if resp.status_code == 200:
            data = resp.json()
            if data.get("success") and data.get("data"):
                candles = data["data"]
                sample = candles[0] if candles else {}
                log_result("NestJS stock candles (AAPL)", PASS,
                    f"Got {len(candles)} candles. Sample: open={sample.get('open')}, "
                    f"close={sample.get('close')}, volume={sample.get('volume')}")
            else:
                log_result("NestJS stock candles (AAPL)", FAIL, f"success=false or no data: {data}")
        else:
            log_result("NestJS stock candles (AAPL)", FAIL, f"HTTP {resp.status_code}: {resp.text[:200]}")
    except requests.ConnectionError:
        log_result("NestJS stock candles (AAPL)", FAIL,
            f"Connection refused at {nestjs_url} - NestJS server not running?")
    except Exception as e:
        log_result("NestJS stock candles (AAPL)", FAIL, str(e))

    # Test multi-timeframe (what technical engine actually needs)
    for tf in ["1d", "4h", "1h"]:
        try:
            url = f"{nestjs_url}/candles/system/BTCUSDT"
            limit = 200 if tf != "1h" else 24
            params = {"interval": tf, "limit": str(limit), "asset_type": "crypto"}
            resp = requests.get(url, params=params, timeout=15)

            if resp.status_code == 200:
                data = resp.json()
                candles = data.get("data", [])
                log_result(f"NestJS BTC {tf} candles ({limit} req)", PASS, f"Got {len(candles)} candles")
            else:
                log_result(f"NestJS BTC {tf} candles", FAIL, f"HTTP {resp.status_code}")
        except requests.ConnectionError:
            log_result(f"NestJS BTC {tf} candles", FAIL, "NestJS not running")
        except Exception as e:
            log_result(f"NestJS BTC {tf} candles", FAIL, str(e))


def test_technical_engine():
    """Test the technical engine directly with fetched data."""
    print("\n=== 7. Technical Engine (Direct Test) ===")

    try:
        from src.services.engines.technical_engine import TechnicalEngine
        engine = TechnicalEngine()

        # Test with system candles (no connection_id = system mode)
        result = engine.calculate(
            asset_id="BTC",
            asset_type="crypto",
            timeframe="1d",
            ohlcv_data=None,
            connection_id=None,
            exchange="binance",
            asset_symbol="BTC"
        )

        score = result.get("score", 0)
        confidence = result.get("confidence", 0)
        metadata = result.get("metadata", {})
        indicators = metadata.get("indicators", {})
        data_available = metadata.get("data_available", True)
        multi_tf = metadata.get("multi_timeframe", False)

        if not data_available:
            log_result("Technical Engine BTC (system candles)", FAIL,
                f"No OHLCV data available. NestJS candles endpoint likely not running. "
                f"score={score}, confidence={confidence}")
        elif multi_tf:
            log_result("Technical Engine BTC (multi-TF)", PASS,
                f"score={score:.3f}, confidence={confidence:.3f}, multi_tf={multi_tf}")

            # Check indicator values
            ma20 = indicators.get("ma20")
            rsi = indicators.get("rsi_14")
            macd = indicators.get("macd")
            log_result("Technical indicators",
                PASS if any(v is not None for v in [ma20, rsi, macd]) else WARN,
                f"MA20={ma20}, RSI={rsi}, MACD={macd}")
        else:
            log_result("Technical Engine BTC (single-TF)", WARN,
                f"score={score:.3f}, confidence={confidence:.3f}, multi_tf=False (fallback mode)")
    except Exception as e:
        log_result("Technical Engine", FAIL, f"{e}\n{traceback.format_exc()}")


def test_sentiment_engine():
    """Test the sentiment engine directly."""
    print("\n=== 8. Sentiment Engine (Direct Test) ===")

    try:
        from src.services.engines.sentiment_engine import SentimentEngine
        engine = SentimentEngine()

        result = engine.calculate(
            asset_id="BTC",
            asset_type="crypto",
            timeframe="1d",
            text_data=None,
            asset_symbol="BTC"
        )

        score = result.get("score", 0)
        confidence = result.get("confidence", 0)
        error = result.get("error", False)

        if error:
            log_result("Sentiment Engine BTC", FAIL, f"Error: {result.get('error_message', 'unknown')}")
        else:
            log_result("Sentiment Engine BTC", PASS,
                f"score={score:.3f}, confidence={confidence:.3f}")
    except Exception as e:
        log_result("Sentiment Engine", FAIL, str(e))


def test_fundamental_engine():
    """Test the fundamental engine directly."""
    print("\n=== 9. Fundamental Engine (Direct Test) ===")

    try:
        from src.services.engines.fundamental_engine import FundamentalEngine
        engine = FundamentalEngine()

        # Test crypto
        result = engine.calculate(
            asset_id="BTC",
            asset_type="crypto",
            asset_symbol="BTC"
        )

        score = result.get("score", 0)
        confidence = result.get("confidence", 0)
        error = result.get("error", False)

        if error:
            log_result("Fundamental Engine BTC (crypto)", WARN, f"Error: {result.get('error_message', str(result))}")
        else:
            log_result("Fundamental Engine BTC (crypto)", PASS,
                f"score={score:.3f}, confidence={confidence:.3f}")
    except Exception as e:
        log_result("Fundamental Engine (crypto)", FAIL, str(e))

    # Test stock
    try:
        result = engine.calculate(
            asset_id="AAPL",
            asset_type="stock",
            asset_symbol="AAPL"
        )

        score = result.get("score", 0)
        error = result.get("error", False)

        if error:
            log_result("Fundamental Engine AAPL (stock)", WARN, f"Error: {result.get('error_message', str(result))}")
        else:
            log_result("Fundamental Engine AAPL (stock)", PASS, f"score={score:.3f}")
    except Exception as e:
        log_result("Fundamental Engine (stock)", FAIL, str(e))


def test_event_risk_engine():
    """Test the event risk engine directly."""
    print("\n=== 10. Event Risk Engine (Direct Test) ===")

    try:
        from src.services.engines.event_risk_engine import EventRiskEngine
        engine = EventRiskEngine()

        result = engine.calculate(
            asset_id="BTC",
            asset_type="crypto",
            asset_symbol="BTC"
        )

        score = result.get("score", 0)
        error = result.get("error", False)

        if error:
            log_result("Event Risk Engine BTC", WARN, f"Error: {result.get('error_message', str(result))}")
        else:
            log_result("Event Risk Engine BTC", PASS, f"score={score:.3f}")
    except Exception as e:
        log_result("Event Risk Engine", FAIL, str(e))


def test_signal_generation():
    """Test the full signal generation pipeline end-to-end."""
    print("\n=== 11. Full Signal Generation Pipeline ===")

    try:
        from src.services.strategies.signal_generator import SignalGenerator
        generator = SignalGenerator()

        # Test with a simple strategy (field-based rules like pre-built)
        strategy_data_prebuilt_style = {
            "entry_rules": [
                {"field": "final_score", "operator": ">", "value": 0.3}
            ],
            "exit_rules": [
                {"field": "final_score", "operator": "<", "value": -0.2}
            ],
            "timeframe": "1d",
            "engine_weights": {
                "sentiment": 0.35, "trend": 0.25, "fundamental": 0.15,
                "event_risk": 0.15, "liquidity": 0.10
            }
        }

        market_data = {"price": 65000, "volume_24h": 30000000000, "asset_type": "crypto"}

        signal = generator.generate_signal(
            strategy_id="test-prebuilt-style",
            asset_id="BTC",
            asset_type="crypto",
            strategy_data=strategy_data_prebuilt_style,
            market_data=market_data,
            asset_symbol="BTC"
        )

        action = signal.get("action", "ERROR")
        score = signal.get("final_score", 0)
        confidence = signal.get("confidence", 0)
        error = signal.get("error")
        engine_scores = signal.get("engine_scores", {})
        execution = signal.get("strategy_execution", {})

        log_result("Signal Gen (pre-built style rules)",
            PASS if not error else FAIL,
            f"action={action}, score={score:.3f}, conf={confidence:.3f}")

        # Print engine score breakdown
        for eng_name, eng_data in engine_scores.items():
            eng_score = eng_data.get("score", 0)
            log_result(f"  Engine: {eng_name}", PASS, f"score={eng_score:.3f}")

        # Check strategy execution details
        entry_met = execution.get("entry_conditions_met", False)
        exit_met = execution.get("exit_conditions_met", False)
        log_result("  Strategy execution", PASS,
            f"entry_met={entry_met}, exit_met={exit_met}, signal={execution.get('signal')}")

        # Now test with INDICATOR-based rules (like user custom strategies)
        print()
        strategy_data_custom = {
            "entry_rules": [
                {"indicator": "RSI", "operator": "<", "value": 70, "logic": "AND"},
                {"indicator": "MACD", "operator": ">", "value": -1000}
            ],
            "exit_rules": [],  # Empty exit rules - this was the Bug 1!
            "timeframe": "1d",
            "engine_weights": {
                "sentiment": 0.35, "trend": 0.25, "fundamental": 0.15,
                "event_risk": 0.15, "liquidity": 0.10
            }
        }

        signal2 = generator.generate_signal(
            strategy_id="test-custom-indicators",
            asset_id="BTC",
            asset_type="crypto",
            strategy_data=strategy_data_custom,
            market_data=market_data,
            asset_symbol="BTC"
        )

        action2 = signal2.get("action", "ERROR")
        score2 = signal2.get("final_score", 0)
        execution2 = signal2.get("strategy_execution", {})
        entry_details = execution2.get("entry_details", {})
        exit_details = execution2.get("exit_details", {})

        log_result("Signal Gen (indicator rules + empty exit)",
            PASS if action2 != "SELL" else FAIL,  # Should NOT be SELL (that was the bug)
            f"action={action2}, score={score2:.3f}")

        # Verify Bug 1 is fixed: empty exit rules should NOT trigger SELL
        exit_no_rules = exit_details.get("no_rules", False)
        log_result("  Bug 1 fix: empty exit rules",
            PASS if exit_no_rules else FAIL,
            f"no_rules={exit_no_rules}, all_met={exit_details.get('all_met')}")

        # Check if indicators were available
        indicators = execution2.get("indicators", {})
        rsi_val = indicators.get("RSI")
        macd_val = indicators.get("MACD")
        log_result("  Indicator values",
            PASS if rsi_val is not None else WARN,
            f"RSI={rsi_val}, MACD={macd_val}")

        # Check Bug 2/3 fix: if indicators missing, check if fusion fallback kicked in
        entry_all_skipped = entry_details.get("all_skipped", False)
        if entry_all_skipped:
            log_result("  Bug 2/3 fix: fusion fallback",
                PASS if action2 != "HOLD" or score2 < 0.3 else WARN,
                f"All indicators skipped -> fell back to fusion engine (action={action2})")
        else:
            log_result("  Indicator rules evaluated", PASS,
                f"entry_conditions_met={entry_details.get('all_met')}, "
                f"indicators_missing={entry_details.get('indicators_missing', 0)}")

    except Exception as e:
        log_result("Signal Generation Pipeline", FAIL, f"{e}\n{traceback.format_exc()}")


def print_summary():
    """Print final summary."""
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)

    passes = sum(1 for _, s, _ in results if s == PASS)
    fails = sum(1 for _, s, _ in results if s == FAIL)
    warns = sum(1 for _, s, _ in results if s == WARN)

    print(f"  Total: {len(results)} tests")
    print(f"  Passed: {passes}")
    print(f"  Failed: {fails}")
    print(f"  Warnings: {warns}")

    if fails > 0:
        print(f"\n  FAILURES:")
        for name, status, detail in results:
            if status == FAIL:
                print(f"    - {name}: {detail[:100]}")

    if warns > 0:
        print(f"\n  WARNINGS:")
        for name, status, detail in results:
            if status == WARN:
                print(f"    - {name}: {detail[:100]}")


if __name__ == "__main__":
    print("=" * 60)
    print("  Quantiva Data Pipeline Test")
    print("=" * 60)

    test_env_vars()
    test_lunarcrush()
    test_coingecko()
    test_stock_news()
    test_finnhub()
    test_nestjs_candles()
    test_technical_engine()
    test_sentiment_engine()
    test_fundamental_engine()
    test_event_risk_engine()
    test_signal_generation()

    print_summary()
