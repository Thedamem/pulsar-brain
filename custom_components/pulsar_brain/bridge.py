"""WebSocket client for the pulsar_brain addon and its small HTTP API.

One bridge run = one WebSocket connection (docs/contracts.md §3). This module has no
Home Assistant imports; the HA side lives in esphome_client.py and __init__.py.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
import json
import logging
import time

import aiohttp

from .const import (
    ADDON_CONFIG_PATH,
    ADDON_HEALTH_PATH,
    ADDON_PROVIDERS_PATH,
    ADDON_REQUEST_TIMEOUT,
    ADDON_STATUS_PATH,
    ADDON_TEST_TEXT_PATH,
    BRIDGE_CONNECT_TIMEOUT,
    BRIDGE_WS_PATH,
    KEEPALIVE_INTERVAL,
    MAX_AUDIO_QUEUE,
    MAX_TTS_BYTES,
)
from .events import BRIDGE_OWNED_EVENTS, event_from_addon, normalize_event_data
from .protocol import (
    RunRequest,
    build_run_cancel,
    build_run_end,
    build_run_start,
    encode_json,
    parse_json_object,
)
from .wav import parse_wav

_LOGGER = logging.getLogger(__name__)

DeviceEventCallback = Callable[[str, dict[str, str]], None]
TtsPublisher = Callable[[str, str, bytes], Awaitable[str]]
FinishedCallback = Callable[[str, str], None]



class AddonError(Exception):
    """Addon HTTP/WS error with a stable code."""

    def __init__(self, code: str, message: str, status: int | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status


def _host_for_url(host: str) -> str:
    value = host.strip()
    if not value or "/" in value or "://" in value:
        raise AddonError("invalid_host", "Addon host must be a bare host or IP address")
    if ":" in value and not value.startswith("["):
        value = f"[{value}]"
    return value


class AddonClient:
    """HTTP client for the addon, authenticated with the bridge token."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        port: int,
        token: str,
        *,
        request_timeout: float = ADDON_REQUEST_TIMEOUT,
    ) -> None:
        if not token:
            raise AddonError("missing_token", "Bridge token is empty")
        if not 0 < port < 65536:
            raise AddonError("invalid_port", "Addon port is out of range")
        self._session = session
        self._token = token
        self._request_timeout = request_timeout
        host_for_url = _host_for_url(host)
        self._base_url = f"http://{host_for_url}:{port}"
        self._ws_url = f"ws://{host_for_url}:{port}{BRIDGE_WS_PATH}"

    @property
    def ws_url(self) -> str:
        """Bridge WebSocket URL."""
        return self._ws_url

    @property
    def token(self) -> str:
        """Bridge bearer token (never logged)."""
        return self._token

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, object] | None = None,
        *,
        auth: bool = True,
    ) -> dict[str, object]:
        headers = {"Authorization": f"Bearer {self._token}"} if auth else {}
        url = f"{self._base_url}{path}"
        try:
            async with self._session.request(
                method,
                url,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=self._request_timeout),
            ) as response:
                body = await response.read()
                if response.status >= 400:
                    code, message = _parse_addon_error(body)
                    raise AddonError(code, message, response.status)
                if not body:
                    return {}
                return _parse_json_body(body)
        except aiohttp.ClientError as err:
            raise AddonError("connection_error", str(err)) from err
        except TimeoutError as err:
            raise AddonError("timeout", "Addon request timed out") from err

    async def async_health(self) -> dict[str, object]:
        """GET /health (open, no bearer)."""
        return await self._request("GET", ADDON_HEALTH_PATH, auth=False)

    async def async_status(self) -> dict[str, object]:
        """GET /api/status."""
        return await self._request("GET", ADDON_STATUS_PATH)

    async def async_config(self) -> dict[str, object]:
        """GET /api/config."""
        return await self._request("GET", ADDON_CONFIG_PATH)

    async def async_providers(self) -> list[dict[str, str]]:
        """GET /api/providers, returning id/label pairs."""
        payload = await self._request("GET", ADDON_PROVIDERS_PATH)
        raw = payload.get("providers")
        if not isinstance(raw, list):
            raise AddonError("invalid_response", "providers list is missing")
        providers: list[dict[str, str]] = []
        for item in raw:
            if not isinstance(item, Mapping):
                continue
            provider_id = item.get("id")
            label = item.get("label")
            if isinstance(provider_id, str) and provider_id:
                providers.append(
                    {
                        "id": provider_id,
                        "label": label if isinstance(label, str) else provider_id,
                    }
                )
        return providers

    async def async_set_provider(self, provider_id: str) -> dict[str, object]:
        """PUT /api/config with the selected provider id."""
        if not provider_id:
            raise AddonError("invalid_provider", "Provider id is empty")
        return await self._request(
            "PUT",
            ADDON_CONFIG_PATH,
            {"provider": {"id": provider_id}},
        )

    async def async_test_text(self, text: str) -> dict[str, object]:
        """POST /api/test/text."""
        if not text:
            raise AddonError("invalid_text", "Text is empty")
        return await self._request("POST", ADDON_TEST_TEXT_PATH, {"text": text})

    def provider_id_from_config(self, payload: Mapping[str, object]) -> str | None:
        """Extract config.provider.id from GET /api/config."""
        config = payload.get("config")
        if not isinstance(config, Mapping):
            return None
        provider = config.get("provider")
        if not isinstance(provider, Mapping):
            return None
        value = provider.get("id")
        return value if isinstance(value, str) and value else None


def _parse_addon_error(body: bytes) -> tuple[str, str]:
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return "http_error", "Addon returned an error"
    if isinstance(parsed, Mapping):
        error = parsed.get("error")
        if isinstance(error, Mapping):
            code = error.get("code")
            message = error.get("message")
            return (
                code if isinstance(code, str) and code else "http_error",
                message if isinstance(message, str) and message else "Addon returned an error",
            )
    return "http_error", "Addon returned an error"


def _parse_json_body(body: bytes) -> dict[str, object]:
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as err:
        raise AddonError("invalid_response", "Addon returned invalid JSON") from err
    if not isinstance(parsed, Mapping):
        raise AddonError("invalid_response", "Addon returned a non-object JSON body")
    return {key: value for key, value in parsed.items() if isinstance(key, str)}


async def async_validate_addon(
    session: aiohttp.ClientSession,
    host: str,
    port: int,
    token: str,
) -> tuple[dict[str, object], dict[str, object]]:
    """Validate host/port/token against /health and /api/status."""
    client = AddonClient(session, host, port, token)
    health = await client.async_health()
    if health.get("status") != "ok":
        raise AddonError("unhealthy", "Addon health check did not report ok")
    status = await client.async_status()
    return health, status


class BridgeClient:
    """Factory bound to one addon endpoint."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        port: int,
        token: str,
        *,
        keepalive_interval: float = KEEPALIVE_INTERVAL,
        connect_timeout: float = BRIDGE_CONNECT_TIMEOUT,
    ) -> None:
        self._addon = AddonClient(session, host, port, token)
        self._session = session
        self._keepalive_interval = keepalive_interval
        self._connect_timeout = connect_timeout

    @property
    def addon(self) -> AddonClient:
        """Underlying addon HTTP client."""
        return self._addon

    def start_run(
        self,
        request: RunRequest,
        *,
        on_device_event: DeviceEventCallback,
        publish_tts: TtsPublisher,
        on_finished: FinishedCallback,
    ) -> "BridgeRun":
        """Open one WebSocket run; the connection is established in the background."""
        run = BridgeRun(
            self._session,
            self._addon,
            request,
            on_device_event=on_device_event,
            publish_tts=publish_tts,
            on_finished=on_finished,
            keepalive_interval=self._keepalive_interval,
            connect_timeout=self._connect_timeout,
        )
        run.start()
        return run


class BridgeRun:
    """One voice run over a dedicated addon WebSocket."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        addon: AddonClient,
        request: RunRequest,
        *,
        on_device_event: DeviceEventCallback,
        publish_tts: TtsPublisher,
        on_finished: FinishedCallback,
        keepalive_interval: float = KEEPALIVE_INTERVAL,
        connect_timeout: float = BRIDGE_CONNECT_TIMEOUT,
        max_tts_bytes: int = MAX_TTS_BYTES,
    ) -> None:
        if keepalive_interval <= 0:
            raise ValueError("keepalive interval must be positive")
        self._session = session
        self._addon = addon
        self._request = request
        self._on_device_event = on_device_event
        self._publish_tts = publish_tts
        self._on_finished = on_finished
        self._keepalive_interval = keepalive_interval
        self._connect_timeout = connect_timeout
        self._max_tts_bytes = max_tts_bytes

        self._task: asyncio.Task[None] | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._writer_task: asyncio.Task[None] | None = None
        self._keepalive_task: asyncio.Task[None] | None = None
        self._fail_task: asyncio.Task[None] | None = None
        self._control_q: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()
        self._audio_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=MAX_AUDIO_QUEUE)
        self._items = asyncio.Event()

        self._closing = False
        self._finished = False
        self._failed = False
        self._close_reason = "client"
        self._sent_events: set[str] = set()
        self._last_event_at = 0.0

        self._tts_active = False
        self._tts_text = ""
        self._tts_buffer = bytearray()
        self._tts_overflow = False

        self._dropped_audio = 0
        self._audio_drop_logged = False

    @property
    def run_id(self) -> str:
        """Stable id of this run."""
        return self._request.run_id

    @property
    def done(self) -> bool:
        """Whether the run finished and callbacks fired."""
        return self._finished

    @property
    def run_end_sent(self) -> bool:
        """Whether RUN_END already reached the device for this run."""
        return "run_end" in self._sent_events

    def start(self) -> None:
        """Open the run for the device and start the WebSocket task.

        RUN_START goes out before the addon connection attempt: pulsar ignores every
        event until RUN_START, including the ERROR we send when the addon is down.
        """
        if self._task is not None:
            return
        self._last_event_at = time.monotonic()
        self._emit("run_start", {})
        self._emit("stt_start", {})
        self._task = asyncio.create_task(
            self._async_run(), name=f"pulsar_brain run {self.run_id}"
        )

    async def wait_closed(self) -> None:
        """Wait until the run is fully closed."""
        if self._task is not None:
            await asyncio.gather(self._task, return_exceptions=True)

    def send_audio(self, data: bytes) -> None:
        """Queue one PCM chunk for the addon."""
        if self._finished or self._closing or self._tts_active or not data:
            return
        try:
            self._audio_q.put_nowait(bytes(data))
        except asyncio.QueueFull:
            self._dropped_audio += 1
            if not self._audio_drop_logged:
                self._audio_drop_logged = True
                _LOGGER.warning(
                    "Dropping microphone audio for run %s: addon is not keeping up",
                    self.run_id,
                )
            return
        self._items.set()

    def cancel(self, reason: str) -> None:
        """Abort the run (device barge-in/stop) with run.cancel and close."""
        if self._finished or self._closing:
            return
        message = build_run_cancel(self.run_id, reason)
        _LOGGER.debug("Cancelling run %s (%s)", self.run_id, reason)
        self._request_close(message, reason)

    def end(self, reason: str) -> None:
        """End the run from the device side with run.end and close."""
        if self._finished or self._closing:
            return
        message = build_run_end(self.run_id, reason)
        _LOGGER.debug("Ending run %s (%s)", self.run_id, reason)
        self._request_close(message, reason)

    def abort(self) -> None:
        """Drop the run task immediately (shutdown after a close timeout)."""
        self._closing = True
        if self._task is not None and not self._task.done():
            self._task.cancel()

    # ────────────────────────────────────────────────────────────── internals ──

    def _request_close(self, message: dict[str, object], reason: str) -> None:
        self._closing = True
        self._close_reason = reason
        self._drain_audio()
        self._control_q.put_nowait(message)
        self._control_q.put_nowait(None)
        self._items.set()

    async def _async_run(self) -> None:
        try:
            async with asyncio.timeout(self._connect_timeout):
                ws = await self._session.ws_connect(
                    self._addon.ws_url,
                    headers={"Authorization": f"Bearer {self._addon_token}"},
                    timeout=aiohttp.ClientWSTimeout(ws_receive=None, ws_close=5.0),
                    autoclose=True,
                )
            self._ws = ws
            _LOGGER.debug("Addon WebSocket opened for run %s", self.run_id)
            await ws.send_str(encode_json(build_run_start(self._request)))
            self._writer_task = asyncio.create_task(
                self._run_writer(ws), name=f"pulsar_brain writer {self.run_id}"
            )
            self._keepalive_task = asyncio.create_task(
                self._run_keepalive(), name=f"pulsar_brain keepalive {self.run_id}"
            )
            if self._closing:
                self._items.set()
            async for message in ws:
                if message.type is aiohttp.WSMsgType.TEXT:
                    await self._handle_text(message.data)
                elif message.type is aiohttp.WSMsgType.BINARY:
                    self._handle_binary(message.data)
                elif message.type is aiohttp.WSMsgType.ERROR:
                    raise aiohttp.ClientError(f"WebSocket error: {ws.exception()}")
                elif message.type is aiohttp.WSMsgType.CLOSE:
                    break
            if not self._closing and not self._finished:
                await self._fail("bridge-disconnected", "Аддон закрыл соединение")
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            _LOGGER.warning("Addon WebSocket connect timed out for run %s", self.run_id)
            if not self._closing:
                await self._fail("addon-timeout", "Аддон не ответил вовремя")
        except (aiohttp.ClientError, OSError) as err:
            _LOGGER.warning("Addon WebSocket failed for run %s: %s", self.run_id, err)
            if not self._closing:
                status = getattr(err, "status", None)
                if status in (401, 403):
                    await self._fail(
                        "addon-unauthorized", "Аддон отклонил токен моста"
                    )
                else:
                    await self._fail("addon-unavailable", "Аддон недоступен")
        finally:
            await self._shutdown()

    async def _run_writer(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        try:
            while True:
                item = await self._next_item()
                if item is None:
                    break
                if isinstance(item, dict):
                    await ws.send_str(encode_json(item))
                else:
                    await ws.send_bytes(item)
            if not ws.closed:
                await ws.close()
        except asyncio.CancelledError:
            raise
        except (aiohttp.ClientError, OSError) as err:
            _LOGGER.debug("Addon writer stopped for run %s: %s", self.run_id, err)

    async def _next_item(self) -> dict[str, object] | bytes | None:
        while True:
            try:
                return self._control_q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                return self._audio_q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self._items.clear()
            if not self._control_q.empty() or not self._audio_q.empty():
                continue
            await self._items.wait()

    async def _run_keepalive(self) -> None:
        try:
            while not self._closing and not self._finished:
                await asyncio.sleep(self._keepalive_interval)
                if self._closing or self._finished:
                    return
                if time.monotonic() - self._last_event_at >= self._keepalive_interval:
                    self._emit("intent_progress", {})
        except asyncio.CancelledError:
            raise

    async def _handle_text(self, raw: str) -> None:
        if self._closing:
            _LOGGER.debug("Ignoring addon message after close for run %s", self.run_id)
            return
        message = parse_json_object(raw)
        if message is None:
            _LOGGER.warning("Ignoring non-object addon message for run %s", self.run_id)
            return
        message_type = message.get("type")
        if not isinstance(message_type, str):
            _LOGGER.warning("Ignoring addon message without type for run %s", self.run_id)
            return

        if message_type == "run.accepted":
            run_id = message.get("runId")
            if isinstance(run_id, str) and run_id != self.run_id:
                _LOGGER.warning(
                    "Addon accepted run %s while bridge runs %s", run_id, self.run_id
                )
            return

        if message_type == "device.event":
            self._handle_device_event(message)
            return

        if message_type == "tts.start":
            self._handle_tts_start(message)
            return

        if message_type == "tts.end":
            await self._handle_tts_end(message)
            return

        if message_type == "run.end":
            await self._handle_run_end(message)
            return

        if message_type == "error":
            code = message.get("code")
            text = message.get("message")
            fatal = bool(message.get("fatal"))
            _LOGGER.warning(
                "Addon error for run %s: %s (%s)",
                self.run_id,
                code if isinstance(code, str) else "unknown",
                text if isinstance(text, str) else "",
            )
            if fatal:
                await self._fail(
                    code if isinstance(code, str) and code else "addon-error",
                    text if isinstance(text, str) and text else "Ошибка аддона",
                )
            return

        _LOGGER.debug(
            "Ignoring unknown addon message %s for run %s", message_type, self.run_id
        )

    def _handle_device_event(self, message: Mapping[str, object]) -> None:
        name = message.get("event")
        if not isinstance(name, str):
            return
        if event_from_addon(name) is None:
            _LOGGER.debug("Ignoring unknown addon device event %s", name)
            return
        if name in BRIDGE_OWNED_EVENTS:
            _LOGGER.debug("Ignoring addon-owned duplicate event %s", name)
            return
        data = normalize_event_data(message.get("data"))
        self._emit(name, data)

    def _handle_tts_start(self, message: Mapping[str, object]) -> None:
        if self._tts_active:
            _LOGGER.warning("Ignoring duplicate tts.start for run %s", self.run_id)
            return
        fmt = message.get("format")
        if fmt != "wav":
            self._schedule_fail("tts-format", "Аддон прислал TTS не в формате WAV")
            return
        text = message.get("text")
        self._tts_text = text if isinstance(text, str) else ""
        self._tts_buffer = bytearray()
        self._tts_overflow = False
        self._tts_active = True
        self._drain_audio()

    def _handle_binary(self, data: bytes) -> None:
        if self._closing:
            return
        if not self._tts_active:
            _LOGGER.debug("Ignoring binary frame outside TTS for run %s", self.run_id)
            return
        if self._tts_overflow:
            return
        self._tts_buffer.extend(data)
        if len(self._tts_buffer) > self._max_tts_bytes:
            self._tts_overflow = True
            self._tts_buffer.clear()
            self._schedule_fail("tts-too-large", "Ответ TTS превысил допустимый размер")

    async def _handle_tts_end(self, message: Mapping[str, object]) -> None:
        if self._closing:
            return
        if not self._tts_active:
            _LOGGER.warning("Ignoring tts.end without tts.start for run %s", self.run_id)
            return
        self._tts_active = False
        reason = message.get("reason")
        if reason == "cancelled":
            if not self._closing:
                self._emit("run_end", {})
                await self._close_ws("cancelled")
            return
        if reason != "done":
            await self._fail("tts-error", "Аддон не смог синтезировать ответ")
            return
        if self._tts_overflow:
            return
        if not self._tts_buffer:
            await self._fail("tts-empty", "Аддон прислал пустой ответ TTS")
            return
        wav = bytes(self._tts_buffer)
        self._tts_buffer.clear()
        wav_info = parse_wav(wav)
        if wav_info is None:
            await self._fail("tts-invalid", "Аддон прислал некорректный WAV")
            return
        if (
            wav_info.sample_rate != 16000
            or wav_info.channels != 1
            or wav_info.bits_per_sample != 16
        ):
            _LOGGER.warning(
                "TTS WAV for run %s is %d Hz/%d ch/%d bit; pulsar expects 16000/1/16",
                self.run_id,
                wav_info.sample_rate,
                wav_info.channels,
                wav_info.bits_per_sample,
            )
        try:
            url = await self._publish_tts(self.run_id, self._tts_text, wav)
        except Exception as err:  # noqa: BLE001 - any publisher failure ends the run
            _LOGGER.exception("Publishing TTS for run %s failed", self.run_id)
            await self._fail("tts-publish-failed", f"Не удалось опубликовать ответ: {err}")
            return
        if self._closing:
            return
        if not url:
            await self._fail("tts-url-missing", "Не удалось построить URL ответа")
            return
        _LOGGER.debug(
            "TTS ready for run %s: %d bytes, %s", self.run_id, len(wav), _safe_url(url)
        )
        self._emit("tts_start", {"text": self._tts_text})
        self._emit("tts_end", {"url": url})
        self._emit("run_end", {})
        await self._close_ws("done")

    async def _handle_run_end(self, message: Mapping[str, object]) -> None:
        reason = message.get("reason")
        end_reason = reason if isinstance(reason, str) and reason else "done"
        if self._closing:
            return
        if end_reason == "error" and "error" not in self._sent_events:
            self._emit("error", {"code": "addon-error", "message": "Ошибка обработки запроса"})
        self._emit("run_end", {})
        await self._close_ws(end_reason)

    def _schedule_fail(self, code: str, message: str) -> None:
        if self._fail_task is not None and not self._fail_task.done():
            return
        self._fail_task = asyncio.create_task(
            self._fail(code, message), name=f"pulsar_brain fail {self.run_id}"
        )

    async def _fail(self, code: str, message: str) -> None:
        if self._finished or self._failed:
            return
        self._failed = True
        _LOGGER.warning("Bridge run %s failed: %s (%s)", self.run_id, code, message)
        if "error" not in self._sent_events:
            self._emit("error", {"code": code, "message": message})
        self._emit("run_end", {})
        await self._close_ws("error")

    async def _close_ws(self, reason: str) -> None:
        if self._finished:
            return
        self._closing = True
        self._close_reason = reason
        self._drain_audio()
        ws = self._ws
        if ws is not None and not ws.closed:
            try:
                await ws.close(
                    code=1011 if reason == "error" else 1000,
                    message=reason.encode("utf-8")[:120],
                )
            except (aiohttp.ClientError, OSError):
                pass

    async def _shutdown(self) -> None:
        if self._finished:
            return
        self._finished = True
        current = asyncio.current_task()
        for task in (self._writer_task, self._keepalive_task):
            if task is not None and task is not current and not task.done():
                task.cancel()
        wait_for = [
            task
            for task in (self._writer_task, self._keepalive_task)
            if task is not None and task is not current
        ]
        if wait_for:
            await asyncio.gather(*wait_for, return_exceptions=True)
        ws = self._ws
        self._ws = None
        if ws is not None and not ws.closed:
            try:
                await ws.close()
            except (aiohttp.ClientError, OSError):
                pass
        if self._dropped_audio:
            _LOGGER.debug(
                "Run %s dropped %d microphone chunks", self.run_id, self._dropped_audio
            )
        try:
            self._on_finished(self.run_id, self._close_reason)
        except Exception:  # noqa: BLE001 - a callback bug must not leak the task
            _LOGGER.exception("Run finish callback failed for %s", self.run_id)

    @property
    def _addon_token(self) -> str:
        return self._addon.token

    def _emit(self, name: str, data: dict[str, str]) -> None:
        if self._finished or self._closing:
            return
        if name in self._sent_events and (name in BRIDGE_OWNED_EVENTS or name == "error"):
            return
        self._sent_events.add(name)
        self._last_event_at = time.monotonic()
        try:
            self._on_device_event(name, data)
        except Exception:  # noqa: BLE001 - event delivery must not kill the run
            _LOGGER.exception("Device event callback failed for %s", name)

    def _drain_audio(self) -> None:
        while True:
            try:
                self._audio_q.get_nowait()
            except asyncio.QueueEmpty:
                return


def _safe_url(url: str) -> str:
    """Return a URL for logs without the signed path suffix."""
    marker = "/api/pulsar_brain/tts/"
    if marker in url:
        return f"{url.split(marker, 1)[0]}{marker}<signed>"
    return url
