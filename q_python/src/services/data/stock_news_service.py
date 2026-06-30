"""
Stock News Service
Fetches stock market news from StockNewsAPI with automatic Finnhub fallback.

Hardened with:
- Process-wide singleton via `get_stock_news_service()`.
- `StockNewsQuotaGate` enforcing per-minute + per-month caps with
  file-persisted month counter.
- 2-hour TTL in-memory cache on `fetch_news` and `fetch_general_news`.
- Stale-cache fallback when the gate denies or the API returns 403.
- **Finnhub fallback** when StockNewsAPI is unavailable (403 quota-exhausted,
  5xx, network error, or our own quota gate blocking). The cache is source-
  agnostic, so callers always see a consistent response shape. Once
  StockNewsAPI recovers (e.g. after billing reset), the service resumes using
  it automatically — no config change needed.
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
    FINNHUB_API_KEY,
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
    FINNHUB_BASE_URL = "https://finnhub.io/api/v1"

    def __init__(self) -> None:
        self.logger = logging.getLogger(__name__)
        self.api_key = STOCK_NEWS_API_KEY
        self.finnhub_api_key = FINNHUB_API_KEY
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
            # Finnhub fallback stats
            "finnhub_calls_made": 0,
            "finnhub_errors": 0,
            "finnhub_fallbacks_served": 0,
        }

        if not self.api_key:
            self.logger.warning(
                "STOCK_NEWS_API_KEY not set. Stock news fetching will fail."
            )
        if not self.finnhub_api_key:
            self.logger.warning(
                "FINNHUB_API_KEY not set. Stock news fallback will not work when "
                "StockNewsAPI is unavailable."
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

    # Hard ceiling on distinct cached keys. Bounds memory even if the symbol
    # universe is large; entries past MAX_STALE_SECS are useless anyway since
    # _read_cache refuses to return them. Must comfortably exceed the active
    # stock universe (~540) so the cache doesn't thrash and re-fetch every run —
    # at 500 it was smaller than the universe, which defeated the 24h TTL and
    # burned the StockNews monthly quota. (Now keyed by symbol only, so one
    # entry per ticker.)
    _CACHE_MAX_ENTRIES = 1500

    def _put_cache(self, key: str, items: List[Dict[str, Any]]) -> None:
        """Write a cache entry and opportunistically evict.

        The old code wrote to a plain dict with no eviction, so the cache grew
        for the life of the process (every distinct ticker leaked a list of up
        to 50 article dicts). LunarCrushService already evicts; this brings the
        stock-news cache to parity.
        """
        self._news_cache[key] = (items, time.time())
        if len(self._news_cache) > self._CACHE_MAX_ENTRIES:
            self._cleanup_cache()

    def _cleanup_cache(self) -> None:
        """Drop unusable (beyond-max-stale) entries, then hard-cap the size."""
        now = time.time()
        expired = [
            k for k, (_, ts) in self._news_cache.items()
            if now - ts > self.MAX_STALE_SECS
        ]
        for k in expired:
            del self._news_cache[k]

        # If still over the ceiling, evict oldest-first until under it.
        overflow = len(self._news_cache) - self._CACHE_MAX_ENTRIES
        if overflow > 0:
            oldest = sorted(self._news_cache.items(), key=lambda kv: kv[1][1])
            for k, _ in oldest[:overflow]:
                del self._news_cache[k]

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
                        # StockNewsAPI returns each article with a `tickers` array
                        # (e.g. ["AAPL","MSFT","GOOGL"]). Previously we only kept
                        # `tickers[0]`, which caused AAPL/etc. to miss articles
                        # where they weren't listed first. Now we emit one item
                        # per ticker so each related stock gets the article. The
                        # NestJS side dedups by (asset_id, url) so this is safe.
                        raw_tickers = article.get("tickers", article.get("symbols", []))
                        if isinstance(raw_tickers, str):
                            tickers = [raw_tickers]
                        elif isinstance(raw_tickers, list):
                            tickers = [str(t) for t in raw_tickers if t]
                        else:
                            tickers = []

                        if not tickers:
                            item["symbol"] = "GENERAL"
                            items.append(item)
                        else:
                            for ticker in tickers:
                                item_copy = dict(item)
                                item_copy["symbol"] = ticker.upper()
                                items.append(item_copy)
                    else:
                        items.append(item)
            except Exception as e:
                self.logger.warning(f"Error parsing article: {e}")
                continue
        return items

    # ---- Finnhub fallback ----

    def _finnhub_article_to_item(
        self, article: Dict[str, Any], include_symbol: bool = False
    ) -> Optional[Dict[str, Any]]:
        """Normalize a Finnhub article to our standard news-item shape."""
        title = article.get("headline", "")
        summary = article.get("summary", "")
        if not (title or summary):
            return None
        ts = article.get("datetime")
        published_at: Optional[datetime] = None
        if isinstance(ts, (int, float)) and ts > 0:
            try:
                published_at = datetime.fromtimestamp(int(ts), tz=timezone.utc)
            except (OSError, OverflowError, ValueError):
                published_at = None
        item: Dict[str, Any] = {
            "title": title,
            "text": summary or title,
            "source": article.get("source", "finnhub"),
            "published_at": published_at,
            "url": article.get("url", ""),
        }
        if include_symbol:
            related = article.get("related", "")
            if isinstance(related, str):
                tickers = [t.strip().upper() for t in related.split(",") if t.strip()]
            elif isinstance(related, list):
                tickers = [str(t).upper() for t in related if t]
            else:
                tickers = []
            item["symbol"] = tickers[0] if tickers else "GENERAL"
        return item

    def _fetch_news_via_finnhub_company(
        self, symbol: str, limit: int
    ) -> List[Dict[str, Any]]:
        """Fetch per-ticker news from Finnhub's /company-news endpoint.

        Called only as a fallback when StockNewsAPI is unavailable. Raises
        on HTTP/network error so the caller can decide whether to serve
        stale cache or an empty list.
        """
        if not self.finnhub_api_key:
            raise RuntimeError("FINNHUB_API_KEY not configured")
        # 7-day window. As the fallback (used heavily whenever StockNews is
        # unavailable — e.g. monthly quota exhausted), a narrow 2-day window
        # returned 0 items for the many less-covered tickers, leaving the
        # sentiment/event-risk engines with no news at all. A week is wide
        # enough that most tickers surface something while still recent; Finnhub
        # sorts by recency and callers cap results further via `limit`.
        now = datetime.now(timezone.utc)
        window_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        from datetime import timedelta as _td
        window_start = window_start - _td(days=7)
        params = {
            "symbol": symbol.upper(),
            "from": window_start.strftime("%Y-%m-%d"),
            "to": now.strftime("%Y-%m-%d"),
            "token": self.finnhub_api_key,
        }
        self.logger.info(f"Finnhub fallback: fetching company news for {symbol}")
        response = requests.get(
            f"{self.FINNHUB_BASE_URL}/company-news", params=params, timeout=30
        )
        response.raise_for_status()
        data = response.json()
        self._bump("finnhub_calls_made")
        articles = data if isinstance(data, list) else []
        items: List[Dict[str, Any]] = []
        for a in articles[: max(1, limit)]:
            it = self._finnhub_article_to_item(a, include_symbol=False)
            if it:
                items.append(it)
        self.logger.info(f"Finnhub fallback returned {len(items)} items for {symbol}")
        return items

    def _fetch_news_via_finnhub_general(self, limit: int) -> List[Dict[str, Any]]:
        """Fetch general US market news from Finnhub's /news endpoint.

        Called only as a fallback when StockNewsAPI is unavailable.
        """
        if not self.finnhub_api_key:
            raise RuntimeError("FINNHUB_API_KEY not configured")
        params = {"category": "general", "token": self.finnhub_api_key}
        self.logger.info("Finnhub fallback: fetching general market news")
        response = requests.get(
            f"{self.FINNHUB_BASE_URL}/news", params=params, timeout=30
        )
        response.raise_for_status()
        data = response.json()
        self._bump("finnhub_calls_made")
        articles = data if isinstance(data, list) else []
        items: List[Dict[str, Any]] = []
        for a in articles[: max(1, limit)]:
            it = self._finnhub_article_to_item(a, include_symbol=True)
            if it:
                items.append(it)
        self.logger.info(f"Finnhub fallback returned {len(items)} general items")
        return items

    def _serve_fallback_or_stale(
        self,
        cache_key: str,
        stale: Optional[List[Dict[str, Any]]],
        finnhub_fetch_fn,
    ) -> List[Dict[str, Any]]:
        """Primary (StockNewsAPI) just failed or was blocked. Try Finnhub
        fallback; on success cache & return, on failure serve stale or []."""
        try:
            items = finnhub_fetch_fn()
        except Exception as e:
            self._bump("finnhub_errors")
            self.logger.warning(f"Finnhub fallback failed: {e}")
            items = []

        if items:
            self._bump("finnhub_fallbacks_served")
            self._put_cache(cache_key, items)
            return items

        if stale is not None:
            self._bump("served_stale")
            return stale
        return []

    # ---- public API ----

    def fetch_news(
        self,
        symbol: str,
        limit: int = 50,
        items: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch news for a single stock symbol.

        Primary source: StockNewsAPI (cached + gated).
        Fallback: Finnhub /company-news, invoked on ANY StockNewsAPI failure
        mode — 403 quota exhaustion, 5xx, network error, OR our own quota
        gate blocking the call. The cache is source-agnostic so callers see
        a consistent shape regardless of which upstream served the data.
        """
        # Cache by SYMBOL ONLY (not symbol+limit). The SentimentEngine asks for
        # limit=50 and the EventRiskEngine for limit=100 on the SAME ticker, so
        # keying by limit produced two separate cache entries — and therefore
        # two StockNewsAPI calls per stock per run. Keying by symbol lets the
        # first fetch serve both callers. We over-fetch a generous fixed count
        # (StockNews bills per CALL, not per item, so this is free) and slice to
        # each caller's `limit` on return.
        cache_key = symbol.upper()
        fetch_items = max(limit, 100)

        # 1. Fresh cache — source-agnostic, works for both SNAPI and Finnhub data
        fresh, stale = self._read_cache(cache_key)
        if fresh is not None:
            self._bump("cache_hits")
            return fresh[:limit]

        self._bump("cache_misses")

        fallback_fn = lambda: self._fetch_news_via_finnhub_company(symbol, fetch_items)

        # 2. If StockNewsAPI is unconfigured, go straight to Finnhub
        if not self.api_key:
            self.logger.info(
                "STOCK_NEWS_API_KEY not configured; using Finnhub fallback directly"
            )
            return self._serve_fallback_or_stale(cache_key, stale, fallback_fn)[:limit]

        # 3. Respect our own quota gate. If blocked, go to Finnhub.
        if not self._gate.try_acquire():
            self._bump("blocked_by_quota")
            self.logger.warning(
                f"StockNews quota exhausted for {symbol}; trying Finnhub fallback"
            )
            return self._serve_fallback_or_stale(cache_key, stale, fallback_fn)[:limit]

        # 4. Primary: StockNewsAPI
        try:
            params = {
                "tickers": symbol.upper(),
                "items": str(fetch_items),
                "token": self.api_key,
            }
            self.logger.info(f"Fetching news for {symbol} from StockNewsAPI...")
            response = requests.get(self.BASE_URL, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()
            news_items = self._parse_articles(data, fetch_items)

            self._bump("calls_made")
            self._put_cache(cache_key, news_items)
            self.logger.info(f"Fetched {len(news_items)} news items for {symbol}")
            return news_items[:limit]

        except requests.exceptions.HTTPError as e:
            status = getattr(e.response, "status_code", None) if hasattr(e, "response") else None
            if status == 403:
                self._bump("http_403s")
                self._gate.force_minute_drain()
                self.logger.warning(
                    f"StockNewsAPI 403 (quota exhausted) for {symbol}; trying Finnhub fallback"
                )
            else:
                self.logger.error(
                    f"HTTPError fetching stock news for {symbol}: {e}; trying Finnhub fallback"
                )
            return self._serve_fallback_or_stale(cache_key, stale, fallback_fn)[:limit]
        except requests.exceptions.RequestException as e:
            self.logger.error(
                f"Network error fetching stock news for {symbol}: {e}; trying Finnhub fallback"
            )
            return self._serve_fallback_or_stale(cache_key, stale, fallback_fn)[:limit]
        except Exception as e:
            self.logger.error(f"Unexpected error fetching stock news: {e}", exc_info=True)
            return self._serve_fallback_or_stale(cache_key, stale, fallback_fn)[:limit]

    def fetch_company_news(self, symbol: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Alias for fetch_news."""
        return self.fetch_news(symbol, limit=limit, items="news")

    def fetch_general_news(
        self, limit: int = 50, tickers: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """Fetch general stock market news for multiple tickers.

        Primary source: StockNewsAPI /api/v1?tickers=CSV (cached + gated).
        Fallback: Finnhub /news?category=general on ANY StockNewsAPI failure
        (403, 5xx, network error, or our own gate blocking).
        """
        popular_tickers = tickers or ["AAPL", "TSLA", "GOOGL", "AMZN", "MSFT"]
        cache_key = f"__general__:{','.join(sorted(t.upper() for t in popular_tickers))}_{limit}"

        fresh, stale = self._read_cache(cache_key)
        if fresh is not None:
            self._bump("cache_hits")
            return fresh

        self._bump("cache_misses")

        fallback_fn = lambda: self._fetch_news_via_finnhub_general(limit)

        if not self.api_key:
            self.logger.info(
                "STOCK_NEWS_API_KEY not configured; using Finnhub fallback for general news"
            )
            return self._serve_fallback_or_stale(cache_key, stale, fallback_fn)[:limit]

        if not self._gate.try_acquire():
            self._bump("blocked_by_quota")
            self.logger.warning(
                "StockNews quota exhausted for general news; trying Finnhub fallback"
            )
            return self._serve_fallback_or_stale(cache_key, stale, fallback_fn)[:limit]

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
            self._put_cache(cache_key, news_items)
            self.logger.info(f"Fetched {len(news_items)} general stock news items")
            return news_items

        except requests.exceptions.HTTPError as e:
            status = getattr(e.response, "status_code", None) if hasattr(e, "response") else None
            if status == 403:
                self._bump("http_403s")
                self._gate.force_minute_drain()
                self.logger.warning(
                    "StockNewsAPI 403 on general news; trying Finnhub fallback"
                )
            else:
                self.logger.error(
                    f"HTTPError fetching general stock news: {e}; trying Finnhub fallback"
                )
            return self._serve_fallback_or_stale(cache_key, stale, fallback_fn)[:limit]
        except requests.exceptions.RequestException as e:
            self.logger.error(
                f"Network error fetching general stock news: {e}; trying Finnhub fallback"
            )
            return self._serve_fallback_or_stale(cache_key, stale, fallback_fn)[:limit]
        except Exception as e:
            self.logger.error(f"Unexpected error: {e}", exc_info=True)
            return self._serve_fallback_or_stale(cache_key, stale, fallback_fn)[:limit]


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
