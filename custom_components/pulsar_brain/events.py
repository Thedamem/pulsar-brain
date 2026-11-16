"""Voice assistant event mapping shared by the bridge and the ESPHome client.

Pure module: no Home Assistant or aioesphomeapi imports, so it can be unit tested and
used by bridge.py without an HA environment.
"""

from __future__ import annotations

from collections.abc import Mapping
from enum import IntEnum


class VoiceEvent(IntEnum):
    """ESPHome VoiceAssistantEventType numeric values (pulsar v0.5.3)."""

    ERROR = 0
    RUN_START = 1
    RUN_END = 2
    STT_START = 3
    STT_END = 4
    INTENT_START = 5
    INTENT_END = 6
    TTS_START = 7
    TTS_END = 8
    WAKE_WORD_START = 9
    WAKE_WORD_END = 10
    STT_VAD_START = 11
    STT_VAD_END = 12
    TTS_STREAM_START = 98
    TTS_STREAM_END = 99
    INTENT_PROGRESS = 100


# aioesphomeapi exposes the enum class in both supported versions (46.25 on HA
# 2026.11, 46.30 in the dev venv); resolve members by name to stay version independent.
EVENT_ENUM_NAMES: dict[str, str] = {
    "error": "VOICE_ASSISTANT_ERROR",
    "run_start": "VOICE_ASSISTANT_RUN_START",
    "run_end": "VOICE_ASSISTANT_RUN_END",
    "stt_start": "VOICE_ASSISTANT_STT_START",
    "stt_end": "VOICE_ASSISTANT_STT_END",
    "intent_start": "VOICE_ASSISTANT_INTENT_START",
    "intent_end": "VOICE_ASSISTANT_INTENT_END",
    "intent_progress": "VOICE_ASSISTANT_INTENT_PROGRESS",
    "tts_start": "VOICE_ASSISTANT_TTS_START",
    "tts_end": "VOICE_ASSISTANT_TTS_END",
    "tts_stream_start": "VOICE_ASSISTANT_TTS_STREAM_START",
    "tts_stream_end": "VOICE_ASSISTANT_TTS_STREAM_END",
    "stt_vad_start": "VOICE_ASSISTANT_STT_VAD_START",
    "stt_vad_end": "VOICE_ASSISTANT_STT_VAD_END",
    "wake_word_start": "VOICE_ASSISTANT_WAKE_WORD_START",
    "wake_word_end": "VOICE_ASSISTANT_WAKE_WORD_END",
}

ADDON_EVENTS: dict[str, VoiceEvent] = {
    "run_start": VoiceEvent.RUN_START,
    "stt_start": VoiceEvent.STT_START,
    "stt_vad_start": VoiceEvent.STT_VAD_START,
    "stt_vad_end": VoiceEvent.STT_VAD_END,
    "stt_end": VoiceEvent.STT_END,
    "intent_start": VoiceEvent.INTENT_START,
    "intent_end": VoiceEvent.INTENT_END,
    "intent_progress": VoiceEvent.INTENT_PROGRESS,
    "tts_start": VoiceEvent.TTS_START,
    "tts_stream_start": VoiceEvent.TTS_STREAM_START,
    "tts_stream_end": VoiceEvent.TTS_STREAM_END,
    "tts_end": VoiceEvent.TTS_END,
    "run_end": VoiceEvent.RUN_END,
    "error": VoiceEvent.ERROR,
}

# Events the bridge emits on its own (RUN_START/STT_START when the run opens, the TTS
# pair and RUN_END once the WAV is published). Addon copies of these are ignored.
BRIDGE_OWNED_EVENTS = frozenset(
    {"run_start", "stt_start", "tts_start", "tts_end", "run_end"}
)


def event_from_addon(name: str) -> VoiceEvent | None:
    """Return the device event for an addon event name, or None when unknown."""
    return ADDON_EVENTS.get(name)


def normalize_event_data(raw: object) -> dict[str, str]:
    """Coerce addon event data to the string map ESPHome requires.

    The addon contract is Record<string, string>; JSON numbers/booleans are accepted
    defensively and converted, anything else is dropped.
    """
    if not isinstance(raw, Mapping):
        return {}
    result: dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            continue
        if isinstance(value, str):
            result[key] = value
        elif isinstance(value, bool):
            result[key] = "1" if value else "0"
        elif isinstance(value, (int, float)):
            result[key] = str(value)
    return result
