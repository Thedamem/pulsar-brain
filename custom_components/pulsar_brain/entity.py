"""Shared entity base for Pulsar Brain diagnostic entities."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.helpers.entity import DeviceInfo, Entity

from .const import DOMAIN, NAME, VERSION

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry

    from . import BridgeRuntime


class PulsarBrainEntity(Entity):
    """Entity grouped under the bridge device and updated by runtime listeners."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self,
        runtime: BridgeRuntime,
        entry: ConfigEntry,
        key: str,
    ) -> None:
        self.runtime = runtime
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_{key}"

    @property
    def device_info(self) -> DeviceInfo:
        """Group all bridge entities under one device."""
        return DeviceInfo(
            identifiers={(DOMAIN, self._entry.entry_id)},
            name=NAME,
            manufacturer="pulsar",
            model="ESPHome voice bridge",
            sw_version=VERSION,
        )

    async def async_added_to_hass(self) -> None:
        """Refresh whenever the runtime state changes."""
        self.async_on_remove(
            self.runtime.async_add_listener(self.async_write_ha_state)
        )
