"""Config and options flows for the Pulsar Brain bridge."""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlsplit

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlowWithReload,
)
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .bridge import AddonError, async_check_health, async_validate_addon
from .const import (
    CONF_ADDON_HOST,
    CONF_ADDON_PORT,
    CONF_BRIDGE_TOKEN,
    CONF_ENABLED,
    CONF_TTS_BASE_URL,
    DEFAULT_ADDON_PORT,
    DEFAULT_ENABLED,
    DISCOVERY_HEALTH_TIMEOUT,
    DOMAIN,
    NAME,
)
from .discovery import DiscoveryError, discovery_entry_data, parse_hassio_discovery

_LOGGER = logging.getLogger(__name__)


def _is_http_base_url(value: str) -> bool:
    parsed = urlsplit(value)
    return (
        parsed.scheme in ("http", "https")
        and bool(parsed.netloc)
        and parsed.path in ("", "/")
        and not parsed.query
        and not parsed.fragment
    )


def _port(value: object, default: int) -> int:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return default
    return port if 0 < port < 65536 else default


class PulsarBrainConfigFlow(ConfigFlow, domain=DOMAIN):
    """Supervisor discovery and manual addon setup.

    The station is never chosen here: the addon owns that UI and calls
    ``pulsar_brain.set_station`` afterwards (docs/contracts.md §8).
    """

    VERSION = 1

    async def async_step_hassio(
        self, discovery_info: HassioServiceInfo
    ) -> ConfigFlowResult:
        """Create the entry from the addon's Supervisor announcement."""
        try:
            discovery = parse_hassio_discovery(
                discovery_info.config,
                unique_id=discovery_info.uuid,
                slug=discovery_info.slug,
            )
        except DiscoveryError as err:
            _LOGGER.warning("Ignoring Pulsar Brain discovery: %s", err)
            return self.async_abort(reason="invalid_discovery")

        await self.async_set_unique_id(discovery.unique_id)
        self._abort_if_unique_id_configured()

        try:
            await async_check_health(
                async_get_clientsession(self.hass),
                discovery.host,
                discovery.port,
                timeout=DISCOVERY_HEALTH_TIMEOUT,
            )
        except AddonError as err:
            _LOGGER.warning(
                "Pulsar Brain addon %s:%s failed its health check: %s",
                discovery.host,
                discovery.port,
                err.code,
            )
            return self.async_abort(reason="cannot_connect")
        except Exception:  # noqa: BLE001 - malformed answers are connection failures
            _LOGGER.exception("Pulsar Brain addon discovery failed")
            return self.async_abort(reason="cannot_connect")

        return self.async_create_entry(
            title=NAME,
            data=discovery_entry_data(discovery),
            options=_default_options(),
        )

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manual setup: addon address and bridge token only."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        errors: dict[str, str] = {}
        if user_input is not None:
            host = str(user_input.get(CONF_ADDON_HOST, "")).strip()
            port = int(user_input.get(CONF_ADDON_PORT, DEFAULT_ADDON_PORT))
            token = str(user_input.get(CONF_BRIDGE_TOKEN, "")).strip()
            if not host:
                errors[CONF_ADDON_HOST] = "addon_host_required"
            elif not token:
                errors[CONF_BRIDGE_TOKEN] = "bridge_token_required"
            else:
                try:
                    await async_validate_addon(
                        async_get_clientsession(self.hass), host, port, token
                    )
                except AddonError as err:
                    errors["base"] = (
                        "invalid_auth"
                        if err.status in (401, 403)
                        else "cannot_connect"
                    )
                except Exception:  # noqa: BLE001 - malformed responses are errors
                    errors["base"] = "cannot_connect"
                else:
                    return self.async_create_entry(
                        title=NAME,
                        data={
                            CONF_ADDON_HOST: host,
                            CONF_ADDON_PORT: port,
                            CONF_BRIDGE_TOKEN: token,
                        },
                        options=_default_options(),
                    )

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

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlowWithReload:
        """Return the options flow."""
        return PulsarBrainOptionsFlow()


class PulsarBrainOptionsFlow(OptionsFlowWithReload):
    """Addon connection override, TTS base URL and the master enable switch."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        entry = self.config_entry
        current = {**entry.data, **entry.options}

        if user_input is not None:
            host = str(user_input.get(CONF_ADDON_HOST, "")).strip()
            port = _port(user_input.get(CONF_ADDON_PORT), DEFAULT_ADDON_PORT)
            token = str(user_input.get(CONF_BRIDGE_TOKEN, "")).strip()
            base_url = str(user_input.get(CONF_TTS_BASE_URL, "")).strip().rstrip("/")
            if not host:
                errors[CONF_ADDON_HOST] = "addon_host_required"
            elif not token:
                errors[CONF_BRIDGE_TOKEN] = "bridge_token_required"
            elif base_url and not _is_http_base_url(base_url):
                errors[CONF_TTS_BASE_URL] = "invalid_tts_base_url"
            else:
                current_host = str(entry.data.get(CONF_ADDON_HOST, "")).strip()
                current_port = _port(
                    entry.data.get(CONF_ADDON_PORT), DEFAULT_ADDON_PORT
                )
                current_token = str(entry.data.get(CONF_BRIDGE_TOKEN, ""))
                connection_changed = (host, port, token) != (
                    current_host,
                    current_port,
                    current_token,
                )
                if connection_changed:
                    try:
                        await async_validate_addon(
                            async_get_clientsession(self.hass), host, port, token
                        )
                    except AddonError as err:
                        errors["base"] = (
                            "invalid_auth"
                            if err.status in (401, 403)
                            else "cannot_connect"
                        )
                    except Exception:  # noqa: BLE001 - malformed responses are errors
                        errors["base"] = "cannot_connect"

                if not errors:
                    options = {
                        **entry.options,
                        CONF_TTS_BASE_URL: base_url,
                        CONF_ENABLED: bool(
                            user_input.get(CONF_ENABLED, DEFAULT_ENABLED)
                        ),
                    }
                    if connection_changed:
                        self.hass.config_entries.async_update_entry(
                            entry,
                            data={
                                **entry.data,
                                CONF_ADDON_HOST: host,
                                CONF_ADDON_PORT: port,
                                CONF_BRIDGE_TOKEN: token,
                            },
                        )
                    result = self.async_create_entry(data=options)
                    if connection_changed and options == dict(entry.options):
                        # Options did not change, so OptionsFlowWithReload has
                        # nothing to reload; the edited addon address still needs it.
                        self.hass.config_entries.async_schedule_reload(entry.entry_id)
                    return result

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_ADDON_HOST,
                        default=str(current.get(CONF_ADDON_HOST, "")),
                    ): str,
                    vol.Required(
                        CONF_ADDON_PORT,
                        default=_port(
                            current.get(CONF_ADDON_PORT), DEFAULT_ADDON_PORT
                        ),
                    ): vol.All(vol.Coerce(int), vol.Range(min=1, max=65535)),
                    vol.Required(
                        CONF_BRIDGE_TOKEN,
                        default=str(current.get(CONF_BRIDGE_TOKEN, "")),
                    ): selector.TextSelector(
                        selector.TextSelectorConfig(
                            type=selector.TextSelectorType.PASSWORD
                        )
                    ),
                    vol.Optional(
                        CONF_TTS_BASE_URL,
                        default=str(current.get(CONF_TTS_BASE_URL, "")),
                    ): str,
                    vol.Optional(
                        CONF_ENABLED,
                        default=bool(current.get(CONF_ENABLED, DEFAULT_ENABLED)),
                    ): bool,
                }
            ),
            errors=errors,
        )


def _default_options() -> dict[str, object]:
    return {
        CONF_TTS_BASE_URL: "",
        CONF_ENABLED: DEFAULT_ENABLED,
    }
