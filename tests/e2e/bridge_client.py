"""WebSocket client that plays the Python bridge side of docs/contracts.md §3.

One call to run_bridge() opens /api/bridge/ws, sends run.start, streams a WAV
fixture as raw 16 kHz s16le PCM in 32 ms chunks (real-time pacing by default),
optionally cancels the run, then collects device events, TTS JSON frames and the
WAV answer until the addon closes the connection.

The URL from TTS_END is not checked here: publishing it is the Python bridge's
job, and the bridge is deliberately out of scope for these tests.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import aiohttp

from harness import HarnessError, RouteUnavailable, auth_headers, now_iso

SAMPLE_RATE = 16_000
SAMPLE_WIDTH = 2
CHUNK_MS = 32
DEFAULT_CHUNK_BYTES = SAMPLE_RATE * SAMPLE_WIDTH * CHUNK_MS // 1000

DEFAULT_DEVICE: dict[str, str] = {
    "name": "pulsar-e2e",
    "mac": "AC:BA:C0:01:75:DC",
    "firmware": "pulsar-v0.5.3",
}


@dataclass(frozen=True)
class BridgeRunConfig:
    ws_url: str
    token: str
    run_id: str
    wake_word_phrase: str
    audio_pcm: bytes
    device: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_DEVICE))
    use_wake_word: bool = True
    realtime: bool = True
    chunk_ms: int = CHUNK_MS
    # Barge-in: send run.cancel this many ms after the last audio chunk.
    cancel_after_audio_ms: int | None = None
    # Overall wait for run.end after the input is finished.
    timeout_sec: float = 45.0


@dataclass(frozen=True)
class BridgeMessage:
    at_ms: float
    at_iso: str
    payload: dict[str, Any]


@dataclass
class BridgeRunResult:
    run_id: str
    started_at: str
    messages: list[BridgeMessage] = field(default_factory=list)
    binary_sizes: list[int] = field(default_factory=list)
    stray_binary_frames: int = 0
    tts_start_text: str | None = None
    tts_start_at_ms: float | None = None
    tts_end_reason: str | None = None
    tts_end_at_ms: float | None = None
    run_end_reason: str | None = None
    run_end_at_ms: float | None = None
    close_code: int | None = None
    closed_at_ms: float | None = None
    cancel_sent_at_ms: float | None = None
    audio_sent_at_ms: float | None = None
    audio_frames_sent: int = 0
    timed_out: bool = False
    read_error: str | None = None
    _tts_active: bool = False
    _tts_bytes: bytearray = field(default_factory=bytearray)

    @property
    def tts_wav(self) -> bytes:
        return bytes(self._tts_bytes)

    def device_events(self, event: str | None = None) -> list[BridgeMessage]:
        result: list[BridgeMessage] = []
        for message in self.messages:
            payload = message.payload
            if payload.get("type") != "device.event":
                continue
            if event is not None and payload.get("event") != event:
                continue
            result.append(message)
        return result

    @property
    def transcript(self) -> str | None:
        for message in reversed(self.device_events("stt_end")):
            data = message.payload.get("data")
            if isinstance(data, dict) and isinstance(data.get("text"), str):
                return data["text"]
        return None

    @property
    def response_text(self) -> str | None:
        if self.tts_start_text:
            return self.tts_start_text
        for message in reversed(self.device_events("intent_end")):
            data = message.payload.get("data")
            if isinstance(data, dict) and isinstance(data.get("speech"), str):
                return data["speech"]
        return None

    def error_payloads(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for message in self.messages:
            payload = message.payload
            if payload.get("type") == "error":
                result.append(payload)
            elif payload.get("type") == "device.event" and payload.get("event") == "error":
                result.append(payload)
        return result

    def error_codes(self) -> list[str]:
        codes: list[str] = []
        for payload in self.error_payloads():
            if payload.get("type") == "error" and isinstance(payload.get("code"), str):
                codes.append(payload["code"])
            data = payload.get("data")
            if isinstance(data, dict):
                for key in ("code", "message", "text"):
                    value = data.get(key)
                    if isinstance(value, str):
                        codes.append(value)
        return codes

    def timeline(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for message in self.messages:
            payload = message.payload
            kind = payload.get("type")
            row: dict[str, Any] = {"atMs": round(message.at_ms, 1), "type": kind}
            if kind == "device.event":
                row["event"] = payload.get("event")
                row["data"] = payload.get("data")
            elif kind == "tts.start":
                row["text"] = payload.get("text")
            elif kind in ("tts.end", "run.end"):
                row["reason"] = payload.get("reason")
            elif kind == "error":
                row["code"] = payload.get("code")
                row["message"] = payload.get("message")
                row["fatal"] = payload.get("fatal")
            rows.append(row)
        return rows




@dataclass
class _ReadState:
    result: BridgeRunResult
    done: asyncio.Event
    start_mono: float


def pcm_from_wav(path: Path) -> bytes:
    """Read a 16 kHz mono 16-bit fixture and return its raw PCM frames."""
    try:
        with wave.open(str(path), "rb") as wav_file:
            if wav_file.getnchannels() != 1:
                raise HarnessError(f"{path.name}: ожидался моно, получено {wav_file.getnchannels()} кан.")
            if wav_file.getsampwidth() != 2:
                raise HarnessError(f"{path.name}: ожидался 16-битный звук")
            if wav_file.getframerate() != SAMPLE_RATE:
                raise HarnessError(
                    f"{path.name}: ожидалось {SAMPLE_RATE} Гц, получено {wav_file.getframerate()}"
                )
            return wav_file.readframes(wav_file.getnframes())
    except (OSError, wave.Error) as err:
        raise HarnessError(f"не читается WAV {path}: {err}") from err


async def run_bridge(config: BridgeRunConfig) -> BridgeRunResult:
    result = BridgeRunResult(run_id=config.run_id, started_at=now_iso())
    done = asyncio.Event()
    start_mono = time.monotonic()

    def at_ms() -> float:
        return (time.monotonic() - start_mono) * 1000.0

    session = aiohttp.ClientSession()
    try:
        try:
            websocket = await session.ws_connect(
                config.ws_url,
                headers=auth_headers(config.token),
                max_msg_size=0,
            )
        except aiohttp.WSServerHandshakeError as err:
            if err.status == 404:
                raise RouteUnavailable("WS", "/api/bridge/ws", err.status) from err
            if err.status in (401, 403):
                raise HarnessError(
                    f"аддон отклонил WS-соединение моста (HTTP {err.status}): "
                    "проверьте PULSAR_BRAIN_BRIDGE_TOKEN"
                ) from err
            raise HarnessError(f"WS upgrade отклонён: HTTP {err.status}") from err
        except (aiohttp.ClientError, OSError) as err:
            raise HarnessError(f"не удалось подключиться к {config.ws_url}: {err}") from err

        state = _ReadState(result=result, done=done, start_mono=start_mono)
        reader = asyncio.create_task(_read_loop(websocket, state))
        try:
            await websocket.send_json(
                {
                    "type": "run.start",
                    "protocol": 1,
                    "runId": config.run_id,
                    "device": config.device,
                    "wakeWord": "alisa",
                    "wakeWordPhrase": config.wake_word_phrase,
                    "flags": {"useWakeWord": config.use_wake_word},
                }
            )
            await _stream_audio(websocket, config, result)
            result.audio_sent_at_ms = at_ms()

            if config.cancel_after_audio_ms is not None:
                if config.cancel_after_audio_ms > 0:
                    await asyncio.sleep(config.cancel_after_audio_ms / 1000.0)
                result.cancel_sent_at_ms = at_ms()
                await websocket.send_json(
                    {"type": "run.cancel", "runId": config.run_id, "reason": "barge_in"}
                )

            try:
                await asyncio.wait_for(done.wait(), timeout=config.timeout_sec)
            except asyncio.TimeoutError:
                result.timed_out = True
        finally:
            try:
                await websocket.close()
            except (aiohttp.ClientError, ConnectionError, OSError):
                # The addon may have closed the socket first; nothing left to do.
                pass
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError, aiohttp.ClientError):
                await reader
    finally:
        await session.close()
    return result


async def _stream_audio(
    websocket: aiohttp.ClientWebSocketResponse,
    config: BridgeRunConfig,
    result: BridgeRunResult,
) -> None:
    pcm = config.audio_pcm
    if len(pcm) % SAMPLE_WIDTH != 0:
        pcm = pcm[: len(pcm) - 1]
    chunk_bytes = max(2, SAMPLE_RATE * SAMPLE_WIDTH * config.chunk_ms // 1000)
    for offset in range(0, len(pcm), chunk_bytes):
        await websocket.send_bytes(pcm[offset : offset + chunk_bytes])
        result.audio_frames_sent += 1
        if config.realtime:
            await asyncio.sleep(config.chunk_ms / 1000.0)


async def _read_loop(
    websocket: aiohttp.ClientWebSocketResponse, state: _ReadState
) -> None:
    result = state.result
    try:
        async for message in websocket:
            at_ms = (time.monotonic() - state.start_mono) * 1000.0
            if message.type == aiohttp.WSMsgType.TEXT:
                _handle_text(result, at_ms, message.data)
            elif message.type == aiohttp.WSMsgType.BINARY:
                payload = message.data
                if not isinstance(payload, bytes):
                    payload = bytes(payload)
                result.binary_sizes.append(len(payload))
                if result._tts_active:
                    result._tts_bytes.extend(payload)
                else:
                    result.stray_binary_frames += 1
            elif message.type in (
                aiohttp.WSMsgType.CLOSE,
                aiohttp.WSMsgType.CLOSED,
                aiohttp.WSMsgType.ERROR,
            ):
                result.close_code = websocket.close_code
                result.closed_at_ms = at_ms
                break
    except asyncio.CancelledError:
        raise
    except (aiohttp.ClientError, ConnectionError, OSError) as err:
        result.read_error = f"{type(err).__name__}: {err}"
    finally:
        state.done.set()


def _handle_text(result: BridgeRunResult, at_ms: float, raw: str) -> None:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = {"type": "unparsed", "raw": raw[:200]}
    payload: dict[str, Any] = parsed if isinstance(parsed, dict) else {"type": "non_object", "value": parsed}
    result.messages.append(BridgeMessage(at_ms=at_ms, at_iso=now_iso(), payload=payload))
    kind = payload.get("type")
    if kind == "tts.start":
        result.tts_start_at_ms = at_ms
        text = payload.get("text")
        result.tts_start_text = text if isinstance(text, str) else ""
        result._tts_active = True
    elif kind == "tts.end":
        result.tts_end_at_ms = at_ms
        reason = payload.get("reason")
        result.tts_end_reason = reason if isinstance(reason, str) else ""
        result._tts_active = False
    elif kind == "run.end":
        result.run_end_at_ms = at_ms
        reason = payload.get("reason")
        result.run_end_reason = reason if isinstance(reason, str) else ""
