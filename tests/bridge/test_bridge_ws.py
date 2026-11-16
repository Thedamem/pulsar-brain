"""Bridge WebSocket run against a mock addon (contracts §3)."""

from __future__ import annotations

import asyncio
import socket
import types
from urllib.parse import urlsplit

import aiohttp
import pytest

from helpers import MockAddonServer

RUN_ID = "0123456789abcdef0123456789abcdef"
DEVICE = {
    "name": "yandex-lite-2",
    "mac": "02:00:00:00:00:01",
    "firmware": "0.5.3",
}
BASE_URL = "http://ha.local:8123"


@pytest.fixture
async def server():
    mock = MockAddonServer()
    await mock.start()
    yield mock
    await mock.stop()


@pytest.fixture
async def session():
    timeout = aiohttp.ClientTimeout(total=None, connect=1, sock_read=2)
    async with aiohttp.ClientSession(timeout=timeout) as client:
        yield client


def make_run(
    component,
    session,
    server: MockAddonServer | None,
    *,
    phrase: str = "алиса включи свет",
    use_wake_word: bool = True,
    keepalive: float = 0.05,
    connect_timeout: float = 1.0,
    port: int | None = None,
):
    events: list[tuple[str, dict[str, str]]] = []
    finished: list[tuple[str, str]] = []
    store = component.tts_store.TtsStore("test-token", ttl=60)
    published: list[dict[str, object]] = []

    async def publish(run_id: str, text: str, wav: bytes) -> str:
        path = store.publish(run_id, wav)
        published.append({"run_id": run_id, "text": text, "wav": wav, "path": path})
        return component.protocol.join_base_url(BASE_URL, path)

    host = server.host if server is not None else "127.0.0.1"
    addon_port = server.port if server is not None else int(port or 1)
    addon = component.bridge.AddonClient(
        session, host, addon_port, "test-token", request_timeout=0.5
    )
    request = component.protocol.RunRequest(
        run_id=RUN_ID,
        device=component.protocol.DeviceDescriptor(**DEVICE),
        wake_word_phrase=phrase,
        use_wake_word=use_wake_word,
    )
    run = component.bridge.BridgeRun(
        session,
        addon,
        request,
        on_device_event=lambda name, data: events.append((name, data)),
        publish_tts=publish,
        on_finished=lambda run_id, reason: finished.append((run_id, reason)),
        keepalive_interval=keepalive,
        connect_timeout=connect_timeout,
    )
    return types.SimpleNamespace(
        run=run, events=events, finished=finished, published=published, store=store
    )


def event_names(record) -> list[str]:
    return [name for name, _data in record.events]


def event_data(record, name: str) -> dict[str, str]:
    for event, data in record.events:
        if event == name:
            return data
    raise AssertionError(f"event {name} not found in {event_names(record)}")


async def wait_event(record, name: str, *, timeout: float = 1.0) -> dict[str, str]:
    async def _wait() -> dict[str, str]:
        while True:
            for event, data in record.events:
                if event == name:
                    return data
            await asyncio.sleep(0.01)

    return await asyncio.wait_for(_wait(), timeout)


async def test_full_turn_sequence(component, server, session):
    record = make_run(component, session, server)
    record.run.start()

    run_start = await server.wait_run_start()
    assert run_start == {
        "type": "run.start",
        "protocol": 1,
        "runId": RUN_ID,
        "device": DEVICE,
        "wakeWord": "alisa",
        "wakeWordPhrase": "алиса включи свет",
        "flags": {"useWakeWord": True},
    }
    assert server.auth_headers == ["Bearer test-token"]
    assert server.messages[0]["type"] == "run.start"
    assert event_names(record)[:2] == ["run_start", "stt_start"]

    await server.send_json({"type": "run.accepted", "runId": RUN_ID})
    # Addon copies of bridge-owned events must not reach the device twice.
    await server.send_json({"type": "device.event", "event": "run_start", "data": {}})
    await server.send_json({"type": "device.event", "event": "stt_start", "data": {}})
    await server.send_json(
        {"type": "device.event", "event": "stt_vad_start", "data": {}}
    )
    await server.send_json(
        {"type": "device.event", "event": "stt_vad_end", "data": {}}
    )
    await server.send_json(
        {"type": "device.event", "event": "stt_end", "data": {"text": "включи свет"}}
    )
    await server.send_json(
        {"type": "device.event", "event": "intent_start", "data": {}}
    )
    await server.send_json(
        {
            "type": "device.event",
            "event": "intent_end",
            "data": {"speech": "Включаю", "continue_conversation": "1"},
        }
    )
    wav = component.wav.build_wav(b"\x01\x00" * 160)
    await server.send_json(
        {"type": "tts.start", "text": "Включаю", "format": "wav"}
    )
    await server.send_bytes(wav[:17])
    await server.send_bytes(wav[17:])
    await server.send_json({"type": "tts.end", "reason": "done"})

    await asyncio.wait_for(record.run.wait_closed(), 2)
    await server.wait_disconnected()

    assert event_names(record) == [
        "run_start",
        "stt_start",
        "stt_vad_start",
        "stt_vad_end",
        "stt_end",
        "intent_start",
        "intent_end",
        "tts_start",
        "tts_end",
        "run_end",
    ]
    assert event_data(record, "stt_end") == {"text": "включи свет"}
    assert event_data(record, "intent_end") == {
        "speech": "Включаю",
        "continue_conversation": "1",
    }
    assert event_data(record, "tts_start") == {"text": "Включаю"}

    url = event_data(record, "tts_end")["url"]
    assert url.startswith(f"{BASE_URL}/api/pulsar_brain/tts/{RUN_ID}/")
    filename = urlsplit(url).path.rsplit("/", 1)[1]
    assert record.store.resolve_file(RUN_ID, filename) == wav

    assert len(record.published) == 1
    assert record.published[0]["text"] == "Включаю"
    assert record.published[0]["wav"] == wav
    assert record.finished == [(RUN_ID, "done")]
    assert record.run.run_end_sent is True


async def test_empty_phrase_is_a_button_run(component, server, session):
    record = make_run(component, session, server, phrase="", use_wake_word=False)
    record.run.start()
    run_start = await server.wait_run_start()
    assert run_start["wakeWordPhrase"] == ""
    assert run_start["flags"] == {"useWakeWord": False}
    record.run.cancel("client")
    await asyncio.wait_for(record.run.wait_closed(), 2)
    assert "error" not in event_names(record)
    assert record.finished == [(RUN_ID, "client")]


async def test_unauthorized_addon_handshake(component, server, session):
    events: list[tuple[str, dict[str, str]]] = []
    finished: list[tuple[str, str]] = []

    async def unexpected_tts(run_id: str, text: str, wav: bytes) -> str:
        raise AssertionError("TTS must not be published for a rejected handshake")

    addon = component.bridge.AddonClient(
        session, server.host, server.port, "wrong-token", request_timeout=0.5
    )
    request = component.protocol.RunRequest(
        run_id=RUN_ID,
        device=component.protocol.DeviceDescriptor(**DEVICE),
        wake_word_phrase="алиса включи свет",
        use_wake_word=True,
    )
    run = component.bridge.BridgeRun(
        session,
        addon,
        request,
        on_device_event=lambda name, data: events.append((name, data)),
        publish_tts=unexpected_tts,
        on_finished=lambda run_id, reason: finished.append((run_id, reason)),
        keepalive_interval=0.05,
        connect_timeout=1.0,
    )
    run.start()
    await asyncio.wait_for(run.wait_closed(), 2)
    assert [name for name, _ in events] == [
        "run_start",
        "stt_start",
        "error",
        "run_end",
    ]
    assert dict(events)["error"]["code"] == "addon-unauthorized"
    assert finished == [(RUN_ID, "error")]


async def test_barge_in_sends_run_cancel(component, server, session):
    record = make_run(component, session, server)
    record.run.start()
    await server.wait_run_start()
    record.run.cancel("barge_in")
    cancel = await server.wait_message(
        lambda message: message.get("type") == "run.cancel", timeout=1
    )
    assert cancel == {
        "type": "run.cancel",
        "runId": RUN_ID,
        "reason": "barge_in",
    }
    await asyncio.wait_for(record.run.wait_closed(), 2)
    await server.wait_disconnected()
    assert "error" not in event_names(record)
    assert record.finished == [(RUN_ID, "barge_in")]
    assert record.run.run_end_sent is False


async def test_microphone_audio_is_forwarded(component, server, session):
    record = make_run(component, session, server)
    record.run.start()
    await server.wait_run_start()
    record.run.send_audio(b"\x01\x02\x03\x04")
    binary = await server.wait_binary(1)
    assert binary[0] == b"\x01\x02\x03\x04"
    record.run.cancel("device_stop")
    await asyncio.wait_for(record.run.wait_closed(), 2)


async def test_keepalive_intent_progress_while_idle(component, server, session):
    record = make_run(component, session, server, keepalive=0.05)
    record.run.start()
    await server.wait_run_start()
    data = await wait_event(record, "intent_progress")
    assert data == {}
    assert event_names(record)[:2] == ["run_start", "stt_start"]
    record.run.cancel("barge_in")
    await asyncio.wait_for(record.run.wait_closed(), 2)
    assert "error" not in event_names(record)


async def test_invalid_wav_fails_without_tts(component, server, session):
    record = make_run(component, session, server)
    record.run.start()
    await server.wait_run_start()
    await server.send_json(
        {"type": "tts.start", "text": "Ответ", "format": "wav"}
    )
    await server.send_bytes(b"not a wav at all")
    await server.send_json({"type": "tts.end", "reason": "done"})
    await asyncio.wait_for(record.run.wait_closed(), 2)

    assert event_data(record, "error")["code"] == "tts-invalid"
    assert event_names(record)[-2:] == ["error", "run_end"]
    assert record.published == []
    assert record.finished == [(RUN_ID, "error")]


async def test_fatal_addon_error(component, server, session):
    record = make_run(component, session, server)
    record.run.start()
    await server.wait_run_start()
    await server.send_json(
        {
            "type": "error",
            "code": "llm-error",
            "message": "provider failed",
            "fatal": True,
        }
    )
    await asyncio.wait_for(record.run.wait_closed(), 2)
    assert event_data(record, "error") == {
        "code": "llm-error",
        "message": "provider failed",
    }
    assert event_names(record)[-1] == "run_end"
    assert record.finished == [(RUN_ID, "error")]


async def test_run_end_without_tts(component, server, session):
    record = make_run(component, session, server)
    record.run.start()
    await server.wait_run_start()
    await server.send_json({"type": "run.end", "reason": "no_speech"})
    await asyncio.wait_for(record.run.wait_closed(), 2)
    assert event_names(record) == ["run_start", "stt_start", "run_end"]
    assert record.finished == [(RUN_ID, "no_speech")]
    assert record.published == []


async def test_cancelled_tts_closes_with_run_end(component, server, session):
    record = make_run(component, session, server)
    record.run.start()
    await server.wait_run_start()
    await server.send_json(
        {"type": "tts.start", "text": "Ответ", "format": "wav"}
    )
    await server.send_json({"type": "tts.end", "reason": "cancelled"})
    await asyncio.wait_for(record.run.wait_closed(), 2)
    assert event_names(record)[-1] == "run_end"
    assert "error" not in event_names(record)
    assert record.finished == [(RUN_ID, "cancelled")]


async def test_duplicate_tts_start_is_ignored(component, server, session):
    record = make_run(component, session, server)
    record.run.start()
    await server.wait_run_start()
    await server.send_json(
        {"type": "tts.start", "text": "Первый", "format": "wav"}
    )
    await server.send_json(
        {"type": "tts.start", "text": "Второй", "format": "wav"}
    )
    record.run.cancel("barge_in")
    await asyncio.wait_for(record.run.wait_closed(), 2)


def _free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


async def test_addon_unavailable(component, session):
    record = make_run(
        component,
        session,
        None,
        port=_free_port(),
        connect_timeout=0.5,
    )
    record.run.start()
    await asyncio.wait_for(record.run.wait_closed(), 2)
    assert event_names(record) == ["run_start", "stt_start", "error", "run_end"]
    assert event_data(record, "error")["code"] in ("addon-unavailable", "addon-timeout")
    assert record.finished == [(RUN_ID, "error")]
