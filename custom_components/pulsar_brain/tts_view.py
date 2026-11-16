"""Unauthenticated HTTP view that serves answer WAVs to the speaker.

Access is protected by an HMAC over the run id (keyed with the bridge token); the
path is only known from the TTS_END event sent to the device. Entries expire after
TTS_TTL_SECONDS and return 404 afterwards.
"""

from __future__ import annotations

import logging

from aiohttp import web

from homeassistant.components.http import HomeAssistantView

from .const import TTS_URL_PREFIX, TTS_VIEW_NAME
from .tts_store import TtsStore

_LOGGER = logging.getLogger(__name__)


class PulsarBrainTtsView(HomeAssistantView):
    """Serve /api/pulsar_brain/tts/<run_id>/<hmac>.wav."""

    url = f"{TTS_URL_PREFIX}/{{run_id}}/{{filename}}"
    name = TTS_VIEW_NAME
    requires_auth = False
    cors_allowed = False

    def __init__(self, store: TtsStore) -> None:
        self._store = store

    def set_store(self, store: TtsStore) -> None:
        """Point the view at the store of the current config entry."""
        self._store = store

    def _resolve(self, run_id: str, filename: str) -> bytes | None:
        if not self._store.enabled:
            return None
        data = self._store.resolve_file(run_id, filename)
        if data is None:
            _LOGGER.debug("TTS request for unknown or expired run %s", run_id)
        return data

    @staticmethod
    def _headers(size: int) -> dict[str, str]:
        return {
            "Content-Length": str(size),
            "Cache-Control": "no-store",
            "Content-Disposition": 'inline; filename="answer.wav"',
            "X-Content-Type-Options": "nosniff",
        }

    async def get(
        self,
        request: web.Request,
        run_id: str = "",
        filename: str = "",
    ) -> web.Response:
        """Return the WAV for a signed path or 404.

        Home Assistant passes every URL placeholder as a keyword argument, so the handler
        signature must match the route template exactly.
        """
        data = self._resolve(run_id, filename)
        if data is None:
            return web.Response(status=404)
        return web.Response(
            body=data,
            content_type="audio/wav",
            headers=self._headers(len(data)),
        )

    async def head(
        self,
        request: web.Request,
        run_id: str = "",
        filename: str = "",
    ) -> web.Response:
        """HEAD support for players that probe the URL before downloading."""
        data = self._resolve(run_id, filename)
        if data is None:
            return web.Response(status=404)
        return web.Response(
            status=200,
            content_type="audio/wav",
            headers=self._headers(len(data)),
        )
