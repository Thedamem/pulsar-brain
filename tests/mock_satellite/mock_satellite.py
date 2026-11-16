"""Mock ESPHome voice satellite: a pulsar (Yandex Station Lite 2) device emulator.

The bridge under test is an ESPHome API *client* (Home Assistant side), so this
process is the ESPHome API *server*: plaintext Native API on TCP, the same
messages pulsar 0.5.3 sends and accepts.  The device half of the voice
assistant is reproduced from pulsar's sources:

* ``SubscribeVoiceAssistantRequest``: the pipeline belongs to the most recent
  subscriber among those still subscribed; unsubscribing hands it back to the
  previous one (``pulsar-esphome/src/server.rs``, ``voice_choice``).
* A run starts with ``VoiceAssistantRequest(start=true, flags=0,
  wake_word_phrase="Алиса")`` and the recorded WAV streamed as
  ``VoiceAssistantAudio`` chunks of 32 ms (1024 bytes).
* pulsar does not play server-streamed ``VoiceAssistantAudio``: it plays the
  answer from the URL carried by the ``TTS_END`` event.  The mock downloads
  that URL over HTTP and saves it, which is the actual TTS verification.
* Follow-up is a new run: after the answer finished playing, when
  ``INTENT_END.continue_conversation=1``, the mock sends a second
  ``VoiceAssistantRequest(start=true, wake_word_phrase="")`` with the
  follow-up WAV.
* Cancellation/barge-in: ``VoiceAssistantRequest(start=false)``.

Everything the mock exchanges is written to the JSON journal given by
``--events-json``; the TTS answers are saved next to ``--out``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import pathlib
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import aiohttp
from aioesphomeapi import api_pb2
from aiohttp import web

from esphome_protocol import (
    MSG_DEVICE_CAPABILITIES_REQUEST,
    MSG_DEVICE_INFO_REQUEST,
    MSG_DISCONNECT_REQUEST,
    MSG_HELLO_REQUEST,
    MSG_LIST_ENTITIES_REQUEST,
    MSG_PING_REQUEST,
    MSG_SUBSCRIBE_LOGS_REQUEST,
    MSG_SUBSCRIBE_STATES_REQUEST,
    MSG_SUBSCRIBE_VOICE_ASSISTANT_REQUEST,
    MSG_VOICE_ASSISTANT_ANNOUNCE_REQUEST,
    MSG_VOICE_ASSISTANT_AUDIO,
    MSG_VOICE_ASSISTANT_CONFIGURATION_REQUEST,
    MSG_VOICE_ASSISTANT_EVENT_RESPONSE,
    MSG_VOICE_ASSISTANT_REQUEST,
    MSG_VOICE_ASSISTANT_RESPONSE,
    ProtocolError,
    decode_message,
    encode_message,
    message_to_dict,
    read_frame,
    va_event_raw_name,
    va_event_short_name,
)
from wav_utils import PcmWav, WavFormatError, is_riff_wav, read_wav, wav_bytes, wav_duration_s

_LOGGER = logging.getLogger("mock_satellite")

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
CHANNELS = 1

# pulsar 0.5.3 (satellite/crates/pulsar-esphome/src/server.rs): API 1.15,
# ESPHome 2026.9.0, project "pulsar.satellite", and VOICE_FEATURES = 1|4|8|16|32
# (VOICE_ASSISTANT | API_AUDIO | TIMERS | ANNOUNCE | START_CONVERSATION).
DEFAULT_API_MAJOR = 1
DEFAULT_API_MINOR = 15
DEFAULT_ESPHOME_VERSION = "2026.9.0"
DEFAULT_PROJECT_NAME = "pulsar.satellite"
DEFAULT_PROJECT_VERSION = "0.5.3"
DEFAULT_FEATURE_FLAGS = 1 | 4 | 8 | 16 | 32

DEFAULT_DEVICE_NAME = "yandex-lite2-000001"
DEFAULT_FRIENDLY_NAME = "Яндекс Станция Лайт 2"
DEFAULT_MAC_ADDRESS = "02:00:00:00:00:01"
DEFAULT_MANUFACTURER = "Yandex"
DEFAULT_MODEL = "Station Lite 2"
DEFAULT_WAKE_WORD_PHRASE = "Алиса"


class RunBusyError(RuntimeError):
    """A trigger is already running."""


class NoSubscriberError(RuntimeError):
    """No connected client owns the voice assistant slot."""


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


@dataclass
class MockConfig:
    """Runtime configuration of the mock satellite (filled from CLI arguments)."""

    device_name: str = DEFAULT_DEVICE_NAME
    friendly_name: str = DEFAULT_FRIENDLY_NAME
    mac_address: str = DEFAULT_MAC_ADDRESS
    manufacturer: str = DEFAULT_MANUFACTURER
    model: str = DEFAULT_MODEL
    esphome_version: str = DEFAULT_ESPHOME_VERSION
    project_name: str = DEFAULT_PROJECT_NAME
    project_version: str = DEFAULT_PROJECT_VERSION
    api_major: int = DEFAULT_API_MAJOR
    api_minor: int = DEFAULT_API_MINOR
    feature_flags: int = DEFAULT_FEATURE_FLAGS

    host: str = "0.0.0.0"
    port: int = 6053
    control_host: str = "127.0.0.1"
    control_port: int = 8099

    wake_word_phrase: str = DEFAULT_WAKE_WORD_PHRASE
    # pulsar sends flags=0: wake word is handled on the device, VAD in HA.
    flags: int = 0
    conversation_id: str | None = None

    wav: str = ""
    followup_wav: str | None = None
    out: str = "mock-satellite-tts.wav"
    out_streamed_wav: str | None = None
    events_json: str = "mock-satellite-events.json"

    chunk_ms: int = 32
    pace_factor: float = 1.0
    turn_timeout: float = 30.0
    tts_timeout: float = 15.0
    tts_end_grace: float = 1.0
    tts_headers: list[tuple[str, str]] = field(default_factory=list)

    cancel_after_ms: int = 0
    # One journal record per streamed VoiceAssistantAudio chunk is useful only for
    # debugging; a bridge that streams continuously would flood the journal.
    streamed_audio_event_limit: int = 20
    auto_start: bool = False
    exit_after_run: bool = False
    # --exit-after-run waits briefly so the client can disconnect cleanly
    # instead of seeing a mid-flight EOF.
    exit_grace_s: float = 0.5
    verbose: bool = False

    @property
    def chunk_bytes(self) -> int:
        return max(2, int(SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * self.chunk_ms / 1000))

    @property
    def chunk_interval_s(self) -> float:
        return (self.chunk_ms / 1000.0) / max(self.pace_factor, 1e-9)


@dataclass
class _ClientConn:
    """One connected ESPHome API client (the bridge or a test client)."""

    client_id: int
    peer: str
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    connected_at: str = field(default_factory=_iso_now)
    hello_received: bool = False
    subscribed_seq: int = 0
    subscription_flags: int = 0
    is_voice_owner: bool = False
    last_rx_monotonic: float = field(default_factory=time.monotonic)
    write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    closed: bool = False

    async def send_message(self, message: Any) -> None:
        frame = encode_message(message)
        async with self.write_lock:
            if self.closed:
                raise ConnectionError(f"client {self.peer} is already closed")
            self.writer.write(frame)
            await self.writer.drain()


@dataclass
class _RunState:
    """One mock trigger: a first run plus an optional follow-up run."""

    index: int
    conversation_id: str
    wav: PcmWav
    wav_path: str
    followup_wav: PcmWav | None
    followup_path: str | None
    cancel_after_ms: int
    started_at: str = field(default_factory=_iso_now)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None
    cancel_requested: bool = False
    cancel_reason: str | None = None
    continue_conversation: bool = False
    current_run: dict[str, Any] | None = None
    queue: asyncio.Queue[tuple[Any, ...]] | None = None
    error: str | None = None
    end_reason: str | None = None


class MockSatellite:
    """TCP ESPHome API server + HTTP run control for the mock voice satellite."""

    def __init__(self, config: MockConfig | None = None) -> None:
        self.cfg = config or MockConfig()
        self.clients: list[_ClientConn] = []
        self._connections: dict[int, dict[str, Any]] = {}
        self._events: list[dict[str, Any]] = []
        self._runs: list[dict[str, Any]] = []
        self._errors: list[dict[str, Any]] = []
        self._client_seq = 0
        self._subscribe_seq = 0
        self._trigger_seq = 0
        self._start_seq = 0
        self._tts_seq = 0
        self._streamed_audio_bytes = 0
        self._streamed_audio = bytearray()
        self._streamed_audio_events = 0
        self._warned_streamed_audio = False
        self._run: _RunState | None = None
        self._auto_start_task: asyncio.Task[None] | None = None
        self._exit_task: asyncio.Task[None] | None = None
        self.state = "idle"
        self.started_at: str | None = None
        self.finished_at: str | None = None
        self.tcp_port = self.cfg.port
        self.control_port = self.cfg.control_port
        self._server: asyncio.AbstractServer | None = None
        self._control_runner: web.AppRunner | None = None
        self._http: aiohttp.ClientSession | None = None
        self._shutdown = asyncio.Event()
        self._stopped = False
        self.exit_code = 0

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        self.started_at = _iso_now()
        self._http = aiohttp.ClientSession()
        self._server = await asyncio.start_server(self._handle_client, self.cfg.host, self.cfg.port)
        sockets = self._server.sockets or []
        if sockets:
            self.tcp_port = sockets[0].getsockname()[1]
        _LOGGER.info(
            "ESPHome API mock listening on %s:%d (plaintext; device %r, wake word %r)",
            self.cfg.host,
            self.tcp_port,
            self.cfg.device_name,
            self.cfg.wake_word_phrase,
        )
        await self._start_control_server()
        self._write_events_json()

    async def run_until_shutdown(self) -> None:
        await self.start()
        try:
            await self._shutdown.wait()
        finally:
            await self.stop()

    def request_shutdown(self, reason: str = "shutdown") -> None:
        if not self._shutdown.is_set():
            _LOGGER.info("shutdown requested: %s", reason)
            self._shutdown.set()

    def _maybe_exit_after_run(self) -> None:
        if not self.cfg.exit_after_run or self._shutdown.is_set() or self._exit_task is not None:
            return
        self._exit_task = asyncio.create_task(self._exit_after_grace(), name="mock-exit-after-run")

    async def _exit_after_grace(self) -> None:
        await asyncio.sleep(max(0.0, self.cfg.exit_grace_s))
        self.request_shutdown("exit-after-run")

    async def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if not self._shutdown.is_set():
            self._shutdown.set()
        run = self._run
        if run is not None and not run.finished.is_set() and run.task is not None:
            run.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await run.task
        for conn in list(self.clients):
            await self._disconnect(conn)
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        if self._control_runner is not None:
            await self._control_runner.cleanup()
            self._control_runner = None
        if self._http is not None:
            await self._http.close()
            self._http = None
        self.finished_at = _iso_now()
        self._flush_streamed_audio()
        self._write_events_json()
        _LOGGER.info(
            "mock satellite stopped (%d runs, %d events, exit code %d)",
            len(self._runs),
            len(self._events),
            self.exit_code,
        )

    # ------------------------------------------------------------------ events journal

    def _append_event(
        self,
        *,
        direction: str,
        message_type: str,
        run: int | None = None,
        event: str | None = None,
        data: dict[str, Any] | None = None,
        peer: str | None = None,
        connection: int | None = None,
    ) -> dict[str, Any]:
        record: dict[str, Any] = {
            "ts": round(time.time(), 6),
            "tsIso": _iso_now(),
            "direction": direction,
            "type": message_type,
            "run": run,
        }
        if event is not None:
            record["event"] = event
        if data is not None:
            record["data"] = data
        if peer is not None:
            record["peer"] = peer
        if connection is not None:
            record["connection"] = connection
        self._events.append(record)
        return record

    def _record_in_message(self, conn: _ClientConn, message: Any) -> None:
        try:
            data = message_to_dict(message)
        except Exception:  # pragma: no cover - defensive, protobuf JSON conversion is stable
            data = {}
        self._append_event(
            direction="in",
            message_type=type(message).__name__,
            data=data,
            peer=conn.peer,
            connection=conn.client_id,
        )

    def _record_out_message(self, run_index: int | None, message: Any) -> None:
        self._append_event(
            direction="out",
            message_type=type(message).__name__,
            run=run_index,
            data=message_to_dict(message),
        )

    def events_document(self) -> dict[str, Any]:
        tts_entries = [entry for run in self._runs for entry in run.get("tts", [])]
        return {
            "mockSatellite": {
                "deviceName": self.cfg.device_name,
                "friendlyName": self.cfg.friendly_name,
                "macAddress": self.cfg.mac_address,
                "apiVersion": f"{self.cfg.api_major}.{self.cfg.api_minor}",
                "esphomeVersion": self.cfg.esphome_version,
                "projectName": self.cfg.project_name,
                "projectVersion": self.cfg.project_version,
                "voiceAssistantFeatureFlags": self.cfg.feature_flags,
                "startedAt": self.started_at,
                "finishedAt": self.finished_at,
                "tcpPort": self.tcp_port,
                "controlPort": self.control_port,
                "wav": self.cfg.wav,
                "followupWav": self.cfg.followup_wav,
                "out": self.cfg.out,
                "wakeWordPhrase": self.cfg.wake_word_phrase,
                "flags": self.cfg.flags,
                "chunkBytes": self.cfg.chunk_bytes,
                "chunkMs": self.cfg.chunk_ms,
                "paceFactor": self.cfg.pace_factor,
            },
            "connections": list(self._connections.values()),
            "runs": self._runs,
            "events": self._events,
            "summary": {
                "triggers": len({run.get("trigger") for run in self._runs}),
                "runs": len(self._runs),
                "events": len(self._events),
                "ttsDownloads": sum(1 for entry in tts_entries if not entry.get("error")),
                "ttsErrors": sum(1 for entry in tts_entries if entry.get("error")),
                "microphoneAudioBytes": sum(int(run.get("audioBytesSent", 0)) for run in self._runs),
                "streamedAudioBytes": self._streamed_audio_bytes,
                "errors": self._errors,
            },
        }

    def _write_events_json(self) -> None:
        path = pathlib.Path(self.cfg.events_json)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(self.events_document(), ensure_ascii=False, indent=2)
            temporary = path.with_name(path.name + ".tmp")
            temporary.write_text(payload, encoding="utf-8")
            os.replace(temporary, path)
        except OSError as err:
            _LOGGER.warning("cannot write events journal %s: %s", path, err)
            self.exit_code = 1

    # ------------------------------------------------------------------ TCP clients

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._client_seq += 1
        peer_info = writer.get_extra_info("peername")
        peer = f"{peer_info[0]}:{peer_info[1]}" if isinstance(peer_info, tuple) and len(peer_info) >= 2 else str(peer_info)
        conn = _ClientConn(client_id=self._client_seq, peer=peer, reader=reader, writer=writer)
        self.clients.append(conn)
        self._connections[conn.client_id] = {
            "id": conn.client_id,
            "peer": peer,
            "connectedAt": conn.connected_at,
            "helloAt": None,
            "subscribedAt": None,
            "unsubscribedAt": None,
            "disconnectedAt": None,
            "voiceSubscriptionFlags": None,
        }
        self._append_event(
            direction="system",
            message_type="client_connected",
            peer=peer,
            connection=conn.client_id,
        )
        _LOGGER.info("client %s connected as #%d", peer, conn.client_id)
        try:
            while not conn.closed:
                frame = await read_frame(reader)
                if frame is None:
                    _LOGGER.debug("client %s closed the connection", peer)
                    break
                message_type, payload = frame
                conn.last_rx_monotonic = time.monotonic()
                should_close = await self._dispatch(conn, message_type, payload)
                if should_close:
                    break
        except ProtocolError as err:
            _LOGGER.warning("client %s: protocol error: %s", peer, err)
            self._errors.append({"tsIso": _iso_now(), "peer": peer, "error": f"protocol error: {err}"})
        except (ConnectionError, asyncio.IncompleteReadError) as err:
            _LOGGER.debug("client %s: connection lost: %s", peer, err)
        finally:
            await self._disconnect(conn)

    async def _dispatch(self, conn: _ClientConn, message_type: int, payload: bytes) -> bool:
        """Handle one frame; True asks the connection loop to close afterwards."""
        message = decode_message(message_type, payload)
        if message is None:
            _LOGGER.debug("client %s: unsupported message id %d (%d bytes)", conn.peer, message_type, len(payload))
            self._append_event(
                direction="in",
                message_type=f"unsupported_{message_type}",
                peer=conn.peer,
                connection=conn.client_id,
            )
            return False

        if message_type == MSG_PING_REQUEST:
            await conn.send_message(api_pb2.PingResponse())
            return False
        if message_type == MSG_VOICE_ASSISTANT_AUDIO:
            self._handle_voice_assistant_audio(conn, message)
            return False
        if message_type == MSG_VOICE_ASSISTANT_EVENT_RESPONSE:
            self._handle_voice_assistant_event(conn, message)
            return False

        self._record_in_message(conn, message)

        if message_type == MSG_HELLO_REQUEST:
            await self._handle_hello(conn, message)
        elif message_type == MSG_DEVICE_INFO_REQUEST:
            await self._handle_device_info(conn)
        elif message_type == MSG_LIST_ENTITIES_REQUEST:
            await conn.send_message(api_pb2.ListEntitiesDoneResponse())
            self._record_out_message(None, api_pb2.ListEntitiesDoneResponse())
        elif message_type == MSG_SUBSCRIBE_STATES_REQUEST:
            _LOGGER.debug("client %s subscribed to entity states; the mock has no entities", conn.peer)
        elif message_type == MSG_SUBSCRIBE_LOGS_REQUEST:
            _LOGGER.debug("client %s subscribed to logs; the mock does not send log lines", conn.peer)
        elif message_type == MSG_SUBSCRIBE_VOICE_ASSISTANT_REQUEST:
            await self._handle_subscribe_voice_assistant(conn, message)
        elif message_type == MSG_VOICE_ASSISTANT_RESPONSE:
            await self._handle_voice_assistant_response(conn, message)
        elif message_type == MSG_VOICE_ASSISTANT_ANNOUNCE_REQUEST:
            await self._handle_announce_request(conn)
        elif message_type == MSG_VOICE_ASSISTANT_CONFIGURATION_REQUEST:
            await self._handle_voice_assistant_configuration(conn)
        elif message_type == MSG_DEVICE_CAPABILITIES_REQUEST:
            await self._handle_device_capabilities(conn)
        elif message_type == MSG_DISCONNECT_REQUEST:
            await conn.send_message(api_pb2.DisconnectResponse())
            self._record_out_message(None, api_pb2.DisconnectResponse())
            _LOGGER.info("client %s asked to disconnect", conn.peer)
            return True
        elif message_type == MSG_VOICE_ASSISTANT_REQUEST:
            _LOGGER.warning("client %s sent VoiceAssistantRequest (device->server message); ignored", conn.peer)
        else:
            _LOGGER.debug("client %s: no handler for %s", conn.peer, type(message).__name__)
        return False

    async def _disconnect(self, conn: _ClientConn) -> None:
        if conn.closed:
            return
        conn.closed = True
        was_owner = conn.is_voice_owner
        if conn in self.clients:
            self.clients.remove(conn)
        conn.is_voice_owner = False
        self._connections[conn.client_id]["disconnectedAt"] = _iso_now()
        self._append_event(
            direction="system",
            message_type="client_disconnected",
            peer=conn.peer,
            connection=conn.client_id,
            data={"wasVoiceOwner": was_owner},
        )
        _LOGGER.info("client %s disconnected (voice owner: %s)", conn.peer, was_owner)
        if was_owner:
            state = self._run
            if state is not None and not state.finished.is_set():
                if state.queue is not None:
                    with contextlib.suppress(asyncio.QueueFull):
                        state.queue.put_nowait(("cancel", "subscriber-disconnected"))
                else:
                    state.error = "voice assistant subscriber disconnected"
        self._update_voice_owner("client-disconnected")
        with contextlib.suppress(ConnectionError, OSError):
            conn.writer.close()
            await conn.writer.wait_closed()

    async def _handle_hello(self, conn: _ClientConn, message: Any) -> None:
        conn.hello_received = True
        peer = self._connections[conn.client_id]
        peer["helloAt"] = _iso_now()
        peer["hello"] = {
            "clientInfo": message.client_info,
            "apiVersion": f"{message.api_version_major}.{message.api_version_minor}",
        }
        response = api_pb2.HelloResponse(
            api_version_major=self.cfg.api_major,
            api_version_minor=self.cfg.api_minor,
            server_info=f"pulsar {self.cfg.project_version}",
            name=self.cfg.device_name,
        )
        await conn.send_message(response)
        self._record_out_message(None, response)
        _LOGGER.info(
            "client %s: hello (client_info=%r, api %d.%d) -> mock device %r api %d.%d",
            conn.peer,
            message.client_info,
            message.api_version_major,
            message.api_version_minor,
            self.cfg.device_name,
            self.cfg.api_major,
            self.cfg.api_minor,
        )

    def _device_info_response(self) -> Any:
        return api_pb2.DeviceInfoResponse(
            uses_password=False,
            name=self.cfg.device_name,
            mac_address=self.cfg.mac_address,
            esphome_version=self.cfg.esphome_version,
            compilation_time=self.started_at or _iso_now(),
            model=self.cfg.model,
            manufacturer=self.cfg.manufacturer,
            friendly_name=self.cfg.friendly_name,
            project_name=self.cfg.project_name,
            project_version=self.cfg.project_version,
            voice_assistant_feature_flags=self.cfg.feature_flags,
            api_encryption_supported=False,
            api_encryption_provisionable=False,
        )

    async def _handle_device_info(self, conn: _ClientConn) -> None:
        response = self._device_info_response()
        await conn.send_message(response)
        self._record_out_message(None, response)
        _LOGGER.debug("client %s: sent DeviceInfoResponse", conn.peer)

    async def _handle_device_capabilities(self, conn: _ClientConn) -> None:
        response = api_pb2.DeviceCapabilitiesResponse(
            voice_assistant=api_pb2.VoiceAssistantCapabilities(feature_flags=self.cfg.feature_flags)
        )
        await conn.send_message(response)
        self._record_out_message(None, response)

    async def _handle_voice_assistant_configuration(self, conn: _ClientConn) -> None:
        response = api_pb2.VoiceAssistantConfigurationResponse(
            available_wake_words=[
                api_pb2.VoiceAssistantWakeWord(id="alisa", wake_word="алиса", trained_languages=["ru"])
            ],
            active_wake_words=["alisa"],
            max_active_wake_words=1,
        )
        await conn.send_message(response)
        self._record_out_message(None, response)

    async def _handle_announce_request(self, conn: _ClientConn) -> None:
        # Real pulsar plays the announcement and then reports it finished.
        response = api_pb2.VoiceAssistantAnnounceFinished(success=True)
        await conn.send_message(response)
        self._record_out_message(None, response)
        _LOGGER.info("client %s: announcement request, answered AnnounceFinished(success=true)", conn.peer)

    # ------------------------------------------------------------------ voice assistant slot

    def _voice_owner(self) -> _ClientConn | None:
        subscribed = [conn for conn in self.clients if conn.subscribed_seq]
        if not subscribed:
            return None
        return max(subscribed, key=lambda conn: conn.subscribed_seq)

    async def _handle_subscribe_voice_assistant(self, conn: _ClientConn, message: Any) -> None:
        if message.subscribe:
            self._subscribe_seq += 1
            conn.subscribed_seq = self._subscribe_seq
            conn.subscription_flags = message.flags
            peer = self._connections[conn.client_id]
            peer["subscribedAt"] = peer["subscribedAt"] or _iso_now()
            peer["voiceSubscriptionFlags"] = message.flags
            _LOGGER.info(
                "client %s subscribed to the voice assistant (flags=%d); slot owner is now %s",
                conn.peer,
                message.flags,
                conn.peer,
            )
        else:
            conn.subscribed_seq = 0
            conn.subscription_flags = 0
            self._connections[conn.client_id]["unsubscribedAt"] = _iso_now()
            _LOGGER.info("client %s unsubscribed from the voice assistant", conn.peer)
        self._update_voice_owner("subscribed" if message.subscribe else "unsubscribed")
        if message.subscribe:
            self._maybe_auto_start()

    def _update_voice_owner(self, reason: str) -> None:
        owner = self._voice_owner()
        previous = next((conn for conn in self.clients if conn.is_voice_owner), None)
        if previous is owner:
            return
        for conn in self.clients:
            conn.is_voice_owner = conn is owner
        self._append_event(
            direction="system",
            message_type="voice_slot",
            data={
                "owner": owner.peer if owner else None,
                "previousOwner": previous.peer if previous else None,
                "reason": reason,
            },
        )
        _LOGGER.info(
            "voice assistant pipeline: %s -> %s (%s)",
            previous.peer if previous else "none",
            owner.peer if owner else "none",
            reason,
        )

    # ------------------------------------------------------------------ voice assistant messages from the server

    def _handle_voice_assistant_event(self, conn: _ClientConn, message: Any) -> None:
        short = va_event_short_name(message.event_type)
        data = {item.name: item.value for item in message.data}
        owner = self._voice_owner()
        is_owner = owner is conn
        state = self._run
        run_index: int | None = None
        if state is not None and state.current_run is not None and is_owner:
            run_index = int(state.current_run["index"])
            state.current_run.setdefault("eventOrder", []).append(short)
            state.current_run["lastEventAt"] = _iso_now()
        record = self._append_event(
            direction="in",
            message_type="VoiceAssistantEventResponse",
            event=short,
            run=run_index,
            data=data,
            peer=conn.peer,
            connection=conn.client_id,
        )
        record["eventType"] = message.event_type
        record["eventRaw"] = va_event_raw_name(message.event_type)
        summary = f" {data}" if data else ""
        _LOGGER.info("run %s: event %s%s", run_index if run_index is not None else "-", short, summary)
        if not is_owner:
            _LOGGER.debug("client %s sent a voice event but is not the pipeline owner; event recorded only", conn.peer)
            return
        if state is not None and state.queue is not None and state.current_run is not None:
            with contextlib.suppress(asyncio.QueueFull):
                state.queue.put_nowait(("event", short, data))

    def _handle_voice_assistant_audio(self, conn: _ClientConn, message: Any) -> None:
        payload = bytes(message.data) + bytes(getattr(message, "data2", b"") or b"")
        self._streamed_audio_bytes += len(payload)
        if self.cfg.out_streamed_wav:
            self._streamed_audio.extend(payload)
        if not self._warned_streamed_audio and payload:
            self._warned_streamed_audio = True
            destination = f"saving it to {self.cfg.out_streamed_wav}" if self.cfg.out_streamed_wav else "discarding it"
            _LOGGER.warning(
                "client %s streams TTS as VoiceAssistantAudio; real pulsar ignores this and plays "
                "the TTS_END url instead (%s). Streamed audio is never counted as the answer.",
                conn.peer,
                destination,
            )
        self._streamed_audio_events += 1
        if self._streamed_audio_events <= self.cfg.streamed_audio_event_limit:
            self._append_event(
                direction="in",
                message_type="VoiceAssistantAudio",
                run=int(self._run.current_run["index"]) if self._run and self._run.current_run else None,
                data={"bytes": len(payload), "end": bool(message.end)},
                peer=conn.peer,
                connection=conn.client_id,
            )
        if message.end:
            _LOGGER.info("client %s sent the streamed audio end marker", conn.peer)

    async def _handle_voice_assistant_response(self, conn: _ClientConn, message: Any) -> None:
        if message.error:
            _LOGGER.warning("client %s rejected the run: VoiceAssistantResponse(error=true)", conn.peer)
            state = self._run
            if state is not None and state.queue is not None:
                with contextlib.suppress(asyncio.QueueFull):
                    state.queue.put_nowait(("error", "server answered VoiceAssistantResponse(error=true)"))
        else:
            _LOGGER.info("client %s accepted the run (VoiceAssistantResponse port=%d)", conn.peer, message.port)

    # ------------------------------------------------------------------ run control

    def start_run(
        self,
        *,
        wav: str | None = None,
        followup_wav: str | None = None,
        conversation_id: str | None = None,
        cancel_after_ms: int | None = None,
        disable_followup: bool = False,
    ) -> _RunState:
        """Trigger a run; raises RunBusyError / NoSubscriberError / WavFormatError."""
        if self._run is not None and not self._run.finished.is_set():
            raise RunBusyError(f"run {self._run.index} is already active")
        owner = self._voice_owner()
        if owner is None:
            raise NoSubscriberError("no client subscribed to the voice assistant")
        wav_path = wav or self.cfg.wav
        if not wav_path:
            raise WavFormatError("no --wav given")
        wav_pcm = read_wav(wav_path)
        followup_path: str | None = None
        followup_pcm: PcmWav | None = None
        if not disable_followup:
            followup_path = followup_wav if followup_wav is not None else self.cfg.followup_wav
            if followup_path:
                followup_pcm = read_wav(followup_path)
        conversation = conversation_id or self.cfg.conversation_id or f"mock-{uuid.uuid4().hex[:12]}"
        cancel_after = self.cfg.cancel_after_ms if cancel_after_ms is None else max(0, cancel_after_ms)
        self._trigger_seq += 1
        state = _RunState(
            index=self._trigger_seq,
            conversation_id=conversation,
            wav=wav_pcm,
            wav_path=str(wav_path),
            followup_wav=followup_pcm,
            followup_path=str(followup_path) if followup_path else None,
            cancel_after_ms=cancel_after,
        )
        self._run = state
        self.state = "running"
        self._append_event(
            direction="system",
            message_type="run_triggered",
            data={
                "trigger": state.index,
                "wav": state.wav_path,
                "followupWav": state.followup_path,
                "conversationId": conversation,
                "subscriber": owner.peer,
                "cancelAfterMs": cancel_after,
            },
        )
        _LOGGER.info(
            "trigger %d: wav=%s followup=%s conversation=%s subscriber=%s",
            state.index,
            wav_path,
            followup_path or "-",
            conversation,
            owner.peer,
        )
        state.task = asyncio.create_task(self._drive_run(state), name=f"mock-run-{state.index}")
        return state

    async def wait_run(self, state: _RunState, timeout: float = 120.0) -> None:
        await asyncio.wait_for(state.finished.wait(), timeout=timeout)

    async def wait_idle(self, timeout: float = 120.0) -> None:
        deadline = time.monotonic() + timeout
        while self.state != "idle":
            if time.monotonic() > deadline:
                raise TimeoutError("mock satellite did not become idle in time")
            await asyncio.sleep(0.02)

    def request_stop(self, reason: str = "stop") -> bool:
        state = self._run
        if state is None or state.finished.is_set() or state.current_run is None or state.queue is None:
            return False
        if state.cancel_requested:
            return False
        state.cancel_requested = True
        with contextlib.suppress(asyncio.QueueFull):
            state.queue.put_nowait(("cancel", reason))
        _LOGGER.info("trigger %d: stop requested (%s)", state.index, reason)
        return True

    def _maybe_auto_start(self) -> None:
        if not self.cfg.auto_start or self.state != "idle" or self._voice_owner() is None:
            return
        if self._auto_start_task is not None and not self._auto_start_task.done():
            return
        self._auto_start_task = asyncio.create_task(self._auto_start_later(), name="mock-auto-start")

    async def _auto_start_later(self) -> None:
        await asyncio.sleep(0.2)
        if self._shutdown.is_set() or self.state != "idle" or self._voice_owner() is None:
            return
        try:
            state = self.start_run()
        except (RunBusyError, NoSubscriberError) as err:
            _LOGGER.warning("auto-start skipped: %s", err)
            return
        except WavFormatError as err:
            _LOGGER.error("auto-start failed: %s", err)
            self.exit_code = 1
            return
        _LOGGER.info("auto-start: trigger %d", state.index)

    # ------------------------------------------------------------------ run engine

    async def _drive_run(self, state: _RunState) -> None:
        try:
            await self._execute_turn(
                state,
                state.wav,
                phrase=self.cfg.wake_word_phrase,
                flags=self.cfg.flags,
                turn=1,
            )
            if state.cancel_requested:
                state.end_reason = state.cancel_reason or "cancelled"
            elif state.error:
                state.end_reason = "error"
            elif state.continue_conversation and state.followup_wav is not None and not self._shutdown.is_set():
                _LOGGER.info(
                    "trigger %d: INTENT_END continue_conversation=1 -> new follow-up run with empty wake word",
                    state.index,
                )
                await self._execute_turn(state, state.followup_wav, phrase="", flags=0, turn=2)
                if state.cancel_requested:
                    state.end_reason = state.cancel_reason or "cancelled"
                elif state.error:
                    state.end_reason = "error"
                else:
                    state.end_reason = "run_end"
            elif state.continue_conversation:
                _LOGGER.warning(
                    "trigger %d: continue_conversation=1 but no follow-up WAV is configured; ending",
                    state.index,
                )
                state.end_reason = "run_end"
            else:
                state.end_reason = "run_end"
        except asyncio.CancelledError:
            state.end_reason = "shutdown"
            raise
        except Exception as err:  # noqa: BLE001 - a failure must end the run and surface in the journal
            _LOGGER.exception("trigger %d failed: %s", state.index, err)
            state.error = str(err)
            state.end_reason = "error"
            self.exit_code = 1
            self._errors.append({"tsIso": _iso_now(), "trigger": state.index, "error": str(err)})
        finally:
            state.finished.set()
            if self._run is state:
                self._run = None
            self.state = "idle"
            self._append_event(
                direction="system",
                message_type="run_finished",
                data={
                    "trigger": state.index,
                    "reason": state.end_reason,
                    "error": state.error,
                    "continueConversation": state.continue_conversation,
                },
            )
            _LOGGER.info(
                "trigger %d finished: %s%s",
                state.index,
                state.end_reason,
                f" (error: {state.error})" if state.error else "",
            )
            self._flush_streamed_audio()
            self._write_events_json()
            self._maybe_exit_after_run()

    def _begin_run_record(self, state: _RunState, phrase: str, flags: int, turn: int) -> dict[str, Any]:
        self._start_seq += 1
        record: dict[str, Any] = {
            "index": self._start_seq,
            "trigger": state.index,
            "turn": turn,
            "conversationId": state.conversation_id,
            "wav": state.followup_path if turn > 1 else state.wav_path,
            "wakeWordPhrase": phrase,
            "flags": flags,
            "startedAt": _iso_now(),
            "endedAt": None,
            "state": "running",
            "endReason": None,
            "audioBytesSent": 0,
            "audioChunksSent": 0,
            "continueConversation": None,
            "tts": [],
            "eventOrder": [],
        }
        self._runs.append(record)
        return record

    async def _execute_turn(self, state: _RunState, wav: PcmWav, *, phrase: str, flags: int, turn: int) -> None:
        owner = self._voice_owner()
        if owner is None:
            raise NoSubscriberError("voice assistant subscriber disappeared before the run turn")
        run_record = self._begin_run_record(state, phrase, flags, turn)
        state.current_run = run_record
        state.queue = asyncio.Queue()

        request = api_pb2.VoiceAssistantRequest(
            start=True,
            flags=flags,
            wake_word_phrase=phrase,
            audio_settings=api_pb2.VoiceAssistantAudioSettings(
                noise_suppression_level=0,
                auto_gain=0,
                volume_multiplier=1.0,
            ),
        )
        if state.conversation_id:
            request.conversation_id = state.conversation_id
        await owner.send_message(request)
        self._record_out_message(int(run_record["index"]), request)
        run_record.setdefault("outbound", []).append("start_request_sent")
        _LOGGER.info(
            "run %d turn %d: VoiceAssistantRequest(start=true, wake_word_phrase=%r, flags=%d) -> %s",
            run_record["index"],
            turn,
            phrase,
            flags,
            owner.peer,
        )

        stream_task = asyncio.create_task(
            self._stream_pcm(state, owner, wav, run_record), name=f"mock-audio-run-{run_record['index']}"
        )
        tts_task: asyncio.Task[None] | None = None
        cancel_timer: asyncio.Task[None] | None = None
        cancel_reason: str | None = None
        error: str | None = None
        run_end_received = False
        tts_grace_started: float | None = None

        try:
            if state.cancel_after_ms > 0:
                cancel_timer = asyncio.create_task(
                    self._cancel_after(state, state.cancel_after_ms),
                    name=f"mock-cancel-{state.index}",
                )
            deadline = time.monotonic() + self.cfg.turn_timeout
            while True:
                if stream_task.done() and not stream_task.cancelled():
                    stream_error = stream_task.exception()
                    if stream_error is not None:
                        raise stream_error
                if run_end_received and stream_task.done():
                    if tts_task is not None:
                        await self._await_tts(tts_task)
                        break
                    if tts_grace_started is None:
                        tts_grace_started = time.monotonic()
                    elif time.monotonic() - tts_grace_started >= self.cfg.tts_end_grace:
                        _LOGGER.warning(
                            "run %d turn %d: RUN_END without TTS_END; no TTS answer to download",
                            run_record["index"],
                            turn,
                        )
                        break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    error = f"turn timeout after {self.cfg.turn_timeout:.1f}s"
                    _LOGGER.warning("run %d turn %d: %s", run_record["index"], turn, error)
                    break
                if state.queue is None:  # pragma: no cover - defensive
                    break
                try:
                    item = await asyncio.wait_for(state.queue.get(), timeout=min(max(remaining, 0.01), 0.2))
                except asyncio.TimeoutError:
                    continue
                kind = item[0]
                if kind == "cancel":
                    cancel_reason = str(item[1])
                    state.cancel_requested = True
                    await self._try_send_stop(owner, run_record, cancel_reason)
                    break
                if kind == "error":
                    error = str(item[1])
                    break
                _, short, data = item
                if short == "error":
                    error = data.get("message") or data.get("code") or "server reported VOICE_ASSISTANT_ERROR"
                    break
                if short == "run_end":
                    run_end_received = True
                elif short == "intent_end":
                    state.continue_conversation = str(data.get("continue_conversation", "0")).strip() == "1"
                    run_record["continueConversation"] = state.continue_conversation
                elif short == "tts_end":
                    url = (data.get("url") or "").strip()
                    run_record["ttsUrl"] = url
                    if tts_task is None:
                        tts_task = asyncio.create_task(
                            self._fetch_tts(run_record, url),
                            name=f"mock-tts-run-{run_record['index']}",
                        )
                    else:
                        _LOGGER.warning(
                            "run %d turn %d: a second TTS_END was received; only the first is downloaded",
                            run_record["index"],
                            turn,
                        )
                elif short == "tts_stream_end":
                    run_record["ttsStreamEndedAt"] = _iso_now()
        finally:
            if cancel_timer is not None:
                cancel_timer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await cancel_timer
            if not stream_task.done():
                stream_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await stream_task
            if tts_task is not None and not tts_task.done():
                if cancel_reason is not None or error is not None or state.cancel_requested:
                    tts_task.cancel()
                await self._await_tts(tts_task)

        run_record["endedAt"] = _iso_now()
        if cancel_reason is not None:
            run_record["state"] = "cancelled"
            run_record["endReason"] = cancel_reason
            state.cancel_reason = state.cancel_reason or cancel_reason
        elif error is not None:
            run_record["state"] = "error"
            run_record["endReason"] = "error"
            state.error = error
        else:
            run_record["state"] = "ended"
            run_record["endReason"] = "run_end"

        # pulsar reports the played answer to HA with VoiceAssistantAnnounceFinished
        # (voice_answer_finished in satellite/crates/pulsar-esphome).
        if cancel_reason is None and error is None:
            await self._try_send_announce_finished(owner, run_record)
        state.current_run = None
        state.queue = None

    async def _stream_pcm(
        self,
        state: _RunState,
        owner: _ClientConn,
        wav: PcmWav,
        run_record: dict[str, Any],
    ) -> None:
        chunk_bytes = self.cfg.chunk_bytes
        interval = self.cfg.chunk_interval_s
        started = time.monotonic()
        offset = 0
        chunks = 0
        while offset < len(wav.pcm):
            if self._shutdown.is_set() or state.cancel_requested or self._run is not state:
                break
            piece = wav.pcm[offset : offset + chunk_bytes]
            await owner.send_message(api_pb2.VoiceAssistantAudio(data=piece))
            offset += len(piece)
            chunks += 1
            run_record["audioBytesSent"] = offset
            run_record["audioChunksSent"] = chunks
            target = started + chunks * interval
            delay = target - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
        run_record["audioStreamedAt"] = _iso_now()
        _LOGGER.info(
            "run %d turn %d: streamed %d microphone bytes in %d chunks of %d bytes",
            run_record["index"],
            run_record["turn"],
            offset,
            chunks,
            chunk_bytes,
        )

    async def _cancel_after(self, state: _RunState, delay_ms: int) -> None:
        await asyncio.sleep(delay_ms / 1000.0)
        if self._run is not state or state.current_run is None or state.queue is None:
            return
        if state.cancel_requested:
            return
        state.cancel_requested = True
        with contextlib.suppress(asyncio.QueueFull):
            state.queue.put_nowait(("cancel", f"cancel-after-{delay_ms}ms"))

    async def _await_tts(self, task: asyncio.Task[None]) -> None:
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=self.cfg.tts_timeout + 2.0)
        except asyncio.TimeoutError:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            _LOGGER.warning("TTS download/playback did not finish within the timeout")
        except asyncio.CancelledError:
            if task.cancelled():
                return
            raise

    async def _try_send_stop(self, owner: _ClientConn, run_record: dict[str, Any], reason: str) -> bool:
        stop = api_pb2.VoiceAssistantRequest(start=False)
        try:
            await owner.send_message(stop)
        except (ConnectionError, OSError) as err:
            _LOGGER.warning("run %d: cannot send VoiceAssistantRequest(start=false): %s", run_record["index"], err)
            return False
        self._record_out_message(int(run_record["index"]), stop)
        run_record.setdefault("outbound", []).append("stop_request_sent")
        _LOGGER.info(
            "run %d turn %d: VoiceAssistantRequest(start=false) -> %s (%s)",
            run_record["index"],
            run_record["turn"],
            owner.peer,
            reason,
        )
        return True

    async def _try_send_announce_finished(self, owner: _ClientConn, run_record: dict[str, Any]) -> None:
        message = api_pb2.VoiceAssistantAnnounceFinished(success=True)
        try:
            await owner.send_message(message)
        except (ConnectionError, OSError) as err:
            _LOGGER.warning("run %d: cannot send VoiceAssistantAnnounceFinished: %s", run_record["index"], err)
            return
        self._record_out_message(int(run_record["index"]), message)
        run_record.setdefault("outbound", []).append("announce_finished_sent")

    # ------------------------------------------------------------------ TTS answers (played from url)

    def _next_tts_output_path(self) -> pathlib.Path:
        base = pathlib.Path(self.cfg.out)
        self._tts_seq += 1
        if self._tts_seq == 1:
            return base
        return base.with_name(f"{base.stem}-{self._tts_seq}{base.suffix}")

    async def _fetch_tts(self, run_record: dict[str, Any], url: str) -> None:
        entry: dict[str, Any] = {
            "run": run_record["index"],
            "turn": run_record["turn"],
            "url": url,
            "requestedAt": _iso_now(),
            "status": None,
            "error": None,
        }
        run_record.setdefault("tts", []).append(entry)
        started = time.monotonic()
        try:
            if not url:
                raise ValueError("TTS_END carries no url (pulsar plays the answer from that url)")
            if not url.startswith(("http://", "https://")):
                raise ValueError(f"unsupported TTS url (only http/https): {url!r}")
            if self._http is None:
                raise RuntimeError("HTTP session is not available")
            timeout = aiohttp.ClientTimeout(total=self.cfg.tts_timeout)
            headers = dict(self.cfg.tts_headers) or None
            async with self._http.get(url, timeout=timeout, headers=headers) as response:
                body = await response.read()
                entry["status"] = response.status
                entry["contentType"] = response.headers.get("Content-Type", "")
                entry["bytes"] = len(body)
            if not 200 <= int(entry["status"]) < 300:
                raise RuntimeError(f"HTTP {entry['status']} from the TTS url")
            output_path = self._next_tts_output_path()
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(body)
            entry["savedPath"] = str(output_path)
            entry["riffWave"] = is_riff_wav(body)
            duration = wav_duration_s(body)
            if duration is not None:
                entry["durationMs"] = round(duration * 1000.0)
            entry["downloadMs"] = round((time.monotonic() - started) * 1000.0)
            self._append_event(
                direction="tts",
                message_type="tts_download",
                run=int(run_record["index"]),
                data=dict(entry),
            )
            _LOGGER.info(
                "run %d turn %d: TTS answer downloaded: %d bytes, HTTP %s, %s, saved to %s",
                run_record["index"],
                run_record["turn"],
                entry["bytes"],
                entry["status"],
                entry["contentType"] or "no content-type",
                output_path,
            )
            if duration is not None and self.cfg.pace_factor > 0:
                # Real pulsar plays the file via GStreamer; keep the playback time so the
                # bridge sees the follow-up request at a realistic moment.
                playback_s = duration / self.cfg.pace_factor
                entry["simulatedPlaybackMs"] = round(playback_s * 1000.0)
                await asyncio.sleep(playback_s)
        except asyncio.CancelledError:
            entry["error"] = "cancelled"
            raise
        except Exception as err:  # noqa: BLE001 - every download failure must be journaled
            entry["error"] = str(err)
            self._append_event(
                direction="tts",
                message_type="tts_error",
                run=int(run_record["index"]),
                data=dict(entry),
            )
            _LOGGER.warning(
                "run %d turn %d: cannot play TTS answer from %r: %s",
                run_record["index"],
                run_record["turn"],
                url,
                err,
            )

    def _flush_streamed_audio(self) -> None:
        if not self.cfg.out_streamed_wav or not self._streamed_audio:
            return
        raw = bytes(self._streamed_audio)
        if len(raw) % 2:
            raw = raw[:-1]
        path = pathlib.Path(self.cfg.out_streamed_wav)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(wav_bytes(raw))
        except OSError as err:
            _LOGGER.warning("cannot write streamed audio debug WAV %s: %s", path, err)
            self.exit_code = 1

    # ------------------------------------------------------------------ HTTP control

    async def _start_control_server(self) -> None:
        if self.cfg.control_port < 0:
            _LOGGER.info("HTTP control is disabled (--control-port is negative)")
            return
        app = web.Application()
        app.router.add_get("/health", self._http_health)
        app.router.add_get("/status", self._http_status)
        app.router.add_get("/events", self._http_events)
        app.router.add_post("/start", self._http_start)
        app.router.add_post("/stop", self._http_stop)
        self._control_runner = web.AppRunner(app, access_log=None)
        await self._control_runner.setup()
        site = web.TCPSite(self._control_runner, self.cfg.control_host, self.cfg.control_port)
        await site.start()
        addresses = self._control_runner.addresses
        if addresses:
            self.control_port = int(addresses[0][1])
        _LOGGER.info(
            "HTTP control listening on http://%s:%d (GET /status, POST /start, POST /stop, GET /events)",
            self.cfg.control_host,
            self.control_port,
        )

    async def _http_health(self, request: web.Request) -> web.Response:  # noqa: ARG002 - aiohttp handler signature
        return web.json_response({"status": "ok", "device": self.cfg.device_name, "state": self.state})

    async def _http_status(self, request: web.Request) -> web.Response:  # noqa: ARG002
        owner = self._voice_owner()
        state = self._run
        return web.json_response(
            {
                "status": "ok",
                "state": self.state,
                "device": {
                    "name": self.cfg.device_name,
                    "friendlyName": self.cfg.friendly_name,
                    "macAddress": self.cfg.mac_address,
                    "esphomeVersion": self.cfg.esphome_version,
                },
                "tcp": {"host": self.cfg.host, "port": self.tcp_port},
                "control": {"host": self.cfg.control_host, "port": self.control_port},
                "clients": [
                    {
                        "id": conn.client_id,
                        "peer": conn.peer,
                        "hello": conn.hello_received,
                        "subscribed": bool(conn.subscribed_seq),
                        "voiceOwner": conn.is_voice_owner,
                    }
                    for conn in self.clients
                ],
                "voiceOwner": owner.peer if owner else None,
                "run": (
                    {
                        "trigger": state.index,
                        "conversationId": state.conversation_id,
                        "turn": state.current_run["turn"] if state.current_run else None,
                        "cancelRequested": state.cancel_requested,
                        "cancelAfterMs": state.cancel_after_ms,
                    }
                    if state is not None
                    else None
                ),
                "counts": {"triggers": self._trigger_seq, "runs": len(self._runs), "events": len(self._events)},
                "config": {
                    "wav": self.cfg.wav,
                    "followupWav": self.cfg.followup_wav,
                    "out": self.cfg.out,
                    "eventsJson": self.cfg.events_json,
                    "wakeWordPhrase": self.cfg.wake_word_phrase,
                    "flags": self.cfg.flags,
                    "chunkBytes": self.cfg.chunk_bytes,
                    "chunkMs": self.cfg.chunk_ms,
                    "paceFactor": self.cfg.pace_factor,
                },
            }
        )

    async def _http_events(self, request: web.Request) -> web.Response:  # noqa: ARG002
        return web.json_response(self.events_document())

    async def _http_start(self, request: web.Request) -> web.Response:
        body: dict[str, Any] = {}
        if request.can_read_body:
            try:
                parsed = await request.json()
            except json.JSONDecodeError:
                return web.json_response(
                    {"error": {"code": "bad_json", "message": "request body must be JSON"}}, status=400
                )
            if not isinstance(parsed, dict):
                return web.json_response(
                    {"error": {"code": "bad_json", "message": "request body must be a JSON object"}}, status=400
                )
            body = parsed
        for field in ("wav", "followup_wav", "conversation_id"):
            if body.get(field) is not None and not isinstance(body[field], str):
                return web.json_response(
                    {"error": {"code": f"bad_{field}", "message": f"{field} must be a string"}}, status=400
                )
        cancel_after_ms = body.get("cancel_after_ms")
        if cancel_after_ms is not None:
            if isinstance(cancel_after_ms, bool) or not isinstance(cancel_after_ms, int) or cancel_after_ms < 0:
                return web.json_response(
                    {"error": {"code": "bad_cancel_after_ms", "message": "cancel_after_ms must be a non-negative integer"}},
                    status=400,
                )
        followup = body.get("followup_wav")
        disable_followup = followup == ""
        try:
            state = self.start_run(
                wav=body.get("wav") or None,
                followup_wav=followup if isinstance(followup, str) and followup else None,
                conversation_id=body.get("conversation_id") or None,
                cancel_after_ms=cancel_after_ms,
                disable_followup=disable_followup,
            )
        except RunBusyError as err:
            return web.json_response({"error": {"code": "busy", "message": str(err)}}, status=409)
        except NoSubscriberError as err:
            return web.json_response({"error": {"code": "no_subscriber", "message": str(err)}}, status=409)
        except WavFormatError as err:
            return web.json_response({"error": {"code": "bad_wav", "message": str(err)}}, status=400)
        return web.json_response(
            {
                "status": "ok",
                "trigger": state.index,
                "conversationId": state.conversation_id,
                "wav": state.wav_path,
                "followupWav": state.followup_path,
                "cancelAfterMs": state.cancel_after_ms,
            }
        )

    async def _http_stop(self, request: web.Request) -> web.Response:  # noqa: ARG002
        stopped = self.request_stop("http-stop")
        state = self._run
        return web.json_response(
            {"status": "ok", "stopped": stopped, "trigger": state.index if state is not None else None}
        )
