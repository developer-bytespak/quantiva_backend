"""
CoinGecko Service
Fetches cryptocurrency data including developer activity metrics from CoinGecko API.

Hardened with:
- Process-wide singleton via `get_coingecko_service()` so the per-minute quota
  bucket is shared across all callers.
- `CoinGeckoQuotaGate` enforcing per-minute (Pro plan: 500/min) and per-month
  (Pro Analyst: 500,000/month) caps with file-persisted month counter.
- 30-min TTL cache on `fetch_coin_details` so back-to-back dev/tokenomics calls
  for the same symbol fan out to a single underlying HTTP request.
- Long-lived (24h) cache on `_symbol_to_coin_id` so unmapped-symbol /search
  lookups happen at most once per symbol per day.
- Stale-cache fallback when the gate denies, matching the LunarCrush behavior.
"""
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import requests

from src.config import (
    COINGECKO_API_KEY,
    COINGECKO_DETAILS_TTL_SECS,
    COINGECKO_MAX_STALE_SECS,
    COINGECKO_MONTHLY_BUDGET,
    COINGECKO_QUOTA_STATE_PATH,
    COINGECKO_RPM_LIMIT,
)

logger = logging.getLogger(__name__)


class CoinGeckoQuotaGate:
    """
    Hard rate-limit shield for the CoinGecko API.

    Per-minute token bucket + per-month counter. The month counter is persisted
    to a JSON file so process restarts don't reset the budget mid-month.

    Thread-safe (single ``threading.Lock``). Same shape as
    ``LunarCrushQuotaGate``, intentionally — they could share an interface
    later if we want to factor out a generic gate.
    """

    def __init__(self, rpm: int, monthly: int, state_path: str) -> None:
        self._rpm = max(1, int(rpm))
        self._monthly = max(1, int(monthly))
        self._state_path = state_path
        self._lock = threading.Lock()
        self._logger = logging.getLogger(__name__ + ".CoinGeckoQuotaGate")

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
        # YYYY-MM in UTC. CoinGecko's monthly counter resets on the 1st UTC.
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
                    f"Loaded CoinGecko quota state: month={self._month} count={self._month_count}"
                )
            else:
                self._logger.info(
                    f"CoinGecko quota state file is from {data.get('month')}, "
                    f"current month is {self._month}; starting fresh."
                )
        except Exception as e:
            self._logger.warning(
                f"Could not load CoinGecko quota state from {self._state_path}: {e}"
            )

    def _save_state(self) -> None:
        try:
            os.makedirs(os.path.dirname(self._state_path), exist_ok=True)
            tmp_path = self._state_path + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump({"month": self._month, "count": self._month_count}, f)
            os.replace(tmp_path, self._state_path)
        except Exception as e:
            self._logger.warning(
                f"Could not persist CoinGecko quota state to {self._state_path}: {e}"
            )

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
        """Reserve one call against both windows. Returns False if either is exhausted."""
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
        """Defense in depth: drop the minute bucket to 0 if the API itself returned 429."""
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


class CoinGeckoService:
    """
    Service for fetching cryptocurrency data from CoinGecko API.

    Always go through `get_coingecko_service()` — never instantiate directly.
    """

    BASE_URL = "https://api.coingecko.com/api/v3"
    PRO_BASE_URL = "https://pro-api.coingecko.com/api/v3"

    # Symbol → CoinGecko id mapping for the most common coins. Anything not in
    # this map falls through to /search (which is now cached and gated).
    _SYMBOL_TO_ID_MAP: Dict[str, str] = {
        "BTC": "bitcoin", "ETH": "ethereum", "BNB": "binancecoin", "SOL": "solana",
        "XRP": "ripple", "ADA": "cardano", "DOGE": "dogecoin", "DOT": "polkadot",
        "MATIC": "matic-network", "AVAX": "avalanche-2", "LINK": "chainlink",
        "UNI": "uniswap", "ATOM": "cosmos", "LTC": "litecoin", "ETC": "ethereum-classic",
        "XLM": "stellar", "ALGO": "algorand", "VET": "vechain", "ICP": "internet-computer",
        "FIL": "filecoin", "TRX": "tron", "EOS": "eos", "AAVE": "aave",
        "MKR": "maker", "COMP": "compound-governance-token", "SUSHI": "sushi",
        "YFI": "yearn-finance", "SNX": "havven", "CRV": "curve-dao-token", "1INCH": "1inch",
    }

    # TTL for cached symbol → id mappings from /search (24h; coin IDs never change)
    _SYMBOL_ID_TTL_SECS = 24 * 3600

    def __init__(self) -> None:
        self.logger = logging.getLogger(__name__)
        self.api_key = COINGECKO_API_KEY
        self.is_pro_api = bool(self.api_key and self.api_key.startswith("CG-"))
        self.base_url = self.PRO_BASE_URL if self.is_pro_api else self.BASE_URL

        # 30-min TTL cache on coin details, keyed by coin_id (not symbol).
        self._details_cache: Dict[str, Tuple[Dict[str, Any], float]] = {}
        self.DETAILS_TTL = COINGECKO_DETAILS_TTL_SECS
        self.MAX_STALE_SECS = COINGECKO_MAX_STALE_SECS

        # 24h TTL cache on symbol → coin_id resolution
        self._symbol_id_cache: Dict[str, Tuple[Optional[str], float]] = {}

        # Hard quota shield
        self._gate = CoinGeckoQuotaGate(
            rpm=COINGECKO_RPM_LIMIT,
            monthly=COINGECKO_MONTHLY_BUDGET,
            state_path=COINGECKO_QUOTA_STATE_PATH,
        )

        # Lightweight metrics
        self._stats_lock = threading.Lock()
        self.stats: Dict[str, int] = {
            "calls_made": 0,
            "blocked_by_quota": 0,
            "served_stale": 0,
            "cache_hits": 0,
            "cache_misses": 0,
            "http_429s": 0,
            "search_calls": 0,
            "search_cache_hits": 0,
        }

        if not self.api_key:
            self.logger.warning(
                "COINGECKO_API_KEY not set. CoinGecko fetching will use the free, "
                "rate-limited host. Set COINGECKO_API_KEY for Pro access."
            )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _bump(self, key: str, n: int = 1) -> None:
        with self._stats_lock:
            self.stats[key] = self.stats.get(key, 0) + n

    def get_stats(self) -> Dict[str, Any]:
        with self._stats_lock:
            stats_snapshot = dict(self.stats)
        return {
            "stats": stats_snapshot,
            "quota": self._gate.snapshot(),
            "cache_sizes": {
                "details": len(self._details_cache),
                "symbol_id": len(self._symbol_id_cache),
            },
        }

    def _get_headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key and self.is_pro_api:
            headers["x-cg-pro-api-key"] = self.api_key
        return headers

    def _read_cache(
        self,
        cache: Dict[str, Tuple[Any, float]],
        key: str,
        ttl: int,
    ) -> Tuple[Optional[Any], Optional[Any]]:
        """Return (fresh, stale) values from `cache` for `key` (see LunarCrush impl)."""
        entry = cache.get(key)
        if not entry:
            return None, None
        data, ts = entry
        age = time.time() - ts
        if age < ttl:
            return data, None
        if age < self.MAX_STALE_SECS:
            return None, data
        return None, None

    # ------------------------------------------------------------------
    # Symbol → coin_id resolution
    # ------------------------------------------------------------------

    def _symbol_to_coin_id(self, symbol: str) -> Optional[str]:
        """Resolve a symbol to its CoinGecko id. Cached for 24h."""
        if not symbol:
            return None
        symbol_upper = symbol.upper()

        # 1. Hardcoded map
        if symbol_upper in self._SYMBOL_TO_ID_MAP:
            return self._SYMBOL_TO_ID_MAP[symbol_upper]

        # 2. Cached resolution (positive or negative)
        cache_key = f"symbol_id:{symbol_upper}"
        fresh, _stale = self._read_cache(self._symbol_id_cache, cache_key, self._SYMBOL_ID_TTL_SECS)
        if fresh is not None:
            self._bump("search_cache_hits")
            return fresh
        # Even if the only entry is stale, we'll try a fresh /search; symbol_id changes
        # are essentially never, so falling back to network is fine.

        # 3. Quota-gated /search call
        if not self._gate.try_acquire():
            self._bump("blocked_by_quota")
            self.logger.warning(
                f"CoinGecko quota exhausted; skipping /search for {symbol_upper}"
            )
            # Last-resort fallback: lowercase symbol as id (works for a few coins)
            return symbol.lower()

        try:
            url = f"{self.base_url}/search"
            response = requests.get(
                url, params={"query": symbol}, headers=self._get_headers(), timeout=10
            )
            self._bump("search_calls")
            if response.status_code == 429:
                self._bump("http_429s")
                self._gate.force_minute_drain()
                return symbol.lower()
            if response.status_code == 200:
                data = response.json()
                coins = data.get("coins", [])
                resolved = coins[0].get("id") if coins else symbol.lower()
                self._symbol_id_cache[cache_key] = (resolved, time.time())
                return resolved
        except Exception as e:
            self.logger.warning(f"Error searching for coin id for {symbol_upper}: {e}")

        # Cache the fallback too so we don't keep retrying
        fallback = symbol.lower()
        self._symbol_id_cache[cache_key] = (fallback, time.time())
        return fallback

    # ------------------------------------------------------------------
    # Coin details (cached + gated)
    # ------------------------------------------------------------------

    def fetch_coin_details(
        self,
        symbol: str,
        include_developer_data: bool = True,
    ) -> Dict[str, Any]:
        """
        Fetch detailed coin information including developer activity.

        Caching: keyed by coin_id (not symbol). The `include_developer_data`
        parameter is ignored for cache lookup — we always fetch with developer
        data and consumers that don't need it just ignore the field. This is
        deliberate: the alternative would be two cache entries per coin and
        the second (`include_developer_data=False`) call would still hit the
        network, defeating the dedup that this method exists to provide.
        """
        if not symbol:
            self.logger.error("Symbol is required")
            return {}

        coin_id = self._symbol_to_coin_id(symbol)
        if not coin_id:
            self.logger.error(f"Could not find coin ID for symbol: {symbol}")
            return {}

        # 1. Fresh cache hit
        fresh, stale = self._read_cache(self._details_cache, coin_id, self.DETAILS_TTL)
        if fresh is not None:
            self._bump("cache_hits")
            self.logger.debug(f"CoinGecko cache hit for {symbol} ({coin_id})")
            return fresh

        self._bump("cache_misses")

        # 2. Quota gate
        if not self._gate.try_acquire():
            self._bump("blocked_by_quota")
            if stale is not None:
                self._bump("served_stale")
                self.logger.warning(
                    f"CoinGecko quota exhausted; serving stale details for {symbol}"
                )
                return stale
            self.logger.warning(
                f"CoinGecko quota exhausted and no stale details for {symbol}; returning empty"
            )
            return {}

        # 3. Network call
        try:
            url = f"{self.base_url}/coins/{coin_id}"
            params = {
                "localization": "false",
                "tickers": "false",
                "market_data": "true",
                "community_data": "true",
                # Always fetch developer data so a single cached payload serves
                # both `get_developer_activity_score` and `get_tokenomics_score`.
                "developer_data": "true",
                "sparkline": "false",
            }
            self.logger.info(
                f"Fetching coin details for {symbol} (id={coin_id}) from CoinGecko..."
            )
            response = requests.get(
                url, params=params, headers=self._get_headers(), timeout=30
            )
            response.raise_for_status()
            data = response.json()

            result = {
                "id": data.get("id"),
                "symbol": (data.get("symbol") or "").upper(),
                "name": data.get("name", ""),
                "developer_data": data.get("developer_data", {}),
                "market_data": data.get("market_data", {}),
                "community_data": data.get("community_data", {}),
            }

            self._bump("calls_made")
            self._details_cache[coin_id] = (result, time.time())
            return result

        except requests.exceptions.HTTPError as e:
            status = getattr(e.response, "status_code", None) if hasattr(e, "response") else None
            if status == 429:
                self._bump("http_429s")
                self._gate.force_minute_drain()
                self.logger.warning(
                    f"CoinGecko returned 429 for {symbol} despite gate; draining minute bucket"
                )
            else:
                self.logger.error(f"HTTPError fetching coin details for {symbol}: {e}")
            if stale is not None:
                self._bump("served_stale")
                return stale
            return {}
        except requests.exceptions.RequestException as e:
            self.logger.error(f"Network error fetching coin details for {symbol}: {e}")
            if stale is not None:
                self._bump("served_stale")
                return stale
            return {}
        except Exception as e:
            self.logger.error(
                f"Unexpected error fetching coin details for {symbol}: {e}", exc_info=True
            )
            if stale is not None:
                self._bump("served_stale")
                return stale
            return {}

    # ------------------------------------------------------------------
    # Derived scores (read from cache)
    # ------------------------------------------------------------------

    def get_developer_activity_score(self, symbol: str) -> Dict[str, Any]:
        """
        Get developer activity metrics for a cryptocurrency.

        Calls fetch_coin_details which is cached, so back-to-back calls with
        get_tokenomics_score for the same symbol only fire one HTTP request.
        """
        coin_data = self.fetch_coin_details(symbol, include_developer_data=True)

        if not coin_data or not coin_data.get("developer_data"):
            self.logger.warning(f"No developer data available for {symbol}")
            return {
                "code_additions_deletions_4_weeks": {},
                "forks": 0, "stars": 0, "subscribers": 0,
                "total_issues": 0, "closed_issues": 0,
                "pull_requests_merged": 0, "pull_requests_open": 0,
                "activity_score": 0.0,
            }

        dev_data = coin_data["developer_data"]

        code_changes = dev_data.get("code_additions_deletions_4_weeks", {})
        if isinstance(code_changes, dict):
            additions = code_changes.get("additions") or 0
            deletions = code_changes.get("deletions") or 0
        else:
            additions, deletions = 0, 0
        net_changes = additions - deletions

        forks = dev_data.get("forks", 0) or 0
        stars = dev_data.get("stars", 0) or 0
        subscribers = dev_data.get("subscribers", 0) or 0
        total_issues = dev_data.get("total_issues", 0) or 0
        closed_issues = dev_data.get("closed_issues", 0) or 0
        pr_merged = dev_data.get("pull_requests_merged", 0) or 0
        pr_open = dev_data.get("pull_requests_open", 0) or 0

        activity_score = 0.0

        # Code changes (40%)
        if net_changes > 0:
            activity_score += min(100, (net_changes / 2000) * 100) * 0.4

        # GitHub engagement (30%)
        engagement = stars + (forks * 10) + (subscribers * 5)
        activity_score += min(100, (engagement / 50000) * 100) * 0.3

        # Issue resolution (20%)
        if total_issues > 0:
            activity_score += (closed_issues / total_issues) * 100 * 0.2
        elif pr_merged > 0:
            activity_score += min(100, (pr_merged / 100) * 100) * 0.2

        # PR activity (10%)
        pr_activity = pr_merged + (pr_open * 0.5)
        activity_score += min(100, (pr_activity / 50) * 100) * 0.1

        return {
            "code_additions_deletions_4_weeks": {
                "additions": additions,
                "deletions": deletions,
                "net": net_changes,
            },
            "forks": forks, "stars": stars, "subscribers": subscribers,
            "total_issues": total_issues, "closed_issues": closed_issues,
            "pull_requests_merged": pr_merged, "pull_requests_open": pr_open,
            "activity_score": min(100, max(0, activity_score)),
        }

    def get_tokenomics_score(self, symbol: str) -> Dict[str, Any]:
        """
        Get tokenomics score for a cryptocurrency.

        Calls fetch_coin_details which is cached — see note on
        get_developer_activity_score.
        """
        coin_data = self.fetch_coin_details(symbol, include_developer_data=False)

        if not coin_data or not coin_data.get("market_data"):
            self.logger.warning(f"No market data available for {symbol}")
            return {
                "circulating_supply": 0,
                "total_supply": None,
                "max_supply": None,
                "dilution_risk": 100.0,
                "fdv_mc_ratio": None,
                "tokenomics_score": 0.0,
            }

        market_data = coin_data["market_data"]
        circulating = market_data.get("circulating_supply", 0) or 0
        total = market_data.get("total_supply")
        max_supply = market_data.get("max_supply")

        mc_obj = market_data.get("market_cap")
        market_cap = mc_obj.get("usd", 0) if isinstance(mc_obj, dict) else 0
        fdv_obj = market_data.get("fully_diluted_valuation")
        fdv = fdv_obj.get("usd", 0) if isinstance(fdv_obj, dict) else 0

        # Dilution risk
        dilution_risk = 50.0
        if max_supply and max_supply > 0 and circulating > 0:
            dilution_risk = min(100, max(0, ((max_supply - circulating) / max_supply) * 100))
        elif total and total > 0 and circulating > 0:
            dilution_risk = min(100, max(0, ((total - circulating) / total) * 100))

        fdv_mc_ratio = (fdv / market_cap) if (market_cap > 0 and fdv > 0) else None

        tokenomics_score = (100 - dilution_risk) * 0.6
        if fdv_mc_ratio is not None:
            if fdv_mc_ratio <= 1.0:
                fdv_score = 100.0
            elif fdv_mc_ratio <= 3.0:
                fdv_score = 100 - ((fdv_mc_ratio - 1.0) / 2.0) * 100
            else:
                fdv_score = 0.0
            tokenomics_score += fdv_score * 0.4
        else:
            tokenomics_score += 50 * 0.4

        return {
            "circulating_supply": float(circulating) if circulating else 0,
            "total_supply": float(total) if total else None,
            "max_supply": float(max_supply) if max_supply else None,
            "dilution_risk": float(dilution_risk),
            "fdv_mc_ratio": float(fdv_mc_ratio) if fdv_mc_ratio else None,
            "tokenomics_score": min(100, max(0, tokenomics_score)),
        }


# --------------------------------------------------------------------------
# Module-level singleton accessor.
#
# Every caller that needs a CoinGeckoService must go through
# `get_coingecko_service()`. Instantiating the class directly defeats the
# per-minute token bucket inside `CoinGeckoQuotaGate` — each instance gets a
# fresh bucket, so separate request handlers can't enforce the shared 500/min
# limit against each other. The singleton ensures one bucket across the whole
# process. Mirrors the LunarCrush pattern.
# --------------------------------------------------------------------------

_singleton_lock = threading.Lock()
_singleton: Optional["CoinGeckoService"] = None


def get_coingecko_service() -> "CoinGeckoService":
    """Return the process-wide CoinGeckoService, creating it on first use."""
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = CoinGeckoService()
    return _singleton
