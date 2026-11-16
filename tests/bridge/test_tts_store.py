"""Signed TTS storage: path, HMAC, TTL, cleanup."""

from __future__ import annotations

import re

RUN_ID = "0123456789abcdef0123456789abcdef"


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def test_publish_returns_signed_path(component):
    clock = Clock()
    store = component.tts_store.TtsStore("secret-token", ttl=120, clock=clock)
    path = store.publish(RUN_ID, b"RIFF....")
    assert path == f"/api/pulsar_brain/tts/{RUN_ID}/{store.signature(RUN_ID)}.wav"
    assert re.fullmatch(
        rf"/api/pulsar_brain/tts/{RUN_ID}/[0-9a-f]{{64}}\.wav", path
    )
    assert "secret-token" not in path
    assert store.active_count == 1


def test_resolve_file_roundtrip(component):
    store = component.tts_store.TtsStore("token", ttl=120, clock=Clock())
    wav = b"RIFF\x00\x00\x00\x00WAVE"
    path = store.publish(RUN_ID, wav)
    filename = path.rsplit("/", 1)[1]
    assert store.resolve_file(RUN_ID, filename) == wav
    assert store.resolve(RUN_ID, store.signature(RUN_ID)) == wav


def test_resolve_rejects_wrong_signature(component):
    store = component.tts_store.TtsStore("token", ttl=120, clock=Clock())
    store.publish(RUN_ID, b"wav")
    assert store.resolve(RUN_ID, "0" * 64) is None
    assert store.resolve(RUN_ID, "short") is None
    assert store.resolve_file(RUN_ID, "bad.txt") is None
    assert store.resolve("other-run", store.signature(RUN_ID)) is None


def test_ttl_expiry_and_purge(component):
    clock = Clock()
    store = component.tts_store.TtsStore("token", ttl=10, clock=clock)
    path = store.publish(RUN_ID, b"wav")
    filename = path.rsplit("/", 1)[1]
    clock.now += 9.9
    assert store.resolve_file(RUN_ID, filename) == b"wav"
    clock.now += 0.2
    assert store.resolve_file(RUN_ID, filename) is None
    assert store.active_count == 0
    store.publish(RUN_ID, b"wav")
    clock.now += 11
    store.purge()
    assert store.active_count == 0


def test_publish_rejects_invalid_input(component):
    store = component.tts_store.TtsStore("token", ttl=10)
    for run_id in ("../escape", "", "a" * 65, "with space"):
        try:
            store.publish(run_id, b"wav")
        except ValueError:
            continue
        raise AssertionError(f"accepted run id {run_id!r}")
    try:
        store.publish(RUN_ID, b"")
    except ValueError:
        pass
    else:
        raise AssertionError("accepted empty WAV")


def test_disable_blocks_publish_and_serve(component):
    store = component.tts_store.TtsStore("token", ttl=10)
    store.publish(RUN_ID, b"wav")
    store.set_enabled(False)
    assert store.enabled is False
    assert store.active_count == 0
    assert store.resolve(RUN_ID, store.signature(RUN_ID)) is None
    try:
        store.publish(RUN_ID, b"wav")
    except ValueError:
        pass
    else:
        raise AssertionError("disabled store accepted a payload")


def test_requires_token(component):
    try:
        component.tts_store.TtsStore("")
    except ValueError:
        return
    raise AssertionError("empty token was accepted")


def test_token_changes_signature(component):
    first = component.tts_store.TtsStore("token-a", ttl=10)
    second = component.tts_store.TtsStore("token-b", ttl=10)
    assert first.signature(RUN_ID) != second.signature(RUN_ID)


def test_republish_replaces_entry(component):
    store = component.tts_store.TtsStore("token", ttl=10)
    path = store.publish(RUN_ID, b"first")
    store.publish(RUN_ID, b"second")
    assert store.active_count == 1
    assert store.resolve_file(RUN_ID, path.rsplit("/", 1)[1]) == b"second"
