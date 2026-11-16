"""In-memory storage for synthesized answer WAVs served to the speaker.

Pure module without Home Assistant imports. The HMAC over the run id is keyed with the
bridge token, so the unauthenticated TTS view cannot be enumerated.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import re
import time
from collections.abc import Callable

from .const import TTS_SUFFIX, TTS_TTL_SECONDS
from .protocol import tts_public_path

_RUN_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


@dataclass(frozen=True)
class _Entry:
    data: bytes
    expires_at: float


class TtsStore:
    """Publish one WAV per run, serve it by signed path, expire after the TTL."""

    def __init__(
        self,
        bridge_token: str,
        *,
        ttl: float = TTS_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not bridge_token:
            raise ValueError("bridge token is required for TTS signing")
        if ttl <= 0:
            raise ValueError("TTL must be positive")
        self._key = bridge_token.encode("utf-8")
        self._ttl = ttl
        self._clock = clock
        self._entries: dict[str, _Entry] = {}
        self._enabled = True

    @property
    def enabled(self) -> bool:
        """Whether new WAVs may be published and old ones served."""
        return self._enabled

    def set_enabled(self, enabled: bool) -> None:
        """Disable the store (config entry unloaded); entries are dropped on disable."""
        self._enabled = enabled
        if not enabled:
            self.clear()

    def signature(self, run_id: str) -> str:
        """Return the signed path segment for a run id."""
        return hmac.new(
            self._key, run_id.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def publish(self, run_id: str, wav: bytes) -> str:
        """Store a WAV and return its public HTTP path."""
        if not self._enabled:
            raise ValueError("TTS store is disabled")
        if not _RUN_ID_RE.fullmatch(run_id):
            raise ValueError("invalid run id")
        if not wav:
            raise ValueError("empty TTS payload")
        now = self._clock()
        self.purge(now)
        self._entries[run_id] = _Entry(data=bytes(wav), expires_at=now + self._ttl)
        return tts_public_path(run_id, self.signature(run_id))

    def resolve(self, run_id: str, signature: str) -> bytes | None:
        """Return the WAV for a signed path, or None when missing/expired/invalid."""
        if not self._enabled:
            return None
        if not _RUN_ID_RE.fullmatch(run_id):
            return None
        now = self._clock()
        self.purge(now)
        entry = self._entries.get(run_id)
        if entry is None or entry.expires_at <= now:
            return None
        if not isinstance(signature, str):
            return None
        if not hmac.compare_digest(self.signature(run_id), signature):
            return None
        return entry.data

    def resolve_file(self, run_id: str, filename: str) -> bytes | None:
        """Resolve the filename segment of the TTS view URL."""
        if not filename.endswith(TTS_SUFFIX):
            return None
        return self.resolve(run_id, filename[: -len(TTS_SUFFIX)])

    def purge(self, now: float | None = None) -> None:
        """Drop expired entries."""
        moment = self._clock() if now is None else now
        expired = [
            key for key, entry in self._entries.items() if entry.expires_at <= moment
        ]
        for key in expired:
            del self._entries[key]

    def clear(self) -> None:
        """Drop every entry."""
        self._entries.clear()

    @property
    def active_count(self) -> int:
        """Number of currently stored entries (diagnostics/tests)."""
        return len(self._entries)
