"""Supervisor discovery payloads for the Pulsar Brain addon (docs/contracts.md §8.1).

The addon announces itself through Supervisor; this module validates that payload and
builds the config entry data. It has no Home Assistant imports so the rules stay
unit-testable outside HA.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .const import (
    CONF_ADDON_HOST,
    CONF_ADDON_PORT,
    CONF_ADDON_SLUG,
    CONF_BRIDGE_TOKEN,
)

_DISCOVERY_HOST = "host"
_DISCOVERY_PORT = "port"


class DiscoveryError(Exception):
    """The Supervisor discovery payload is incomplete or malformed."""


@dataclass(frozen=True)
class HassioDiscovery:
    """Validated Supervisor discovery of the pulsar_brain addon."""

    host: str
    port: int
    bridge_token: str
    unique_id: str
    slug: str


def parse_hassio_discovery(
    config: Mapping[str, Any] | None,
    *,
    unique_id: str | None,
    slug: str | None,
) -> HassioDiscovery:
    """Validate a Supervisor discovery notification.

    The addon sends plain ``host``/``port`` keys, while the config entry stores them
    under the integration's own names.
    """
    if not isinstance(config, Mapping):
        raise DiscoveryError("discovery config is not an object")

    host = config.get(_DISCOVERY_HOST)
    if not isinstance(host, str) or not _is_usable_host(host):
        raise DiscoveryError("discovery config has no usable host")

    port = _parse_port(config.get(_DISCOVERY_PORT))

    token = config.get(CONF_BRIDGE_TOKEN)
    if not isinstance(token, str) or not token.strip():
        raise DiscoveryError("discovery config has no bridge token")

    if not isinstance(unique_id, str) or not unique_id:
        raise DiscoveryError("discovery notification has no uuid")

    return HassioDiscovery(
        host=host.strip(),
        port=port,
        bridge_token=token.strip(),
        unique_id=unique_id,
        slug=slug if isinstance(slug, str) else "",
    )


def discovery_entry_data(discovery: HassioDiscovery) -> dict[str, object]:
    """Config entry data for a discovered addon."""
    return {
        CONF_ADDON_HOST: discovery.host,
        CONF_ADDON_PORT: discovery.port,
        CONF_BRIDGE_TOKEN: discovery.bridge_token,
        CONF_ADDON_SLUG: discovery.slug,
    }


def _is_usable_host(host: str) -> bool:
    value = host.strip()
    if not value or "://" in value or "/" in value:
        return False
    return not any(character.isspace() for character in value)


def _parse_port(value: object) -> int:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError) as err:
        raise DiscoveryError("discovery config has no valid port") from err
    if not 0 < port < 65536:
        raise DiscoveryError("discovery port is out of range")
    return port
