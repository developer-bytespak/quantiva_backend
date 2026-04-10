"""
LunarCrush Service
Fetches cryptocurrency news and social metrics from LunarCrush API v4.
"""
import json
import logging
import os
import requests
import threading
import time
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime, timezone
from src.config import (
    LUNARCRUSH_API_KEY,
    LUNARCRUSH_RPM_LIMIT,
    LUNARCRUSH_DAILY_BUDGET,
    LUNARCRUSH_SOCIAL_TTL_SECS,
    LUNARCRUSH_NEWS_TTL_SECS,
    LUNARCRUSH_MAX_STALE_SECS,
    LUNARCRUSH_QUOTA_STATE_PATH,
)

try:
    from src.services.llm.openai_news_adapter import OpenAINewsAdapter
    OPENAI_AVAILABLE = True
except Exception as e:
    OPENAI_AVAILABLE = False
    logging.getLogger(__name__).warning(f"OpenAI not available for news description generation: {str(e)}")

logger = logging.getLogger(__name__)


class LunarCrushQuotaGate:
    """
    Hard rate-limit shield for the LunarCrush API.

    Enforces both a per-minute token bucket and a per-day budget so the
    backend can never exceed the plan limits regardless of how many
    callers fan in. The per-day counter is persisted to disk so process
    restarts do not reset the budget mid-day.

    Thread-safe (uses a single ``threading.Lock``). Designed for the
    sync ``requests``-based service that runs on FastAPI's threadpool.
    """

    def __init__(
        self,
        rpm: int,
        daily: int,
        state_path: str,
    ) -> None:
        self._rpm = max(1, int(rpm))
        self._daily = max(1, int(daily))
        self._state_path = state_path
        self._lock = threading.Lock()
        self._logger = logging.getLogger(__name__ + ".LunarCrushQuotaGate")

        # Per-minute token bucket: tokens reset to capacity at the next
        # wall-clock minute boundary (matches the API's reset semantics).
        self._minute_tokens = self._rpm
        self._minute_window = self._current_minute()

        # Per-day counter, loaded from disk if a state file exists.
        self._day = self._current_day()
        self._day_count = 0
        self._load_state()

    # ---------- internal helpers ----------

    @staticmethod
    def _current_minute() -> int:
        return int(time.time()) // 60

    @staticmethod
    def _current_day() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def _load_state(self) -> None:
        try:
            if not os.path.exists(self._state_path):
                return
            with open(self._state_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("day") == self._day:
                self._day_count = int(data.get("count", 0))
                self._logger.info(
                    f"Loaded LunarCrush quota state: day={self._day} count={self._day_count}"
                )
            else:
                # Stale day in file -> ignore (will be overwritten on next commit)
                self._logger.info(
                    f"LunarCrush quota state file is from {data.get('day')}, "
                    f"current day is {self._day}; starting fresh."
                )
        except Exception as e:
            self._logger.warning(
                f"Could not load LunarCrush quota state from {self._state_path}: {e}"
            )

    def _save_state(self) -> None:
        try:
            os.makedirs(os.path.dirname(self._state_path), exist_ok=True)
            tmp_path = self._state_path + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump({"day": self._day, "count": self._day_count}, f)
            os.replace(tmp_path, self._state_path)
        except Exception as e:
            self._logger.warning(
                f"Could not persist LunarCrush quota state to {self._state_path}: {e}"
            )

    def _refresh_windows_locked(self) -> None:
        """Reset minute / day counters if their windows have rolled over.
        Caller must hold ``self._lock``."""
        now_minute = self._current_minute()
        if now_minute != self._minute_window:
            self._minute_window = now_minute
            self._minute_tokens = self._rpm

        now_day = self._current_day()
        if now_day != self._day:
            self._day = now_day
            self._day_count = 0
            self._save_state()

    # ---------- public API ----------

    def try_acquire(self) -> bool:
        """
        Reserve one call against both the per-minute and per-day budgets.

        Returns ``True`` if a call may proceed (and decrements both
        budgets immediately). Returns ``False`` if either budget is
        exhausted; the caller should serve stale cache or empty result.

        Non-blocking by design: we never sleep waiting for the next
        minute window because that would stall FastAPI threadpool
        workers under load.
        """
        with self._lock:
            self._refresh_windows_locked()
            if self._day_count >= self._daily:
                return False
            if self._minute_tokens <= 0:
                return False
            self._minute_tokens -= 1
            self._day_count += 1
            self._save_state()
            return True

    def force_minute_drain(self) -> None:
        """
        Defense in depth: if the API itself returns 429 despite our
        gate, drop the in-memory minute bucket to 0 so subsequent
        callers in this minute window are denied immediately.
        """
        with self._lock:
            self._refresh_windows_locked()
            self._minute_tokens = 0

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            self._refresh_windows_locked()
            return {
                "day": self._day,
                "day_count": self._day_count,
                "day_budget": self._daily,
                "minute_tokens": self._minute_tokens,
                "minute_capacity": self._rpm,
            }


class LunarCrushService:
    """
    Service for fetching cryptocurrency news and social metrics from LunarCrush API v4.
    Includes rate limiting and caching to avoid 429 errors.
    """
    
    BASE_URL = "https://lunarcrush.com/api4"
    
    def __init__(self):
        """Initialize LunarCrushService."""
        self.logger = logging.getLogger(__name__)
        self.api_key = LUNARCRUSH_API_KEY

        # Initialize OpenAI for news description generation
        self.openai_adapter = None
        if OPENAI_AVAILABLE:
            try:
                self.openai_adapter = OpenAINewsAdapter()
                self.logger.info("OpenAI adapter initialized for news description generation")
            except Exception as e:
                self.logger.warning(f"Failed to initialize OpenAI adapter: {str(e)}")

        # In-memory cache. TTLs are env-overridable; defaults are tuned for the
        # 2,000 calls/day plan (see src/config.py).
        self._social_metrics_cache: Dict[str, Tuple[Any, float]] = {}
        self._news_cache: Dict[str, Tuple[Any, float]] = {}
        self.SOCIAL_METRICS_TTL = LUNARCRUSH_SOCIAL_TTL_SECS
        self.NEWS_TTL = LUNARCRUSH_NEWS_TTL_SECS
        self.MAX_STALE_SECS = LUNARCRUSH_MAX_STALE_SECS

        # Hard rate-limit shield (per-minute + per-day). All real network
        # calls must go through self._gate.try_acquire().
        self._gate = LunarCrushQuotaGate(
            rpm=LUNARCRUSH_RPM_LIMIT,
            daily=LUNARCRUSH_DAILY_BUDGET,
            state_path=LUNARCRUSH_QUOTA_STATE_PATH,
        )

        # In-flight request deduplication: when 5 engines all ask for
        # fetch_social_metrics("BTC") at the same time, only one HTTP call
        # is made and the rest wait on the Event.
        self._inflight_lock = threading.Lock()
        self._inflight_social: Dict[str, threading.Event] = {}
        self._inflight_news: Dict[str, threading.Event] = {}

        # Lightweight in-memory metrics. Read via get_stats().
        self._stats_lock = threading.Lock()
        self.stats = {
            "calls_made": 0,
            "blocked_by_quota": 0,
            "served_stale": 0,
            "cache_hits": 0,
            "cache_misses": 0,
            "dedup_saves": 0,
            "http_429s": 0,
        }

        if not self.api_key:
            self.logger.warning(
                "LUNARCRUSH_API_KEY not set. LunarCrush fetching will fail. "
                "Set LUNARCRUSH_API_KEY environment variable."
            )

    # ---------- internal helpers (caching / dedup / stats) ----------

    def _bump(self, key: str, n: int = 1) -> None:
        with self._stats_lock:
            self.stats[key] = self.stats.get(key, 0) + n

    def get_stats(self) -> Dict[str, Any]:
        """Return a snapshot of cache + quota usage for diagnostics."""
        with self._stats_lock:
            stats_snapshot = dict(self.stats)
        return {
            "stats": stats_snapshot,
            "quota": self._gate.snapshot(),
            "cache_sizes": {
                "social_metrics": len(self._social_metrics_cache),
                "news": len(self._news_cache),
            },
        }

    def _read_cache(
        self,
        cache: Dict[str, Tuple[Any, float]],
        key: str,
        ttl: int,
    ) -> Tuple[Optional[Any], Optional[Any]]:
        """
        Look up ``key`` in ``cache``.

        Returns ``(fresh, stale)``:
          * ``fresh`` — value if it is younger than ``ttl``, else ``None``
          * ``stale`` — value if it is older than ``ttl`` but still
            younger than ``MAX_STALE_SECS``, else ``None``
        """
        entry = cache.get(key)
        if not entry:
            return None, None
        data, timestamp = entry
        age = time.time() - timestamp
        if age < ttl:
            return data, None
        if age < self.MAX_STALE_SECS:
            return None, data
        return None, None

    def _acquire_inflight(
        self,
        inflight: Dict[str, threading.Event],
        key: str,
    ) -> Tuple[bool, Optional[threading.Event]]:
        """
        Try to claim ownership of an in-flight fetch for ``key``.

        Returns ``(is_owner, event)``:
          * ``(True, event)`` — caller should make the network request,
            then call ``_release_inflight(event)`` to wake waiters.
          * ``(False, event)`` — caller should ``event.wait(...)`` and
            then re-read the cache.
        """
        with self._inflight_lock:
            existing = inflight.get(key)
            if existing is not None:
                return False, existing
            event = threading.Event()
            inflight[key] = event
            return True, event

    def _release_inflight(
        self,
        inflight: Dict[str, threading.Event],
        key: str,
        event: threading.Event,
    ) -> None:
        with self._inflight_lock:
            # Only remove if it's still our event (defensive)
            if inflight.get(key) is event:
                del inflight[key]
        event.set()
    
    def _cleanup_cache(self):
        """Remove expired cache entries to prevent memory growth."""
        current_time = time.time()
        
        # Clean social metrics cache
        expired_keys = [
            key for key, (_, timestamp) in self._social_metrics_cache.items()
            if current_time - timestamp > self.SOCIAL_METRICS_TTL * 2
        ]
        for key in expired_keys:
            del self._social_metrics_cache[key]
        
        # Clean news cache
        expired_keys = [
            key for key, (_, timestamp) in self._news_cache.items()
            if current_time - timestamp > self.NEWS_TTL * 2
        ]
        for key in expired_keys:
            del self._news_cache[key]
    
    def _generate_description_with_openai(self, title: str, symbol: str) -> str:
        """
        Generate a brief news description using OpenAI API.
        Args:
            title: News title
            symbol: Cryptocurrency symbol (e.g., BTC, ETH)
        Returns:
            Generated description or empty string if generation fails
        """
        if not self.openai_adapter:
            return ""
        try:
            description = self.openai_adapter.generate_description(title, symbol)
            if description:
                return description
            return ""
        except Exception as e:
            self.logger.warning(f"Failed to generate description for '{title}' using OpenAI: {str(e)}")
            return ""

    def fetch_coin_news(
        self,
        symbol: str,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Fetch news for a cryptocurrency symbol.

        Caching, in-flight deduplication, and the per-minute / per-day
        quota gate are all enforced here. Network work is delegated to
        ``_fetch_news_http``. Returns ``[]`` (matching the legacy
        contract) when no data can be served.
        """
        if not self.api_key:
            self.logger.error("LUNARCRUSH_API_KEY not configured")
            return []

        cache_key = f"{symbol.upper()}_{limit}"

        # 1. Fresh cache hit
        fresh, stale = self._read_cache(self._news_cache, cache_key, self.NEWS_TTL)
        if fresh is not None:
            self._bump("cache_hits")
            self.logger.debug(f"Returning fresh cached news for {symbol}")
            return fresh

        # 2. In-flight dedup: if another thread is already fetching this
        # key, wait for it and read the cache rather than firing a duplicate.
        is_owner, event = self._acquire_inflight(self._inflight_news, cache_key)
        if not is_owner:
            event.wait(timeout=20)
            fresh2, stale2 = self._read_cache(self._news_cache, cache_key, self.NEWS_TTL)
            if fresh2 is not None:
                self._bump("dedup_saves")
                return fresh2
            if stale2 is not None:
                self._bump("served_stale")
                return stale2
            return []

        try:
            self._bump("cache_misses")

            # 3. Quota gate
            if not self._gate.try_acquire():
                self._bump("blocked_by_quota")
                if stale is not None:
                    self._bump("served_stale")
                    self.logger.warning(
                        f"LunarCrush quota exhausted; serving stale news for {symbol}"
                    )
                    return stale
                self.logger.warning(
                    f"LunarCrush quota exhausted and no stale news for {symbol}; returning empty list"
                )
                return []

            # 4. Make the call
            try:
                news_items = self._fetch_news_http(symbol, limit)
            except requests.exceptions.HTTPError as e:
                status = getattr(e.response, "status_code", None) if hasattr(e, "response") else None
                if status == 429:
                    self._bump("http_429s")
                    self._gate.force_minute_drain()
                    self.logger.warning(
                        f"LunarCrush returned 429 for {symbol} despite gate; draining minute bucket"
                    )
                else:
                    self.logger.error(f"HTTPError fetching news from LunarCrush: {e}")
                if stale is not None:
                    self._bump("served_stale")
                    return stale
                return []
            except requests.exceptions.RequestException as e:
                self.logger.error(f"Network error fetching news from LunarCrush: {e}")
                if stale is not None:
                    self._bump("served_stale")
                    return stale
                return []
            except Exception as e:
                self.logger.error(f"Unexpected error fetching news: {e}", exc_info=True)
                if stale is not None:
                    self._bump("served_stale")
                    return stale
                return []

            self._bump("calls_made")
            self._news_cache[cache_key] = (news_items, time.time())
            if len(self._news_cache) > 50:
                self._cleanup_cache()
            return news_items

        finally:
            self._release_inflight(self._inflight_news, cache_key, event)

    def _fetch_news_http(self, symbol: str, limit: int) -> List[Dict[str, Any]]:
        """Raw HTTP + parse for the LunarCrush news endpoint. Caller is
        responsible for caching, dedup, and quota enforcement."""
        url = f"{self.BASE_URL}/public/topic/{symbol.upper()}/news/v1"
        headers = {"Authorization": f"Bearer {self.api_key}"}

        self.logger.info(f"Fetching news for {symbol} from LunarCrush API v4...")
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        data = response.json()

        # Parse API v4 response format
        if isinstance(data, dict):
            articles = data.get("data", [])
            if not isinstance(articles, list):
                articles = []
            self.logger.info(f"LunarCrush returned {len(articles)} articles for {symbol}")
        elif isinstance(data, list):
            articles = data
        else:
            self.logger.warning(f"Unexpected response format from LunarCrush: {type(data)}")
            articles = []

        news_items: List[Dict[str, Any]] = []
        for article in articles[:limit]:
            try:
                title = article.get("post_title", article.get("title", ""))
                url_field = article.get(
                    "post_link", article.get("url", article.get("link", ""))
                )
                source = article.get(
                    "creator_display_name",
                    article.get("creator_name", article.get("source", "unknown")),
                )
                date_raw = article.get(
                    "date",
                    article.get(
                        "published_at",
                        article.get("post_created", article.get("created_at", None)),
                    ),
                )
                published_at: Optional[datetime] = None
                if date_raw:
                    if isinstance(date_raw, (int, float)):
                        published_at = datetime.fromtimestamp(date_raw, tz=timezone.utc)
                    elif isinstance(date_raw, str):
                        try:
                            if date_raw.isdigit():
                                published_at = datetime.fromtimestamp(int(date_raw), tz=timezone.utc)
                            else:
                                from dateutil import parser
                                published_at = parser.parse(date_raw)
                        except (ValueError, TypeError):
                            self.logger.warning(f"Could not parse date: {date_raw}")
                            published_at = None
                    elif isinstance(date_raw, datetime):
                        published_at = date_raw

                if not title:
                    continue

                # Retry OpenAI up to 3 times for description generation
                description = ""
                max_retries = 3
                for attempt in range(max_retries):
                    description = self._generate_description_with_openai(title, symbol)
                    if description:
                        break
                    self.logger.warning(
                        f"OpenAI failed to generate description for '{title}' "
                        f"(attempt {attempt + 1}/{max_retries})"
                    )
                    time.sleep(2 ** attempt)

                if not description:
                    self.logger.warning(
                        f"Skipping article for {symbol} (no OpenAI description): {title}"
                    )
                    continue

                news_items.append({
                    "title": title,
                    "text": description,
                    "source": source,
                    "published_at": published_at,
                    "url": url_field,
                })
            except Exception as e:
                self.logger.warning(f"Error parsing article: {e}")
                continue

        self.logger.info(f"Fetched {len(news_items)} news items for {symbol}")
        return news_items
    
    def fetch_social_metrics(
        self,
        symbol: str
    ) -> Dict[str, Any]:
        """
        Fetch social metrics for a cryptocurrency.

        Caching, in-flight deduplication, and the per-minute / per-day
        quota gate are all enforced here. Network work is delegated to
        ``_fetch_social_metrics_http``. Returns ``{}`` (matching the
        legacy contract) when no data can be served.
        """
        if not self.api_key:
            self.logger.error("LUNARCRUSH_API_KEY not configured")
            return {}

        cache_key = symbol.upper()

        # 1. Fresh cache hit
        fresh, stale = self._read_cache(
            self._social_metrics_cache, cache_key, self.SOCIAL_METRICS_TTL
        )
        if fresh is not None:
            self._bump("cache_hits")
            self.logger.debug(f"Returning fresh cached social metrics for {symbol}")
            return fresh

        # 2. In-flight dedup
        is_owner, event = self._acquire_inflight(self._inflight_social, cache_key)
        if not is_owner:
            event.wait(timeout=20)
            fresh2, stale2 = self._read_cache(
                self._social_metrics_cache, cache_key, self.SOCIAL_METRICS_TTL
            )
            if fresh2 is not None:
                self._bump("dedup_saves")
                return fresh2
            if stale2 is not None:
                self._bump("served_stale")
                return stale2
            return {}

        try:
            self._bump("cache_misses")

            # 3. Quota gate
            if not self._gate.try_acquire():
                self._bump("blocked_by_quota")
                if stale is not None:
                    self._bump("served_stale")
                    self.logger.warning(
                        f"LunarCrush quota exhausted; serving stale social metrics for {symbol}"
                    )
                    return stale
                self.logger.warning(
                    f"LunarCrush quota exhausted and no stale social metrics for {symbol}; returning empty dict"
                )
                return {}

            # 4. Make the call
            try:
                metrics = self._fetch_social_metrics_http(symbol)
            except requests.exceptions.HTTPError as e:
                status = getattr(e.response, "status_code", None) if hasattr(e, "response") else None
                if status == 429:
                    self._bump("http_429s")
                    self._gate.force_minute_drain()
                    self.logger.warning(
                        f"LunarCrush returned 429 for {symbol} despite gate; draining minute bucket"
                    )
                else:
                    self.logger.error(f"HTTPError fetching social metrics from LunarCrush: {e}")
                if stale is not None:
                    self._bump("served_stale")
                    return stale
                return {}
            except requests.exceptions.RequestException as e:
                self.logger.error(f"Network error fetching social metrics from LunarCrush: {e}")
                if stale is not None:
                    self._bump("served_stale")
                    return stale
                return {}
            except Exception as e:
                self.logger.error(f"Unexpected error fetching social metrics: {e}", exc_info=True)
                if stale is not None:
                    self._bump("served_stale")
                    return stale
                return {}

            self._bump("calls_made")
            self._social_metrics_cache[cache_key] = (metrics, time.time())
            if len(self._social_metrics_cache) > 50:
                self._cleanup_cache()
            return metrics

        finally:
            self._release_inflight(self._inflight_social, cache_key, event)

    def _fetch_social_metrics_http(self, symbol: str) -> Dict[str, Any]:
        """Raw HTTP + parse for the LunarCrush coins endpoint. Caller is
        responsible for caching, dedup, and quota enforcement."""
        url = f"{self.BASE_URL}/public/coins/{symbol.upper()}/v1"
        headers = {"Authorization": f"Bearer {self.api_key}"}

        self.logger.info(f"Fetching social metrics for {symbol} from LunarCrush API v4...")
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        data = response.json()

        metrics: Dict[str, Any] = {}
        if isinstance(data, dict):
            coin_data = data.get("data", data)
            if isinstance(coin_data, list) and len(coin_data) > 0:
                coin_data = coin_data[0]

            metrics = {
                "social_volume": coin_data.get(
                    "social_volume_24h",
                    coin_data.get(
                        "interactions_24h",
                        coin_data.get("social_mentions", coin_data.get("social_volume", 0)),
                    ),
                ),
                "social_score": float(
                    coin_data.get(
                        "sentiment",
                        coin_data.get("sentiment_score", coin_data.get("social_score", 0)),
                    )
                ),
                "galaxy_score": float(
                    coin_data.get(
                        "galaxy_score", coin_data.get("score", coin_data.get("galaxy", 0))
                    )
                ),
                "alt_rank": int(
                    coin_data.get(
                        "alt_rank", coin_data.get("altrank", coin_data.get("rank", 999999))
                    )
                ),
                "social_dominance": float(
                    coin_data.get(
                        "social_dominance",
                        coin_data.get("social_dominance_24h", coin_data.get("dominance", 0)),
                    )
                ),
                "price_change_24h": float(
                    coin_data.get(
                        "percent_change_24h",
                        coin_data.get(
                            "price_change_24h",
                            coin_data.get("change_24h", coin_data.get("price_change", 0)),
                        ),
                    )
                ),
                "volume_24h": float(
                    coin_data.get(
                        "volume_24h",
                        coin_data.get("volume_24h_usd", coin_data.get("volume", 0)),
                    )
                ),
                "interactions_24h": coin_data.get("interactions_24h", 0),
                "market_cap": float(coin_data.get("market_cap", 0)),
                "price": float(coin_data.get("price", coin_data.get("price_usd", 0))),
            }

        self.logger.info(f"Fetched social metrics for {symbol}")
        return metrics
    
    def _parse_date(self, date_str: str) -> Optional[datetime]:
        """
        Parse date string to datetime object.
        
        Args:
            date_str: Date string in various formats
        
        Returns:
            datetime object or None if parsing fails
        """
        if not date_str:
            return None
        
        # Try common date formats
        date_formats = [
            '%Y-%m-%d %H:%M:%S',
            '%Y-%m-%dT%H:%M:%S',
            '%Y-%m-%dT%H:%M:%SZ',
            '%Y-%m-%d',
            '%m/%d/%Y',
            '%d/%m/%Y'
        ]
        
        for fmt in date_formats:
            try:
                return datetime.strptime(date_str, fmt)
            except ValueError:
                continue
        
        # Try parsing ISO format with timezone
        try:
            from dateutil import parser
            return parser.parse(date_str)
        except (ImportError, ValueError):
            pass
        
        # Try Unix timestamp
        try:
            timestamp = int(date_str)
            return datetime.fromtimestamp(timestamp)
        except (ValueError, TypeError):
            pass
        
        self.logger.warning(f"Could not parse date: {date_str}")
        return None

