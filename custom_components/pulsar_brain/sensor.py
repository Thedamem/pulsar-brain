"""Conversation diagnostic sensors for the Pulsar Brain bridge."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import PulsarBrainEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add transcript, response and provider sensors."""
    runtime = entry.runtime_data
    async_add_entities(
        [
            PulsarBrainLastTranscriptSensor(runtime, entry),
            PulsarBrainLastResponseSensor(runtime, entry),
            PulsarBrainProviderSensor(runtime, entry),
        ]
    )


class PulsarBrainLastTranscriptSensor(PulsarBrainEntity, SensorEntity):
    """Last recognized user phrase."""

    _attr_translation_key = "last_transcript"
    _attr_icon = "mdi:account-voice"

    def __init__(self, runtime, entry: ConfigEntry) -> None:
        super().__init__(runtime, entry, "last_transcript")

    @property
    def native_value(self) -> str | None:
        """Last STT result."""
        return self.runtime.last_transcript or None


class PulsarBrainLastResponseSensor(PulsarBrainEntity, SensorEntity):
    """Last spoken assistant response."""

    _attr_translation_key = "last_response"
    _attr_icon = "mdi:message-text"

    def __init__(self, runtime, entry: ConfigEntry) -> None:
        super().__init__(runtime, entry, "last_response")

    @property
    def native_value(self) -> str | None:
        """Last reply speech text."""
        return self.runtime.last_response or None


class PulsarBrainProviderSensor(PulsarBrainEntity, SensorEntity):
    """Provider currently selected in the addon."""

    _attr_translation_key = "last_provider"
    _attr_icon = "mdi:brain"

    def __init__(self, runtime, entry: ConfigEntry) -> None:
        super().__init__(runtime, entry, "last_provider")

    @property
    def native_value(self) -> str | None:
        """Selected provider id."""
        return self.runtime.last_provider
