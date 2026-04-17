"""
Stock News Service
Fetches stock market news from StockNewsAPI.

Hardened with:
- Process-wide singleton via `get_stock_news_service()`.
- `StockNewsQuotaGate` enforcing per-minute + per-month caps with
  file-persisted month counter.
- 2-hour TTL in-memory cache on `fetch_news` and `fetch_general_news`.
- Stale-cache fallback when the gate denies or the API returns 403.
"""
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests

from src.config import (
    STOCK_NEWS_API_KEY,
    STOCKNEWS_CACHE_TTL_SECS,
    STOCKNEWS_MAX_STALE_SECS,
    STOCKNEWS_MONTHLY_BUDGET,
    STOCKNEWS_QUOTA_STATE_PATH,
    STOCKNEWS_RPM_LIMIT,
)

logger = logging.getLogger(__name__)


class StockNewsQuotaGate:
    """
    Hard rate-limit shield for StockNewsAPI.

    Per-minute token bucket + per-month counter. Same architecture as
    ``CoinGeckoQuotaGate`` and ``LunarCrushQuotaGate``.
    """

    def __init__(self, rpm: int, monthly: int, state_path: str) -> None:
        self._rpm = max(1, int(rpm))
        self._monthly = max(1, int(monthly))
        self._state_path = state_path
        self._lock = threading.Lock()
        self._logger = logging.getLogger(__name__ + ".StockNewsQuotaGate")

        self._minute_tokens = self._rpm
        self._minute_window = self._current_minute()

        self._month = self._current_month()
        self._month_count = 0
        self._load_state()

    @staticmethod
    def _current_minute() -> int:
        return int(time.time()) // 60

    @staticmethod
    def _current_month() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m")

    def _load_state(self) -> None:
        try:
            if not os.path.exists(self._state_path):
                return
            with open(self._state_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("month") == self._month:
                self._month_count = int(data.get("count", 0))
                self._logger.info(
                    f"Loaded StockNews quota state: month={self._month} count={self._month_count}"
                )
            else:
                self._logger.info(
                    f"StockNews quota state file is from {data.get('month')}, "
                    f"current month is {self._month}; starting fresh."
                )
        except Exception as e:
            self._logger.warning(f"Could not load StockNews quota state: {e}")

    def _save_state(self) -> None:
        try:
            os.makedirs(os.path.dirname(self._state_path), exist_ok=True)
            tmp = self._state_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"month": self._month, "count": self._month_count}, f)
            os.replace(tmp, self._state_path)
        except Exception as e:
            self._logger.warning(f"Could not persist StockNews quota state: {e}")

    def _refresh_windows_locked(self) -> None:
        now_minute = self._current_minute()
        if now_minute != self._minute_window:
            self._minute_window = now_minute
            self._minute_tokens = self._rpm
        now_month = self._current_month()
        if now_month != self._month:
            self._month = now_month
            self._month_count = 0
            self._save_state()

    def try_acquire(self) -> bool:
        with self._lock:
            self._refresh_windows_locked()
            if self._month_count >= self._monthly:
                return False
            if self._minute_tokens <= 0:
                return False
            self._minute_tokens -= 1
            self._month_count += 1
            self._save_state()
            return True

    def force_minute_drain(self) -> None:
        with self._lock:
            self._refresh_windows_locked()
            self._minute_tokens = 0

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            self._refresh_windows_locked()
            return {
                "month": self._month,
                "month_count": self._month_count,
                "month_budget": self._monthly,
                "minute_tokens": self._minute_tokens,
                "minute_capacity": self._rpm,
            }


class StockNewsService:
    """
    Service for fetching stock market news from StockNewsAPI.

    Always go through `get_stock_news_service()` — never instantiate directly.
    """

    BASE_URL = "https://stocknewsapi.com/api/v1"

    def __init__(self) -> None:
        self.logger = logging.getLogger(__name__)
        self.api_key = STOCK_NEWS_API_KEY
        self.CACHE_TTL = STOCKNEWS_CACHE_TTL_SECS
        self.MAX_STALE_SECS = STOCKNEWS_MAX_STALE_SECS

        self._news_cache: Dict[str, Tuple[List[Dict[str, Any]], float]] = {}

        self._gate = StockNewsQuotaGate(
            rpm=STOCKNEWS_RPM_LIMIT,
            monthly=STOCKNEWS_MONTHLY_BUDGET,
            state_path=STOCKNEWS_QUOTA_STATE_PATH,
        )

        self._stats_lock = threading.Lock()
        self.stats: Dict[str, int] = {
            "calls_made": 0,
            "blocked_by_quota": 0,
            "served_stale": 0,
            "cache_hits": 0,
            "cache_misses": 0,
            "http_403s": 0,
        }

        if not self.api_key:
            self.logger.warning(
                "STOCK_NEWS_API_KEY not set. Stock news fetching will fail."
            )

    # ---- helpers ----

    def _bump(self, key: str, n: int = 1) -> None:
        with self._stats_lock:
            self.stats[key] = self.stats.get(key, 0) + n

    def get_stats(self) -> Dict[str, Any]:
        with self._stats_lock:
            snap = dict(self.stats)
        return {
            "stats": snap,
            "quota": self._gate.snapshot(),
            "cache_size": len(self._news_cache),
        }

    def _read_cache(
        self, key: str
    ) -> Tuple[Optional[List[Dict[str, Any]]], Optional[List[Dict[str, Any]]]]:
        entry = self._news_cache.get(key)
        if not entry:
            return None, None
        data, ts = entry
        age = time.time() - ts
        if age < self.CACHE_TTL:
            return data, None
        if age < self.MAX_STALE_SECS:
            return None, data
        return None, None

    def _parse_date(self, date_str: str) -> Optional[datetime]:
        if not date_str:
            return None
        for fmt in [
            "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ",
            "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y",
        ]:
            try:
                return datetime.strptime(date_str, fmt)
            except ValueError:
                continue
        try:
            from dateutil import parser
            return parser.parse(date_str)
        except (ImportError, ValueError):
            pass
        self.logger.warning(f"Could not parse date: {date_str}")
        return None

    def _parse_articles(
        self, data: Any, limit: int, include_symbol: bool = False
    ) -> List[Dict[str, Any]]:
        if isinstance(data, dict):
            articles = data.get("data", data.get("news", data.get("results", data.get("articles", []))))
            if not articles and any(k in data for k in ("title", "headline", "text")):
                articles = [data]
        elif isinstance(data, list):
            articles = data
        else:
            articles = []

        items: List[Dict[str, Any]] = []
        for article in articles[:limit]:
            try:
                title = article.get("title", article.get("headline", ""))
                text = article.get("text", article.get("description", article.get("summary", "")))
                source = article.get("source", article.get("source_name", "unknown"))
                url = article.get("url", article.get("link", ""))
                date_str = article.get("date", article.get("published_at", article.get("published_date", "")))
                published_at = self._parse_date(date_str)

                if title or text:
                    item: Dict[str, Any] = {
                        "title": title,
                        "text": text or title,
                        "source": source,
                        "published_at": published_at,
                        "url": url,
                    }
                    if include_symbol:
                        tickers = article.get("tickers", article.get("symbols", []))
                        if isinstance(tickers, str):
                            tickers = [tickers]
                        item["symbol"] = tickers[0] if tickers else "GENERAL"
                    items.append(item)
            except Exception as e:
                self.logger.warning(f"Error parsing article: {e}")
                continue
        return items

    # ---- public API ----

    def fetch_news(
        self,
        symbol: str,
        limit: int = 50,
        items: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch news for a single stock symbol. Cached + gated."""
        if not self.api_key:
            self.logger.error("STOCK_NEWS_API_KEY not configured")
            return []

        cache_key = f"{symbol.upper()}_{limit}"

        # 1. Fresh cache
        fresh, stale = self._read_cache(cache_key)
        if fresh is not None:
            self._bump("cache_hits")
            return fresh

        self._bump("cache_misses")

        # 2. Quota gate
        if not self._gate.try_acquire():
            self._bump("blocked_by_quota")
            if stale is not None:
                self._bump("served_stale")
                self.logger.warning(f"StockNews quota exhausted; serving stale for {symbol}")
                return stale
            self.logger.warning(f"StockNews quota exhausted; no stale for {symbol}")
            return []

        # 3. HTTP call
        try:
            params = {
                "tickers": symbol.upper(),
                "items": str(limit) if limit else (items or "10"),
                "token": self.api_key,
            }
            self.logger.info(f"Fetching news for {symbol} from StockNewsAPI...")
            response = requests.get(self.BASE_URL, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()
            news_items = self._parse_articles(data, limit)

            self._bump("calls_made")
            self._news_cache[cache_key] = (news_items, time.time())
            self.logger.info(f"Fetched {len(news_items)} news items for {symbol}")
            return news_items

        except requests.exceptions.HTTPError as e:
            status = getattr(e.response, "status_code", None) if hasattr(e, "response") else None
            if status == 403:
                self._bump("http_403s")
                self._gate.force_minute_drain()
                self.logger.warning(f"StockNewsAPI 403 (quota exhausted) for {symbol}")
            else:
                self.logger.error(f"HTTPError fetching stock news for {symbol}: {e}")
            if stale is not None:
                self._bump("served_stale")
                return stale
            return []
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Network error fetching stock news for {symbol}: {e}")
            if stale is not None:
                self._bump("served_stale")
                return stale
            return []
        except Exception as e:
            self.logger.error(f"Unexpected error fetching stock news: {e}", exc_info=True)
            if stale is not None:
                self._bump("served_stale")
                return stale
            return []

    def fetch_company_news(self, symbol: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Alias for fetch_news."""
        return self.fetch_news(symbol, limit=limit, items="news")

    def fetch_general_news(
        self, limit: int = 50, tickers: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """Fetch general stock market news for multiple tickers. Cached + gated."""
        if not self.api_key:
            self.logger.error("STOCK_NEWS_API_KEY not configured")
            return []

        popular_tickers = tickers or ["AAPL", "TSLA", "GOOGL", "AMZN", "MSFT"]
        cache_key = f"__general__:{','.join(sorted(t.upper() for t in popular_tickers))}_{limit}"

        fresh, stale = self._read_cache(cache_key)
        if fresh is not None:
            self._bump("cache_hits")
            return fresh

        self._bump("cache_misses")

        if not self._gate.try_acquire():
            self._bump("blocked_by_quota")
            if stale is not None:
                self._bump("served_stale")
                self.logger.warning("StockNews quota exhausted; serving stale general news")
                return stale
            return []

        try:
            tickers_str = ",".join(t.upper() for t in popular_tickers)
            params = {
                "tickers": tickers_str,
                "items": str(limit),
                "token": self.api_key,
            }
            self.logger.info(f"Fetching general stock news for {len(popular_tickers)} tickers...")
            response = requests.get(self.BASE_URL, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()
            news_items = self._parse_articles(data, limit, include_symbol=True)

            self._bump("calls_made")
            self._news_cache[cache_key] = (news_items, time.time())
            self.logger.info(f"Fetched {len(news_items)} general stock news items")
            return news_items

        except requests.exceptions.HTTPError as e:
            status = getattr(e.response, "status_code", None) if hasattr(e, "response") else None
            if status == 403:
                self._bump("http_403s")
                self._gate.force_minute_drain()
                self.logger.warning("StockNewsAPI 403 (quota exhausted) on general news")
            else:
                self.logger.error(f"HTTPError fetching general stock news: {e}")
            if stale is not None:
                self._bump("served_stale")
                return stale
            return []
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Network error fetching general stock news: {e}")
            if stale is not None:
                self._bump("served_stale")
                return stale
            return []
        except Exception as e:
            self.logger.error(f"Unexpected error: {e}", exc_info=True)
            if stale is not None:
                self._bump("served_stale")
                return stale
            return []


# --------------------------------------------------------------------------
# Singleton accessor
# --------------------------------------------------------------------------

_singleton_lock = threading.Lock()
_singleton: Optional["StockNewsService"] = None


def get_stock_news_service() -> "StockNewsService":
    """Return the process-wide StockNewsService, creating it on first use."""
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = StockNewsService()
    return _singleton
