"""Self test for the mock satellite: no bridge and no Home Assistant required.

Starts the mock, connects a real aioesphomeapi client (the same library the
bridge uses), and drives the full device-side conversation:

1. handshake, device info, entity list, capabilities, wake word configuration;
2. a normal run: the client receives VoiceAssistantRequest(start=true) with the
   wake word phrase, the microphone WAV bytes, then answers with pulsar's event
   order, a TTS url and run_end; follow-up is a new run with an empty phrase;
3. cancellation: VoiceAssistantRequest(start=false) in the middle of the audio;
4. the voice slot: the newest subscriber owns the pipeline and unsubscribing
   hands it back to the previous one.

The TTS answer is served by a local HTTP server, exactly like the bridge will
serve it, so the mock downloads and saves it the way pulsar plays it.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import pathlib
import shutil
import tempfile
import time
import traceback

import aiohttp
from aioesphomeapi import APIClient
from aioesphomeapi.model import VoiceAssistantEventType
from aiohttp import web

import make_fixtures
from mock_satellite import MockConfig, MockSatellite
from wav_utils import is_riff_wav, read_wav, wav_bytes

# Event order pulsar/HA produces for one turn (docs/voice.md, verified against pulsar sources).
EX_END = VoiceAssistantEventType.VOICE_ASSISTANT_RUN_END


def _short(value: object) -> str:
    """Compact repr for check details: full PCM dumps would flood the terminal."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        return f"<{len(raw)} bytes sha1={hashlib.sha1(raw).hexdigest()[:12]}>"
    text = repr(value)
    return text if len(text) <= 200 else text[:200] + "..."


class Checks:
    """Collects check results so the selftest can report all failures, not just the first."""

    def __init__(self) -> None:
        self.passed = 0
        self.failures: list[str] = []

    def ok(self, label: str) -> None:
        self.passed += 1
        print(f"  ok   {label}")

    def check(self, condition: bool, label: str, detail: str = "") -> None:
        if condition:
            self.ok(f"{label}{f' ({detail})' if detail else ''}")
        else:
            message = f"{label}{f': {detail}' if detail else ''}"
            self.failures.append(message)
            print(f"  FAIL {message}")

    def equal(self, actual: object, expected: object, label: str) -> None:
        detail = f"got {_short(actual)}, expected {_short(expected)}"
        if isinstance(actual, (bytes, bytearray)) and isinstance(expected, (bytes, bytearray)):
            raw_actual, raw_expected = bytes(actual), bytes(expected)
            if len(raw_actual) == len(raw_expected):
                mismatch = next((i for i, (a, b) in enumerate(zip(raw_actual, raw_expected)) if a != b), None)
                if mismatch is not None:
                    detail = f"first difference at byte {mismatch}; {_short(actual)} vs {_short(expected)}"
        self.check(actual == expected, label, detail)


async def _wait_for(predicate, timeout: float, description: str) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise TimeoutError(f"timed out waiting for {description}")
        await asyncio.sleep(0.02)


async def _http_get_json(session: aiohttp.ClientSession, url: str) -> tuple[int, dict]:
    async with session.get(url) as response:
        return response.status, await response.json()


async def _http_post_json(session: aiohttp.ClientSession, url: str, payload: dict | None = None) -> tuple[int, dict]:
    async with session.post(url, json=payload or {}) as response:
        return response.status, await response.json()


async def _wait_http_idle(session: aiohttp.ClientSession, base: str, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        status, document = await _http_get_json(session, f"{base}/status")
        if status == 200 and document.get("state") == "idle":
            return document
        if time.monotonic() > deadline:
            raise TimeoutError(f"mock satellite did not become idle, last status: {document!r}")
        await asyncio.sleep(0.02)


class _TtsServer:
    """Local HTTP server hosting the TTS answers the mock should download."""

    def __init__(self) -> None:
        tone_s = 0.2
        self.turn1 = wav_bytes(make_fixtures.tone_pcm(880.0, tone_s))
        self.turn2 = wav_bytes(make_fixtures.tone_pcm(990.0, tone_s))
        self.slow = wav_bytes(make_fixtures.tone_pcm(700.0, 1.0))
        self._runner: web.AppRunner | None = None
        self.base_url = ""

    async def start(self) -> None:
        app = web.Application()
        app.router.add_get("/tts/{name}", self._handle)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        port = int(self._runner.addresses[0][1])
        self.base_url = f"http://127.0.0.1:{port}"

    async def _handle(self, request: web.Request) -> web.Response:
        payload = {
            "turn1.wav": self.turn1,
            "turn2.wav": self.turn2,
            "slow.wav": self.slow,
        }.get(request.match_info["name"])
        if payload is None:
            return web.Response(status=404, text="no such TTS answer")
        return web.Response(body=payload, content_type="audio/wav")

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None


class _ClientHarness:
    """One aioesphomeapi client (stands in for the bridge) and what it observed."""

    def __init__(self, name: str, client: APIClient, kind: str) -> None:
        self.name = name
        self.client = client
        self.kind = kind  # "main": full pipeline events, "minimal": run_end only
        self.starts: list[dict[str, object]] = []
        self.segments: list[bytearray] = []
        self.audio_times: list[list[float]] = []
        self.stops: list[bool] = []
        self.pipeline_tasks: set[asyncio.Task[None]] = set()

    def handlers(self, ctx: dict[str, object]):
        async def handle_start(conversation_id, flags, audio_settings, wake_word_phrase):
            start_index = len(self.starts)
            self.starts.append(
                {
                    "conversationId": conversation_id,
                    "flags": flags,
                    "volumeMultiplier": audio_settings.volume_multiplier,
                    "wakeWordPhrase": wake_word_phrase,
                }
            )
            self.segments.append(bytearray())
            self.audio_times.append([])
            task = asyncio.create_task(self._pipeline(ctx, start_index), name=f"selftest-pipeline-{self.name}-{start_index}")
            self.pipeline_tasks.add(task)
            task.add_done_callback(self.pipeline_tasks.discard)
            return 0

        async def handle_stop(abort):
            self.stops.append(bool(abort))

        async def handle_audio(data, data2):
            self.segments[-1].extend(data)
            if data2:
                self.segments[-1].extend(data2)
            self.audio_times[-1].append(time.monotonic())

        return handle_start, handle_stop, handle_audio

    async def _pipeline(self, ctx: dict[str, object], start_index: int) -> None:
        try:
            await self._send_pipeline(ctx, start_index)
        except (asyncio.CancelledError, ConnectionError):
            pass

    async def _send_pipeline(self, ctx: dict[str, object], start_index: int) -> None:
        mode = str(ctx["mode"])
        if mode == "cancel":
            # The mock cancels the run; a real bridge would only report run.cancel here.
            await asyncio.sleep(0.6)
            return
        send = self.client.send_voice_assistant_event
        if self.kind == "minimal" or mode == "slot":
            await asyncio.sleep(0.02)
            send(VoiceAssistantEventType.VOICE_ASSISTANT_RUN_START, None)
            send(VoiceAssistantEventType.VOICE_ASSISTANT_RUN_END, None)
            return
        turn = start_index + 1
        transcripts = {1: "включи свет", 2: "а теперь выключи"}
        speeches = {1: "Включаю свет.", 2: "Выключаю."}
        await asyncio.sleep(0.05)
        # pulsar/HA order, see docs/voice.md "Голосовой ассистент HA (ESPHome)".
        send(VoiceAssistantEventType.VOICE_ASSISTANT_RUN_START, None)
        send(VoiceAssistantEventType.VOICE_ASSISTANT_STT_START, None)
        await asyncio.sleep(0.01)
        send(VoiceAssistantEventType.VOICE_ASSISTANT_STT_VAD_START, None)
        send(VoiceAssistantEventType.VOICE_ASSISTANT_STT_VAD_END, None)
        send(VoiceAssistantEventType.VOICE_ASSISTANT_STT_END, {"text": transcripts.get(turn, "")})
        send(VoiceAssistantEventType.VOICE_ASSISTANT_INTENT_START, None)
        continue_conversation = "1" if (turn == 1 and ctx["expect_followup"]) else "0"
        send(
            VoiceAssistantEventType.VOICE_ASSISTANT_INTENT_END,
            {"speech": speeches.get(turn, ""), "continue_conversation": continue_conversation},
        )
        send(VoiceAssistantEventType.VOICE_ASSISTANT_TTS_START, {"text": speeches.get(turn, "")})
        send(VoiceAssistantEventType.VOICE_ASSISTANT_TTS_STREAM_START, None)
        await asyncio.sleep(0.01)
        if turn == 1 and ctx["send_legacy_audio"]:
            # A bridge that still streams PCM instead of serving a url: pulsar ignores it,
            # the mock must accept it and journal it as unexpected.
            self.client.send_voice_assistant_audio(b"\x00\x01" * 512)
        await asyncio.sleep(0.02)
        send(VoiceAssistantEventType.VOICE_ASSISTANT_TTS_STREAM_END, None)
        default_tts = "turn1.wav" if turn == 1 else "turn2.wav"
        tts_name = str(ctx.get("tts_name") or default_tts)
        send(VoiceAssistantEventType.VOICE_ASSISTANT_TTS_END, {"url": f"{ctx['tts_base']}/tts/{tts_name}"})
        await asyncio.sleep(0.01)
        send(EX_END, None)


def _create_mock_config(workspace: pathlib.Path, fixtures: pathlib.Path) -> MockConfig:
    return MockConfig(
        host="127.0.0.1",
        port=0,
        control_host="127.0.0.1",
        control_port=0,
        wav=str(fixtures / "wake-run.wav"),
        followup_wav=str(fixtures / "followup.wav"),
        out=str(workspace / "tts-out.wav"),
        out_streamed_wav=str(workspace / "streamed-audio.wav"),
        events_json=str(workspace / "events.json"),
        chunk_ms=32,
        pace_factor=4.0,
        turn_timeout=15.0,
        tts_timeout=5.0,
        tts_end_grace=0.3,
        auto_start=False,
    )


async def _run_checks(checks: Checks) -> None:
    fixtures = make_fixtures.ensure()
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="mock-satellite-selftest-"))
    tts_server = _TtsServer()
    mock = MockSatellite(_create_mock_config(workspace, fixtures))
    clients: list[APIClient] = []
    session: aiohttp.ClientSession | None = None
    try:
        await tts_server.start()
        await mock.start()
        session = aiohttp.ClientSession()
        control = f"http://127.0.0.1:{mock.control_port}"
        ctx: dict[str, object] = {
            "mode": "normal",
            "expect_followup": True,
            "send_legacy_audio": True,
            "tts_base": tts_server.base_url,
        }

        # --- control API and no-subscriber error -------------------------------------
        status, health = await _http_get_json(session, f"{control}/health")
        checks.check(status == 200 and health.get("status") == "ok", "control /health answers ok")
        status, body = await _http_post_json(session, f"{control}/start")
        checks.check(
            status == 409 and body.get("error", {}).get("code") == "no_subscriber",
            "POST /start without a subscriber returns 409 no_subscriber",
            f"HTTP {status} {body!r}",
        )

        # --- handshake and device info ------------------------------------------------
        client_a = APIClient("127.0.0.1", mock.tcp_port, client_info="mock-satellite-selftest")
        clients.append(client_a)
        await client_a.connect()
        info = await client_a.device_info()
        checks.equal(info.name, "yandex-lite2-000001", "DeviceInfo.name")
        checks.equal(info.friendly_name, "Яндекс Станция Лайт 2", "DeviceInfo.friendly_name")
        checks.equal(info.mac_address, "02:00:00:00:00:01", "DeviceInfo.mac_address")
        checks.equal(info.esphome_version, "2026.9.0", "DeviceInfo.esphome_version")
        checks.equal(info.project_name, "pulsar.satellite", "DeviceInfo.project_name")
        checks.check(
            info.voice_assistant_feature_flags == 61,
            "DeviceInfo.voice_assistant_feature_flags matches pulsar (61 = VA|API_AUDIO|TIMERS|ANNOUNCE|START_CONVERSATION)",
            repr(info.voice_assistant_feature_flags),
        )
        entities, services = await client_a.list_entities_services()
        checks.check(entities == [] and services == [], "ListEntities returns no entities and Done")

        capabilities = await client_a.device_capabilities()
        checks.check(
            capabilities.voice_assistant.feature_flags == 61,
            "DeviceCapabilities.voice_assistant.feature_flags=61",
        )
        va_config = await client_a.get_voice_assistant_configuration(5)
        checks.check(
            [word.id for word in va_config.available_wake_words] == ["alisa"]
            and va_config.active_wake_words == ["alisa"],
            "VoiceAssistantConfiguration lists the alisa wake word",
        )

        # --- subscribe (the pipeline slot) --------------------------------------------
        harness_a = _ClientHarness("A", client_a, "main")
        handle_start_a, handle_stop_a, handle_audio_a = harness_a.handlers(ctx)
        unsub_a = client_a.subscribe_voice_assistant(
            handle_start=handle_start_a, handle_stop=handle_stop_a, handle_audio=handle_audio_a
        )
        await _wait_for(lambda: mock._voice_owner() is not None, 2.0, "voice assistant subscription")
        checks.check(mock._voice_owner() is mock.clients[0], "subscribed client owns the voice pipeline slot")

        status, body = await _http_post_json(session, f"{control}/start", {"wav": str(workspace / "missing.wav")})
        checks.check(
            status == 400 and body.get("error", {}).get("code") == "bad_wav",
            "POST /start with a missing WAV returns 400 bad_wav",
            f"HTTP {status}",
        )

        # --- normal run with TTS by url and follow-up ----------------------------------
        status, started = await _http_post_json(session, f"{control}/start", {})
        checks.check(status == 200 and started.get("status") == "ok", "POST /start triggers a run")
        status_doc = await _wait_http_idle(session, control)
        checks.check(status_doc.get("state") == "idle", "run finishes and the mock is idle again")
        await asyncio.gather(*harness_a.pipeline_tasks, return_exceptions=True)

        expected_order = [
            "run_start",
            "stt_start",
            "stt_vad_start",
            "stt_vad_end",
            "stt_end",
            "intent_start",
            "intent_end",
            "tts_start",
            "tts_stream_start",
            "tts_stream_end",
            "tts_end",
            "run_end",
        ]
        document = mock.events_document()
        runs = document["runs"]
        checks.equal(len(runs), 2, "a run and its follow-up are recorded as two device runs")
        if len(runs) >= 2:
            checks.equal(runs[0]["eventOrder"], expected_order, "first run event order matches pulsar/HA")
            checks.equal(runs[1]["eventOrder"], expected_order, "follow-up run event order matches pulsar/HA")
            checks.equal(runs[0]["wakeWordPhrase"], "Алиса", "first VoiceAssistantRequest carries the wake word phrase")
            checks.equal(runs[1]["wakeWordPhrase"], "", "follow-up VoiceAssistantRequest has an empty wake word phrase")
            checks.equal(runs[0]["conversationId"], runs[1]["conversationId"], "follow-up reuses the conversation id")
            checks.equal(runs[0]["continueConversation"], True, "INTENT_END continue_conversation=1 is recorded")
            checks.equal(runs[0]["audioBytesSent"], len(read_wav(str(fixtures / "wake-run.wav")).pcm), "first WAV fully streamed")
            checks.equal(
                runs[1]["audioBytesSent"],
                len(read_wav(str(fixtures / "followup.wav")).pcm),
                "follow-up WAV fully streamed",
            )
            chunk_count = (len(read_wav(str(fixtures / "wake-run.wav")).pcm) + 1023) // 1024
            checks.equal(runs[0]["audioChunksSent"], chunk_count, "microphone audio is sent in 1024-byte (32 ms) chunks")
            checks.equal(runs[0]["tts"][0]["status"], 200, "TTS_END url downloaded with HTTP 200")
            checks.check(runs[0]["tts"][0]["riffWave"] is True, "downloaded TTS answer is a RIFF/WAVE file")

        checks.equal(len(harness_a.starts), 2, "the client received two VoiceAssistantRequest(start=true)")
        if len(harness_a.starts) >= 2:
            first, second = harness_a.starts[0], harness_a.starts[1]
            checks.equal(first["wakeWordPhrase"], "Алиса", "client sees wake_word_phrase='Алиса' on the first start")
            checks.equal(first["flags"], 0, "client sees flags=0 (pulsar handles the wake word itself, VAD in HA)")
            checks.equal(first["volumeMultiplier"], 1.0, "client sees audio_settings.volume_multiplier=1.0")
            checks.check(second["wakeWordPhrase"] is None, "follow-up start has an empty wake_word_phrase", repr(second["wakeWordPhrase"]))
            checks.equal(second["conversationId"], first["conversationId"], "client sees the same conversation id for follow-up")
        checks.equal(bytes(harness_a.segments[0]), read_wav(str(fixtures / "wake-run.wav")).pcm, "client received exact WAV #1 PCM")
        checks.equal(
            bytes(harness_a.segments[1]),
            read_wav(str(fixtures / "followup.wav")).pcm,
            "client received exact follow-up WAV PCM",
        )
        if len(harness_a.audio_times[0]) >= 2:
            span = harness_a.audio_times[0][-1] - harness_a.audio_times[0][0]
            checks.check(0.1 < span < 2.0, "audio chunks are paced in real time (32 ms scaled by --pace-factor)", f"span={span:.3f}s")
        checks.equal(harness_a.stops, [], "no accidental start=false during a normal run")

        tts_out = workspace / "tts-out.wav"
        turns_out = workspace / "tts-out-2.wav"
        checks.check(tts_out.is_file(), "--out TTS answer file exists")
        if tts_out.is_file():
            checks.equal(tts_out.read_bytes(), tts_server.turn1, "--out contains the TTS answer downloaded from the url")
        checks.check(turns_out.is_file(), "follow-up TTS answer saved as the next file")
        if turns_out.is_file():
            checks.equal(turns_out.read_bytes(), tts_server.turn2, "follow-up TTS answer bytes match the served WAV")

        checks.equal(document["summary"]["streamedAudioBytes"], 1024, "unexpected streamed VoiceAssistantAudio is accepted and counted")
        checks.equal(document["summary"]["ttsDownloads"], 2, "two TTS answers were downloaded")
        streamed_debug = workspace / "streamed-audio.wav"
        checks.check(
            streamed_debug.is_file() and is_riff_wav(streamed_debug.read_bytes()),
            "--out-streamed-wav contains the legacy streamed audio (debug only)",
        )
        out_messages = [event for event in document["events"] if event["direction"] == "out"]
        request_starts = [
            event
            for event in out_messages
            if event["type"] == "VoiceAssistantRequest" and event.get("data", {}).get("start") is True
        ]
        checks.equal(len(request_starts), 2, "two VoiceAssistantRequest(start=true) were sent")
        announce_finished = [event for event in out_messages if event["type"] == "VoiceAssistantAnnounceFinished"]
        checks.equal(len(announce_finished), 2, "VoiceAssistantAnnounceFinished is sent after each played answer")
        checks.check(any(event["type"] == "HelloResponse" for event in out_messages), "HelloResponse is journaled")
        checks.check(any(event["type"] == "DeviceInfoResponse" for event in out_messages), "DeviceInfoResponse is journaled")
        status, events_via_http = await _http_get_json(session, f"{control}/events")
        checks.check(
            status == 200 and len(events_via_http.get("runs", [])) == 2,
            "GET /events returns the same journal",
        )

        # --- cancellation (barge-in) ----------------------------------------------------
        ctx["mode"] = "cancel"
        ctx["send_legacy_audio"] = False
        starts_before_cancel = len(harness_a.starts)
        status, body = await _http_post_json(
            session,
            f"{control}/start",
            {"wav": str(fixtures / "wake-run.wav"), "cancel_after_ms": 100},
        )
        checks.check(status == 200, "POST /start with cancel_after_ms accepted", f"HTTP {status}")
        await _wait_http_idle(session, control)
        checks.equal(len(harness_a.starts), starts_before_cancel + 1, "cancelled run reached the client")
        checks.equal(harness_a.stops[-1:], [True], "client got handle_stop(abort=True) after VoiceAssistantRequest(start=false)")
        document = mock.events_document()
        cancelled_runs = [run for run in document["runs"] if str(run.get("endReason") or "").startswith("cancel-after")]
        checks.equal(len(cancelled_runs), 1, "cancelled run is journaled with the cancel reason")
        if cancelled_runs:
            cancelled = cancelled_runs[0]
            checks.check(
                cancelled["audioBytesSent"] < len(read_wav(str(fixtures / "wake-run.wav")).pcm),
                "cancellation stopped the microphone stream mid-utterance",
                f"{cancelled['audioBytesSent']} bytes sent",
            )
        stop_requests = [
            event
            for event in document["events"]
            if event["direction"] == "out"
            and event["type"] == "VoiceAssistantRequest"
            and not event.get("data", {}).get("start")
        ]
        checks.equal(len(stop_requests), 1, "VoiceAssistantRequest(start=false) is journaled")

        # --- stop while the TTS answer is still playing -----------------------------------
        ctx["mode"] = "normal"
        ctx["expect_followup"] = False
        ctx["tts_name"] = "slow.wav"
        starts_before_stop = len(harness_a.starts)
        status, _ = await _http_post_json(session, f"{control}/start", {})
        checks.check(status == 200, "POST /start for the stop-during-TTS test accepted")
        await asyncio.sleep(0.18)
        status, stop_body = await _http_post_json(session, f"{control}/stop")
        checks.check(status == 200 and stop_body.get("stopped") is True, "POST /stop stops a run in progress")
        await _wait_http_idle(session, control)
        checks.equal(len(harness_a.starts), starts_before_stop + 1, "the stopped run had reached the client")
        document = mock.events_document()
        http_stopped = [run for run in document["runs"] if run.get("endReason") == "http-stop"]
        checks.equal(len(http_stopped), 1, "run stopped by POST /stop is journaled with reason http-stop")
        checks.check(
            any(entry.get("error") == "cancelled" for run in http_stopped for entry in run.get("tts", [])),
            "the in-flight TTS download/playback was cancelled, not counted as an answer",
        )
        checks.check(document["summary"]["errors"] == [], "cancelling during TTS is not reported as a run error")
        ctx["tts_name"] = None

        # --- voice assistant slot takeover ------------------------------------------------
        ctx["mode"] = "slot"
        ctx["send_legacy_audio"] = False
        client_b = APIClient("127.0.0.1", mock.tcp_port, client_info="mock-satellite-selftest-b")
        clients.append(client_b)
        await client_b.connect()
        harness_b = _ClientHarness("B", client_b, "minimal")
        handle_start_b, handle_stop_b, handle_audio_b = harness_b.handlers(ctx)
        unsub_b = client_b.subscribe_voice_assistant(
            handle_start=handle_start_b, handle_stop=handle_stop_b, handle_audio=handle_audio_b
        )
        await _wait_for(lambda: mock._voice_owner() is mock.clients[-1], 2.0, "second subscriber to take the slot")
        checks.check(mock._voice_owner() is mock.clients[-1], "newest subscriber takes the voice pipeline slot")
        starts_a_before_slot = len(harness_a.starts)
        state_b = mock.start_run(wav=str(fixtures / "short.wav"))
        await mock.wait_run(state_b)
        checks.equal(len(harness_b.starts), 1, "run went to the newest subscriber")
        checks.equal(len(harness_a.starts), starts_a_before_slot, "previous subscriber did not get the run")
        unsub_b()
        await _wait_for(lambda: mock._voice_owner() is mock.clients[0], 2.0, "slot to return to the first subscriber")
        checks.check(mock._voice_owner() is mock.clients[0], "unsubscribing hands the slot back to the previous subscriber")
        state_a = mock.start_run(wav=str(fixtures / "short.wav"))
        await mock.wait_run(state_a)
        checks.equal(len(harness_a.starts), starts_a_before_slot + 1, "run went back to the previous subscriber after unsubscribe")

        with contextlib.suppress(Exception):
            unsub_a()
        await asyncio.sleep(0.05)
        checks.check(mock._voice_owner() is None, "unsubscribing the last client leaves no pipeline owner")
    finally:
        for client in reversed(clients):
            with contextlib.suppress(Exception):
                await client.disconnect()
        if session is not None:
            await session.close()
        await mock.stop()
        await tts_server.stop()
        if checks.failures:
            print(f"\nartifacts kept for debugging: {workspace}")
        else:
            shutil.rmtree(workspace, ignore_errors=True)


async def run_selftest(*, verbose: bool = False) -> int:
    checks = Checks()
    print("== mock-satellite selftest ==")
    started = time.monotonic()
    try:
        await _run_checks(checks)
    except Exception:  # noqa: BLE001 - selftest must report any failure with a traceback
        traceback.print_exc()
        print("FAIL: the selftest raised an exception")
        return 1
    elapsed = time.monotonic() - started
    if checks.failures:
        print(f"\nFAIL: {len(checks.failures)} check(s) failed, {checks.passed} passed ({elapsed:.2f}s)")
        for failure in checks.failures:
            print(f"  - {failure}")
        return 1
    print(f"\nPASS: {checks.passed} checks passed in {elapsed:.2f}s")
    return 0
