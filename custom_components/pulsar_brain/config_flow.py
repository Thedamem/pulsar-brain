"""Config and options flows for the Pulsar Brain bridge."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlowWithReload,
)
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .bridge import AddonError, async_validate_addon
from .const import (
    CONF_ADDON_HOST,
    CONF_ADDON_PORT,
    CONF_BRIDGE_TOKEN,
    CONF_DEVICE_HOST,
    CONF_DEVICE_NAME,
    CONF_DEVICE_PORT,
    CONF_ENABLED,
    CONF_ESP_ENTRY,
    CONF_NOISE_PSK,
    CONF_TTS_BASE_URL,
    DEFAULT_ADDON_PORT,
    DEFAULT_DEVICE_PORT,
    DEFAULT_ENABLED,
    DOMAIN,
    MANUAL_DEVICE,
)


def _describe_esphome_entry(entry: ConfigEntry) -> str:
    host = entry.data.get(CONF_HOST, "")
    port = entry.data.get(CONF_PORT, DEFAULT_DEVICE_PORT)
    return f"{entry.title} ({host}:{port})"


def _is_http_base_url(value: str) -> bool:
    parsed = urlsplit(value)
    return (
        parsed.scheme in ("http", "https")
        and bool(parsed.netloc)
        and parsed.path in ("", "/")
        and not parsed.query
        and not parsed.fragment
    )


class PulsarBrainConfigFlow(ConfigFlow, domain=DOMAIN):
    """Two-step flow: addon endpoint, then the ESPHome speaker."""

    VERSION = 1

    def __init__(self) -> None:
        self._addon_data: dict[str, Any] = {}

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for the addon endpoint and verify it before the device step."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        errors: dict[str, str] = {}
        if user_input is not None:
            host = str(user_input[CONF_ADDON_HOST]).strip()
            port = int(user_input[CONF_ADDON_PORT])
            token = str(user_input[CONF_BRIDGE_TOKEN]).strip()
            try:
                await async_validate_addon(
                    async_get_clientsession(self.hass), host, port, token
                )
            except AddonError as err:
                errors["base"] = (
                    "invalid_auth" if err.status in (401, 403) else "cannot_connect"
                )
            except Exception:  # noqa: BLE001 - malformed responses are connection errors
                errors["base"] = "cannot_connect"
            else:
                self._addon_data = {
                    CONF_ADDON_HOST: host,
                    CONF_ADDON_PORT: port,
                    CONF_BRIDGE_TOKEN: token,
                }
                return await self.async_step_device()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_ADDON_HOST): str,
                    vol.Required(CONF_ADDON_PORT, default=DEFAULT_ADDON_PORT): vol.All(
                        vol.Coerce(int), vol.Range(min=1, max=65535)
                    ),
                    vol.Required(CONF_BRIDGE_TOKEN): selector.TextSelector(
                        selector.TextSelectorConfig(
                            type=selector.TextSelectorType.PASSWORD
                        )
                    ),
                }
            ),
            errors=errors,
        )

    async def async_step_device(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Pick an existing ESPHome entry or enter the device manually."""
        errors: dict[str, str] = {}
        choices = self._device_choices()

        if user_input is not None:
            selection = str(user_input[CONF_ESP_ENTRY])
            entry_id = choices.get(selection)
            if entry_id is None:
                errors["base"] = "unknown"
            elif entry_id == MANUAL_DEVICE:
                device = self._manual_device(user_input)
                if device is None:
                    errors[CONF_DEVICE_HOST] = "manual_host_required"
                else:
                    return await self._async_create_entry(device, entry_id)
            else:
                entry = self.hass.config_entries.async_get_entry(entry_id)
                if entry is None:
                    errors["base"] = "esphome_entry_missing"
                else:
                    device = self._device_from_entry(entry)
                    if not device[CONF_DEVICE_HOST]:
                        errors["base"] = "esphome_entry_missing"
                    else:
                        return await self._async_create_entry(device, entry_id)

        submitted = user_input or {}
        default_choice = str(
            submitted.get(CONF_ESP_ENTRY, next(iter(choices), MANUAL_DEVICE))
        )
        return self.async_show_form(
            step_id="device",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_ESP_ENTRY, default=default_choice): vol.In(
                        list(choices)
                    ),
                    vol.Optional(
                        CONF_DEVICE_HOST, default=str(submitted.get(CONF_DEVICE_HOST, ""))
                    ): str,
                    vol.Optional(
                        CONF_DEVICE_PORT,
                        default=int(submitted.get(CONF_DEVICE_PORT, DEFAULT_DEVICE_PORT)),
                    ): vol.All(vol.Coerce(int), vol.Range(min=1, max=65535)),
                    vol.Optional(
                        CONF_NOISE_PSK, default=str(submitted.get(CONF_NOISE_PSK, ""))
                    ): selector.TextSelector(
                        selector.TextSelectorConfig(
                            type=selector.TextSelectorType.PASSWORD
                        )
                    ),
                    vol.Optional(
                        CONF_DEVICE_NAME, default=str(submitted.get(CONF_DEVICE_NAME, ""))
                    ): str,
                }
            ),
            description_placeholders={
                "devices": ", ".join(
                    label for label, value in choices.items() if value != MANUAL_DEVICE
                )
                or "—",
            },
            errors=errors,
        )

    @callback
    def _device_choices(self) -> dict[str, str]:
        choices: dict[str, str] = {}
        for entry in self.hass.config_entries.async_entries("esphome"):
            label = _describe_esphome_entry(entry)
            if label in choices:
                label = f"{label} [{entry.entry_id}]"
            choices[label] = entry.entry_id
        choices["Ввести вручную"] = MANUAL_DEVICE
        return choices

    @staticmethod
    def _device_from_entry(entry: ConfigEntry) -> dict[str, Any]:
        return {
            CONF_DEVICE_HOST: str(entry.data.get(CONF_HOST, "")).strip(),
            CONF_DEVICE_PORT: int(
                entry.data.get(CONF_PORT, DEFAULT_DEVICE_PORT) or DEFAULT_DEVICE_PORT
            ),
            CONF_NOISE_PSK: str(entry.data.get(CONF_NOISE_PSK) or "").strip(),
            CONF_DEVICE_NAME: str(
                entry.data.get(CONF_DEVICE_NAME) or entry.title or ""
            ).strip(),
        }

    @staticmethod
    def _manual_device(user_input: Mapping[str, Any]) -> dict[str, Any] | None:
        host = str(user_input.get(CONF_DEVICE_HOST, "")).strip()
        if not host:
            return None
        return {
            CONF_DEVICE_HOST: host,
            CONF_DEVICE_PORT: int(user_input.get(CONF_DEVICE_PORT, DEFAULT_DEVICE_PORT)),
            CONF_NOISE_PSK: str(user_input.get(CONF_NOISE_PSK, "")).strip(),
            CONF_DEVICE_NAME: str(user_input.get(CONF_DEVICE_NAME, "")).strip(),
        }

    async def _async_create_entry(
        self,
        device: Mapping[str, Any],
        entry_id: str,
    ) -> ConfigFlowResult:
        host = str(device[CONF_DEVICE_HOST])
        await self.async_set_unique_id(
            f"{self._addon_data[CONF_ADDON_HOST]}:{host}"
        )
        self._abort_if_unique_id_configured()
        name = str(device.get(CONF_DEVICE_NAME) or host)
        return self.async_create_entry(
            title=name,
            data={
                **self._addon_data,
                **device,
                CONF_ESP_ENTRY: entry_id,
            },
            options={
                CONF_TTS_BASE_URL: "",
                CONF_ENABLED: DEFAULT_ENABLED,
            },
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlowWithReload:
        """Return the options flow."""
        return PulsarBrainOptionsFlow()


class PulsarBrainOptionsFlow(OptionsFlowWithReload):
    """Options: TTS base URL override and the master enable switch."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        options = dict(self.config_entry.options)
        if user_input is not None:
            base_url = str(user_input.get(CONF_TTS_BASE_URL, "")).strip().rstrip("/")
            if base_url and not _is_http_base_url(base_url):
                errors[CONF_TTS_BASE_URL] = "invalid_tts_base_url"
            else:
                return self.async_create_entry(
                    data={
                        **options,
                        CONF_TTS_BASE_URL: base_url,
                        CONF_ENABLED: bool(user_input.get(CONF_ENABLED, True)),
                    }
                )

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Optional(
                        CONF_TTS_BASE_URL,
                        default=str(options.get(CONF_TTS_BASE_URL, "")),
                    ): str,
                    vol.Optional(
                        CONF_ENABLED,
                        default=bool(options.get(CONF_ENABLED, DEFAULT_ENABLED)),
                    ): bool,
                }
            ),
            errors=errors,
        )
