"""Wire message builders for docs/contracts.md §3.

Pure module: no Home Assistant imports, usable by tests and by bridge.py.
"""

from __future__ import annotations

from dataclasses import dataclass
import json

from .const import DEFAULT_WAKE_WORD, PROTOCOL_VERSION, TTS_SUFFIX, TTS_URL_PREFIX


@dataclass(frozen=True)
class DeviceDescriptor:
    """Device fields sent in run.start."""

    name: str
    mac: str
    firmware: str


@dataclass(frozen=True)
class RunRequest:
    """One bridge run: the addon protocol fields plus a wake word default."""

    run_id: str
    device: DeviceDescriptor
    wake_word_phrase: str
    use_wake_word: bool
    wake_word: str = DEFAULT_WAKE_WORD


def build_run_start(request: RunRequest) -> dict[str, object]:
    """Build the run.start JSON object (contracts §3.1)."""
    return {
        "type": "run.start",
        "protocol": PROTOCOL_VERSION,
        "runId": request.run_id,
        "device": {
            "name": request.device.name,
            "mac": request.device.mac,
            "firmware": request.device.firmware,
        },
        "wakeWord": request.wake_word,
        "wakeWordPhrase": request.wake_word_phrase,
        "flags": {"useWakeWord": request.use_wake_word},
    }


def build_run_cancel(run_id: str, reason: str) -> dict[str, object]:
    """Build run.cancel."""
    if reason not in ("barge_in", "device_stop", "timeout", "client"):
        raise ValueError(f"invalid cancel reason: {reason}")
    return {"type": "run.cancel", "runId": run_id, "reason": reason}


def build_run_end(run_id: str, reason: str) -> dict[str, object]:
    """Build run.end."""
    return {"type": "run.end", "runId": run_id, "reason": reason}


def encode_json(message: dict[str, object]) -> str:
    """Serialize a protocol message deterministically."""
    return json.dumps(message, ensure_ascii=False, separators=(",", ":"))


def parse_json_object(raw: str) -> dict[str, object] | None:
    """Parse a JSON object, returning None for anything else."""
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    result: dict[str, object] = {}
    for key, value in parsed.items():
        if isinstance(key, str):
            result[key] = value
    return result


def tts_public_path(run_id: str, signature: str) -> str:
    """HTTP path where the TTS view serves one answer WAV."""
    return f"{TTS_URL_PREFIX}/{run_id}/{signature}{TTS_SUFFIX}"


def join_base_url(base_url: str, path: str) -> str:
    """Join an HA base URL with an absolute view path."""
    base = base_url.strip().rstrip("/")
    if not base:
        raise ValueError("base URL is empty")
    if not path.startswith("/"):
        path = f"/{path}"
    return f"{base}{path}"
