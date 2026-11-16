"""aioesphomeapi surface the integration relies on (46.25 and 46.30)."""

from __future__ import annotations

import inspect

from aioesphomeapi import APIClient, VoiceAssistantEventType


def test_voice_assistant_event_members_exist(component):
    for enum_name in component.events.EVENT_ENUM_NAMES.values():
        assert hasattr(VoiceAssistantEventType, enum_name), enum_name


def test_wake_word_audio_probe_matches_dependency(component):
    expected = (
        "wake_word_audio"
        in inspect.signature(APIClient.subscribe_voice_assistant).parameters
    )
    assert component.esphome_client._supports_wake_word_audio() is expected


def test_api_client_connection_state_surface():
    # The bridge uses is_connected; `connected` does not exist on APIClient.
    assert hasattr(APIClient, "is_connected")
    assert not hasattr(APIClient, "connected")


def test_api_client_lifecycle_surface():
    for attribute in (
        "connect",
        "disconnect",
        "force_disconnect",
        "device_info",
        "send_voice_assistant_event",
        "subscribe_voice_assistant",
    ):
        assert hasattr(APIClient, attribute), attribute
