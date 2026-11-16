"""Master enable switch: release or re-acquire the voice-assistant slot."""

from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_ENABLED
from .entity import PulsarBrainEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add the enable switch."""
    async_add_entities([PulsarBrainEnabledSwitch(entry.runtime_data, entry)])


class PulsarBrainEnabledSwitch(PulsarBrainEntity, SwitchEntity):
    """When off, the bridge unsubscribes from voice assistant and disconnects."""

    _attr_translation_key = "enabled"
    _attr_icon = "mdi:voice"

    def __init__(self, runtime, entry: ConfigEntry) -> None:
        super().__init__(runtime, entry, "enabled")

    @property
    def is_on(self) -> bool:
        """Whether the bridge owns the voice-assistant slot."""
        return self.runtime.enabled

    async def async_turn_on(self, **kwargs: object) -> None:
        """Re-acquire the slot."""
        await self._async_set_enabled(True)

    async def async_turn_off(self, **kwargs: object) -> None:
        """Release the slot so Home Assistant's own Assist can use it."""
        await self._async_set_enabled(False)

    async def _async_set_enabled(self, enabled: bool) -> None:
        await self.runtime.async_set_enabled(enabled)
        options = dict(self._entry.options)
        options[CONF_ENABLED] = enabled
        self.hass.config_entries.async_update_entry(self._entry, options=options)
        self.async_write_ha_state()
