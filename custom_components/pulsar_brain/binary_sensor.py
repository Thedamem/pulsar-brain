"""Connectivity binary sensor for the Pulsar Brain bridge."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import PulsarBrainEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add the connectivity sensor."""
    async_add_entities([PulsarBrainConnectedSensor(entry.runtime_data, entry)])


class PulsarBrainConnectedSensor(PulsarBrainEntity, BinarySensorEntity):
    """True when the speaker and the addon are both reachable."""

    _attr_translation_key = "connected"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY

    def __init__(self, runtime, entry: ConfigEntry) -> None:
        super().__init__(runtime, entry, "connected")

    @property
    def is_on(self) -> bool:
        """Overall bridge connectivity."""
        return self.runtime.connected

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Diagnostic connection details (no secrets)."""
        return {
            "device_connected": self.runtime.device_connected,
            "addon_connected": self.runtime.addon_connected,
            "device_name": self.runtime.device_name,
            "firmware": self.runtime.firmware,
            "last_error": self.runtime.last_error,
            "active_run": self.runtime.last_run_id,
        }
