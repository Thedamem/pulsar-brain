"""Constants for the Pulsar Brain bridge integration.

This module must stay importable without Home Assistant: the pure bridge modules and
their tests rely on it.
"""

from __future__ import annotations

DOMAIN = "pulsar_brain"
NAME = "Pulsar Brain"
VERSION = "0.1.0"

# Wire protocol version of docs/contracts.md §3.
PROTOCOL_VERSION = 1

# Config entry data.
CONF_ADDON_HOST = "addon_host"
CONF_ADDON_PORT = "addon_port"
CONF_BRIDGE_TOKEN = "bridge_token"
CONF_ESP_ENTRY = "esphome_entry"
CONF_DEVICE_HOST = "device_host"
CONF_DEVICE_PORT = "device_port"
CONF_DEVICE_NAME = "device_name"
CONF_NOISE_PSK = "noise_psk"

# Config entry options.
CONF_TTS_BASE_URL = "tts_base_url"
CONF_ENABLED = "enabled"

DEFAULT_ADDON_PORT = 8097
DEFAULT_DEVICE_PORT = 6053
DEFAULT_ENABLED = True
MANUAL_DEVICE = "__manual__"

# pulsar's native wake word; the addon only uses it for logging and prompt context.
DEFAULT_WAKE_WORD = "alisa"
# VoiceAssistantCommandFlag.USE_WAKE_WORD from aioesphomeapi.
VOICE_ASSISTANT_FLAG_USE_WAKE_WORD = 1 << 1

# Addon HTTP API (docs/contracts.md §4).
ADDON_HEALTH_PATH = "/health"
ADDON_STATUS_PATH = "/api/status"
ADDON_CONFIG_PATH = "/api/config"
ADDON_PROVIDERS_PATH = "/api/providers"
ADDON_TEST_TEXT_PATH = "/api/test/text"
BRIDGE_WS_PATH = "/api/bridge/ws"

# HTTP view that serves the synthesized answer WAV to the speaker.
TTS_URL_PREFIX = "/api/pulsar_brain/tts"
TTS_VIEW_NAME = "api:pulsar_brain:tts"
TTS_SUFFIX = ".wav"

# Timings.
ADDON_REQUEST_TIMEOUT = 10.0
BRIDGE_CONNECT_TIMEOUT = 10.0
# Long LLM/TTS turns are normal; pulsar's own processing watchdog is 120 s.
BRIDGE_READ_TIMEOUT = 120.0
KEEPALIVE_INTERVAL = 10.0
RESUBSCRIBE_INTERVAL = 30.0
RECONNECT_MIN_DELAY = 5.0
RECONNECT_MAX_DELAY = 60.0
STATUS_REFRESH_INTERVAL = 60.0
TTS_TTL_SECONDS = 120.0
# Safety cap for a lost AnnounceFinished while avoiding subscription churn during play.
SPEAKING_GUARD_SECONDS = 300.0

# Bounded buffers.
MAX_TTS_BYTES = 32 * 1024 * 1024
MAX_AUDIO_QUEUE = 512

PLATFORMS = ["binary_sensor", "sensor", "select", "switch", "button"]

SERVICE_ASK = "ask"
SERVICE_ANNOUNCE = "announce"

ATTR_RESPONSE = "response"
ATTR_SPEECH = "speech"
ATTR_TOOL_TRACES = "tool_traces"
