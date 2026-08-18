"""
OpenAI daily-quota circuit breaker.

OpenAI's requests-per-day (RPD) limit is a rolling 24h window per
organization. When it is exhausted, every call 429s and the "try again
in Xs" hint in the error is meaningless — the window frees up over
hours, not seconds. During the Aug 2026 outage the retry storm against
an exhausted RPD quota stretched every /signals/generate call past the
NestJS 300s timeout and wedged the service hard enough that Render's
health check killed it.

This breaker is process-wide: any adapter that sees an RPD 429 trips
it, and every OpenAI call site skips calling for a cooldown period
instead of queueing doomed requests. Per-minute 429s are NOT tripped
here — the SDK's own short retry handles those fine.
"""
import logging
import re
import threading
import time

logger = logging.getLogger(__name__)

# How long to stop calling OpenAI after an RPD-exhausted 429. The window
# is rolling, so there is no exact reset moment; one hour keeps the storm
# off while re-probing often enough to recover promptly.
_COOLDOWN_SECS = 60 * 60

_DAILY_LIMIT_PATTERN = re.compile(
    r"requests per day|RPD|per[- ]day", re.IGNORECASE
)


class OpenAICircuitBreaker:
    def __init__(self, cooldown_secs: int = _COOLDOWN_SECS) -> None:
        self._cooldown = cooldown_secs
        self._lock = threading.Lock()
        self._open_until = 0.0

    def is_open(self) -> bool:
        """True while OpenAI calls should be skipped."""
        with self._lock:
            return time.time() < self._open_until

    def seconds_remaining(self) -> int:
        with self._lock:
            return max(0, int(self._open_until - time.time()))

    def record_error(self, error: Exception) -> bool:
        """Inspect a failed OpenAI call. Trips the breaker if the error is a
        daily-quota 429. Returns True if the breaker tripped (or was already
        open because of one)."""
        msg = str(error)
        if "429" not in msg and "rate_limit" not in msg.lower():
            return False
        if not _DAILY_LIMIT_PATTERN.search(msg):
            return False
        with self._lock:
            already_open = time.time() < self._open_until
            self._open_until = time.time() + self._cooldown
        if not already_open:
            logger.error(
                "OpenAI daily request quota exhausted — circuit breaker OPEN, "
                f"skipping all OpenAI calls for {self._cooldown}s. Error: {msg[:200]}"
            )
        return True


# Process-wide singleton shared by every OpenAI call site.
breaker = OpenAICircuitBreaker()
