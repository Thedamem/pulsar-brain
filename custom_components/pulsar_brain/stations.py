"""Station binding model shared by the config flow, services and runtime.

The addon owns the UI and pushes the selected station through
``pulsar_brain.set_station`` (docs/contracts.md §8.3). This module resolves that
selection against ESPHome config entries and keeps the ``entry.options["station"]``
shape in one place. It has no Home Assistant imports so it is unit-testable.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Protocol

from .const import (
    ATTR_ENTRY_ID,
    ATTR_HOST,
    ATTR_MODE,
    ATTR_NAME,
    ATTR_PORT,
    CONF_DEVICE_NAME,
    CONF_NOISE_PSK,
    CONF_STATION,
    DEFAULT_DEVICE_PORT,
    STATION_MODE_DISCOVERED,
    STATION_MODE_MANUAL,
)

_HEX_DIGITS = frozenset("0123456789abcdef")

# Keys written by pulsar-brain 0.1.x, when the station lived in entry.data.
_LEGACY_DEVICE_HOST = "device_host"
_LEGACY_DEVICE_PORT = "device_port"


class StationError(Exception):
    """A station selection cannot be applied; ``code`` is a translation key."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class EsphomeEntry(Protocol):
    """The subset of a Home Assistant config entry this module reads."""

    entry_id: str
    title: str
    unique_id: str | None
    data: Mapping[str, object]


def parse_station(value: object) -> dict[str, object] | None:
    """Validate the persisted ``options["station"]`` value.

    A malformed value means "no station": the bridge stays disconnected instead of
    connecting to a half-valid address.
    """
    if not isinstance(value, Mapping):
        return None
    host = _text(value.get(ATTR_HOST))
    mode = value.get(ATTR_MODE)
    port = _port_or_none(value.get(ATTR_PORT))
    if not host or mode not in (STATION_MODE_DISCOVERED, STATION_MODE_MANUAL):
        return None
    if port is None:
        return None

    station: dict[str, object] = {
        ATTR_MODE: mode,
        ATTR_ENTRY_ID: _text(value.get(ATTR_ENTRY_ID)),
        ATTR_NAME: _text(value.get(ATTR_NAME)) or host,
        ATTR_HOST: host,
        ATTR_PORT: port,
    }
    psk = _text(value.get(CONF_NOISE_PSK))
    if psk:
        station[CONF_NOISE_PSK] = psk
    return station


def station_from_esphome_entry(entry: EsphomeEntry) -> dict[str, object]:
    """Resolve a discovered station from its ESPHome config entry.

    The Noise PSK stays inside Home Assistant; only the addon's manual mode sends one
    explicitly, and it never appears in the station list.
    """
    data = entry.data if isinstance(entry.data, Mapping) else {}
    host = _text(data.get(ATTR_HOST))
    if not host:
        raise StationError(
            "esphome_entry_incomplete",
            "В записи ESPHome нет адреса устройства",
        )
    station: dict[str, object] = {
        ATTR_MODE: STATION_MODE_DISCOVERED,
        ATTR_ENTRY_ID: str(entry.entry_id),
        ATTR_NAME: _text(data.get(CONF_DEVICE_NAME)) or _text(entry.title) or host,
        ATTR_HOST: host,
        ATTR_PORT: _port_or_none(data.get(ATTR_PORT)) or DEFAULT_DEVICE_PORT,
    }
    psk = _text(data.get(CONF_NOISE_PSK))
    if psk:
        station[CONF_NOISE_PSK] = psk
    return station


def manual_station(request: Mapping[str, object]) -> dict[str, object]:
    """Build a station from an explicit addon request."""
    name = _text(request.get(ATTR_NAME))
    if not name:
        raise StationError(
            "station_name_required",
            "Для ручной привязки укажите имя станции",
        )
    host = _text(request.get(ATTR_HOST))
    if not host:
        raise StationError(
            "station_host_required",
            "Для ручной привязки укажите хост станции",
        )
    station: dict[str, object] = {
        ATTR_MODE: STATION_MODE_MANUAL,
        ATTR_ENTRY_ID: "",
        ATTR_NAME: name,
        ATTR_HOST: host,
        ATTR_PORT: _port_or_none(request.get(ATTR_PORT)) or DEFAULT_DEVICE_PORT,
    }
    psk = _text(request.get(CONF_NOISE_PSK))
    if psk:
        station[CONF_NOISE_PSK] = psk
    return station


def migrate_legacy_station(
    data: Mapping[str, object],
    options: Mapping[str, object],
) -> dict[str, object] | None:
    """Move a 0.1.x station from entry.data into options.

    Returns new options, or None when no migration is needed. The old keys are kept in
    entry.data so a rollback to 0.1.x keeps working.
    """
    if options.get(CONF_STATION) is not None:
        return None
    host = _text(data.get(_LEGACY_DEVICE_HOST))
    if not host:
        return None
    station: dict[str, object] = {
        ATTR_MODE: STATION_MODE_MANUAL,
        ATTR_ENTRY_ID: "",
        ATTR_NAME: _text(data.get(CONF_DEVICE_NAME)) or host,
        ATTR_HOST: host,
        ATTR_PORT: _port_or_none(data.get(_LEGACY_DEVICE_PORT)) or DEFAULT_DEVICE_PORT,
    }
    psk = _text(data.get(CONF_NOISE_PSK))
    if psk:
        station[CONF_NOISE_PSK] = psk
    return {**options, CONF_STATION: station}


def station_options_updated(
    options: Mapping[str, object],
    request: Mapping[str, object],
    esphome_entries: Mapping[str, EsphomeEntry],
) -> dict[str, object]:
    """Return new config entry options with the requested station bound."""
    entry_id = _text(request.get(ATTR_ENTRY_ID))
    if entry_id:
        entry = esphome_entries.get(entry_id)
        if entry is None:
            raise StationError(
                "esphome_entry_missing",
                "Устройство ESPHome с таким entry_id не найдено",
            )
        station = station_from_esphome_entry(entry)
    else:
        station = manual_station(request)
    return {**options, CONF_STATION: station}


def station_options_cleared(options: Mapping[str, object]) -> dict[str, object]:
    """Return config entry options without a station binding."""
    return {key: value for key, value in options.items() if key != CONF_STATION}


def station_binding_payload(
    station: Mapping[str, object] | None,
) -> dict[str, object] | None:
    """Current binding as pushed to the addon (never includes the PSK)."""
    if station is None:
        return None
    host = _text(station.get(ATTR_HOST))
    if not host:
        return None
    return {
        ATTR_MODE: station.get(ATTR_MODE) or STATION_MODE_MANUAL,
        ATTR_ENTRY_ID: _text(station.get(ATTR_ENTRY_ID)),
        ATTR_NAME: _text(station.get(ATTR_NAME)) or host,
        ATTR_HOST: host,
        ATTR_PORT: _port_or_none(station.get(ATTR_PORT)) or DEFAULT_DEVICE_PORT,
        "has_psk": bool(_text(station.get(CONF_NOISE_PSK))),
    }


def build_station_list(entries: Iterable[EsphomeEntry]) -> list[dict[str, object]]:
    """Station list pushed to the addon (no PSK)."""
    stations: list[dict[str, object]] = []
    for entry in entries:
        data = entry.data if isinstance(entry.data, Mapping) else {}
        entry_id = str(entry.entry_id)
        host = _text(data.get(ATTR_HOST))
        if not entry_id or not host:
            continue
        stations.append(
            {
                ATTR_ENTRY_ID: entry_id,
                ATTR_NAME: _text(data.get(CONF_DEVICE_NAME))
                or _text(entry.title)
                or host,
                ATTR_HOST: host,
                ATTR_PORT: _port_or_none(data.get(ATTR_PORT)) or DEFAULT_DEVICE_PORT,
                "mac": mac_from_unique_id(entry.unique_id),
            }
        )
    return stations


def mac_from_unique_id(unique_id: object) -> str:
    """Normalize a MAC-like ESPHome unique id, or return an empty string."""
    value = _text(unique_id)
    if len(value) == 17 and value.count(":") == 5:
        parts = value.split(":")
        if all(len(part) == 2 and _is_hex(part) for part in parts):
            return value.lower()
    candidate = value
    if len(candidate) == 17 and candidate.count("-") == 5:
        candidate = candidate.replace("-", "")
    elif len(candidate) == 14 and candidate.count(".") == 2:
        candidate = candidate.replace(".", "")
    if len(candidate) == 12 and _is_hex(candidate):
        return ":".join(candidate.lower()[index : index + 2] for index in range(0, 12, 2))
    return ""


def describe_station(station: Mapping[str, object]) -> str:
    """Log-safe station description: never includes the Noise PSK."""
    return (
        f"{_text(station.get(ATTR_NAME))} "
        f"({_text(station.get(ATTR_HOST))}:{station.get(ATTR_PORT)}, "
        f"{station.get(ATTR_MODE)})"
    )


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _is_hex(value: str) -> bool:
    return bool(value) and all(character in _HEX_DIGITS for character in value.lower())


def _port_or_none(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return port if 0 < port < 65536 else None


# Re-exported for callers that filter config entries by domain.
__all__ = [
    "EsphomeEntry",
    "StationError",
    "build_station_list",
    "describe_station",
    "mac_from_unique_id",
    "manual_station",
    "migrate_legacy_station",
    "parse_station",
    "station_binding_payload",
    "station_from_esphome_entry",
    "station_options_cleared",
    "station_options_updated",
]
