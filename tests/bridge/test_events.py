"""Addon event mapping and data normalization."""

from __future__ import annotations


EXPECTED_EVENTS = {
    "run_start": 1,
    "stt_start": 3,
    "stt_vad_start": 11,
    "stt_vad_end": 12,
    "stt_end": 4,
    "intent_start": 5,
    "intent_end": 6,
    "intent_progress": 100,
    "tts_start": 7,
    "tts_stream_start": 98,
    "tts_stream_end": 99,
    "tts_end": 8,
    "run_end": 2,
    "error": 0,
}


def test_addon_event_codes(component):
    for name, code in EXPECTED_EVENTS.items():
        event = component.events.event_from_addon(name)
        assert event is not None, name
        assert int(event) == code, name


def test_unknown_event(component):
    assert component.events.event_from_addon("made_up") is None


def test_bridge_owned_events(component):
    assert component.events.BRIDGE_OWNED_EVENTS == {
        "run_start",
        "stt_start",
        "tts_start",
        "tts_end",
        "run_end",
    }


def test_every_addon_event_has_enum_name(component):
    for name in EXPECTED_EVENTS:
        assert name in component.events.EVENT_ENUM_NAMES
        assert component.events.EVENT_ENUM_NAMES[name].startswith("VOICE_ASSISTANT_")


def test_normalize_event_data(component):
    normalized = component.events.normalize_event_data(
        {
            "text": "включи свет",
            "continue_conversation": "1",
            "flag": True,
            "off": False,
            "count": 2,
            "ratio": 1.5,
            "nested": {"x": "y"},
            "none": None,
            3: "bad-key",
        }
    )
    assert normalized == {
        "text": "включи свет",
        "continue_conversation": "1",
        "flag": "1",
        "off": "0",
        "count": "2",
        "ratio": "1.5",
    }


def test_normalize_non_mapping(component):
    assert component.events.normalize_event_data(None) == {}
    assert component.events.normalize_event_data(["x"]) == {}
