"""Message builders and URL helpers (contracts §3)."""

from __future__ import annotations

import json


def _request(component, *, phrase: str = "алиса включи свет", use_wake_word: bool = True):
    return component.protocol.RunRequest(
        run_id="run-123",
        device=component.protocol.DeviceDescriptor(
            name="yandex-lite-2",
            mac="02:00:00:00:00:01",
            firmware="0.5.3",
        ),
        wake_word_phrase=phrase,
        use_wake_word=use_wake_word,
    )


def test_run_start_shape(component):
    message = component.protocol.build_run_start(_request(component))
    assert message == {
        "type": "run.start",
        "protocol": 1,
        "runId": "run-123",
        "device": {
            "name": "yandex-lite-2",
            "mac": "02:00:00:00:00:01",
            "firmware": "0.5.3",
        },
        "wakeWord": "alisa",
        "wakeWordPhrase": "алиса включи свет",
        "flags": {"useWakeWord": True},
    }
    assert json.loads(component.protocol.encode_json(message)) == message


def test_run_start_button_has_no_wake_word(component):
    message = component.protocol.build_run_start(
        _request(component, phrase="", use_wake_word=False)
    )
    assert message["wakeWordPhrase"] == ""
    assert message["flags"] == {"useWakeWord": False}


def test_run_end_message(component):
    assert component.protocol.build_run_end("r", "done") == {
        "type": "run.end",
        "runId": "r",
        "reason": "done",
    }


def test_cancel_messages(component):
    for reason in ("barge_in", "device_stop", "timeout", "client"):
        assert component.protocol.build_run_cancel("r", reason) == {
            "type": "run.cancel",
            "runId": "r",
            "reason": reason,
        }


def test_cancel_rejects_unknown_reason(component):
    try:
        component.protocol.build_run_cancel("r", "what")
    except ValueError:
        return
    raise AssertionError("invalid cancel reason was accepted")


def test_parse_json_object(component):
    assert component.protocol.parse_json_object('{"type":"run.accepted"}') == {
        "type": "run.accepted"
    }
    assert component.protocol.parse_json_object("[1,2]") is None
    assert component.protocol.parse_json_object("not json") is None
    assert component.protocol.parse_json_object('"text"') is None


def test_tts_path_and_join(component):
    path = component.protocol.tts_public_path("abc", "def")
    assert path == "/api/pulsar_brain/tts/abc/def.wav"
    assert (
        component.protocol.join_base_url("http://ha.local:8123/", path)
        == "http://ha.local:8123/api/pulsar_brain/tts/abc/def.wav"
    )
    assert (
        component.protocol.join_base_url("https://ha.example", "api/x")
        == "https://ha.example/api/x"
    )
    try:
        component.protocol.join_base_url("", path)
    except ValueError:
        return
    raise AssertionError("empty base URL was accepted")
