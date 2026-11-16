"""Restart button for the bridge connection."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .entity import PulsarBrainEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add the restart button."""
    async_add_entities([PulsarBrainRestartButton(entry.runtime_data, entry)])


class PulsarBrainRestartButton(PulsarBrainEntity, ButtonEntity):
    """Reconnect to the speaker and refresh addon state."""

    _attr_translation_key = "restart_bridge"
    _attr_icon = "mdi:restart"

    def __init__(self, runtime, entry: ConfigEntry) -> None:
        super().__init__(runtime, entry, "restart_bridge")

    async def async_press(self) -> None:
        """Restart both connections."""
        await self.runtime.async_restart()
