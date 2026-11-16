"""Provider selector backed by the addon provider registry."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .bridge import AddonError
from .entity import PulsarBrainEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add the provider select."""
    async_add_entities([PulsarBrainProviderSelect(entry.runtime_data, entry)])


class PulsarBrainProviderSelect(PulsarBrainEntity, SelectEntity):
    """Switch the addon LLM provider."""

    _attr_translation_key = "provider"
    _attr_icon = "mdi:brain"

    def __init__(self, runtime, entry: ConfigEntry) -> None:
        super().__init__(runtime, entry, "provider")

    async def async_added_to_hass(self) -> None:
        """Subscribe to runtime updates and fetch the provider list in the background."""
        await super().async_added_to_hass()
        self.hass.async_create_task(
            self.runtime.async_load_providers(),
            name="pulsar_brain load providers",
        )

    @property
    def options(self) -> list[str]:
        """Provider ids offered by the addon."""
        options = [provider["id"] for provider in self.runtime.providers]
        current = self.runtime.last_provider
        if current and current not in options:
            options.append(current)
        return options

    @property
    def current_option(self) -> str | None:
        """Selected provider id."""
        current = self.runtime.last_provider
        return current if current in self.options else None

    async def async_select_option(self, option: str) -> None:
        """Ask the addon to switch provider."""
        try:
            await self.runtime.async_select_provider(option)
        except AddonError as err:
            raise HomeAssistantError(
                f"Не удалось переключить провайдера: {err.code}"
            ) from err
