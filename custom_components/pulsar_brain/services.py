"""Services exposed by the Pulsar Brain bridge."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import voluptuous as vol

from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .bridge import AddonError
from .const import (
    ATTR_RESPONSE,
    ATTR_SPEECH,
    ATTR_TOOL_TRACES,
    DOMAIN,
    SERVICE_ANNOUNCE,
    SERVICE_ASK,
)

if TYPE_CHECKING:
    from . import BridgeRuntime

_ASK_SCHEMA = vol.Schema({vol.Required("text"): str})
_ANNOUNCE_SCHEMA = vol.Schema(
    {
        vol.Required("text"): str,
        vol.Optional(ATTR_ENTITY_ID): cv.entity_id,
    }
)
_ASSIST_SATELLITE_DOMAIN = "assist_satellite"


def _runtime(hass: HomeAssistant) -> BridgeRuntime:
    data = hass.data.get(DOMAIN)
    runtime = getattr(data, "runtime", None)
    if runtime is None:
        raise HomeAssistantError("Интеграция Pulsar Brain не настроена")
    return runtime


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register the integration services once."""
    if hass.services.has_service(DOMAIN, SERVICE_ASK):
        return

    async def _async_handle_ask(call: ServiceCall) -> dict[str, Any]:
        text = str(call.data["text"]).strip()
        if not text:
            raise ServiceValidationError(
                "Текст запроса пуст",
                translation_domain=DOMAIN,
                translation_key="empty_text",
            )
        runtime = _runtime(hass)
        try:
            result = await runtime.async_test_text(text)
        except AddonError as err:
            raise HomeAssistantError(
                f"Аддон Pulsar Brain недоступен: {err.code}"
            ) from err
        response = result.get("text")
        speech = result.get("speech")
        tool_traces = result.get("toolTraces")
        return {
            ATTR_RESPONSE: response if isinstance(response, str) else "",
            ATTR_SPEECH: speech if isinstance(speech, str) else "",
            ATTR_TOOL_TRACES: tool_traces if isinstance(tool_traces, list) else [],
        }

    async def _async_handle_announce(call: ServiceCall) -> None:
        text = str(call.data["text"]).strip()
        if not text:
            raise ServiceValidationError(
                "Текст объявления пуст",
                translation_domain=DOMAIN,
                translation_key="empty_text",
            )
        entity_id = call.data.get(ATTR_ENTITY_ID)
        target = _announce_target(hass, entity_id)
        runtime = _runtime(hass)
        if runtime.active_run is not None:
            raise ServiceValidationError(
                "Нельзя объявлять во время голосового диалога",
                translation_domain=DOMAIN,
                translation_key="voice_run_active",
            )
        # pulsar reports AnnounceFinished only to the voice owner. Hand the slot to
        # HA's own ESPHome client for the announcement, then reclaim it.
        await runtime.async_release_voice_slot()
        try:
            await hass.services.async_call(
                _ASSIST_SATELLITE_DOMAIN,
                "announce",
                {"entity_id": target, "message": text},
                blocking=True,
            )
        finally:
            await runtime.async_claim_voice_slot()

    hass.services.async_register(
        DOMAIN,
        SERVICE_ASK,
        _async_handle_ask,
        schema=_ASK_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_ANNOUNCE,
        _async_handle_announce,
        schema=_ANNOUNCE_SCHEMA,
    )


def _announce_target(hass: HomeAssistant, entity_id: str | None) -> str:
    if entity_id:
        if not entity_id.startswith(f"{_ASSIST_SATELLITE_DOMAIN}."):
            raise ServiceValidationError(
                f"Сущность {entity_id} не является assist_satellite",
                translation_domain=DOMAIN,
                translation_key="invalid_satellite",
                translation_placeholders={"entity_id": entity_id},
            )
        return entity_id
    satellites = hass.states.async_entity_ids(_ASSIST_SATELLITE_DOMAIN)
    if len(satellites) == 1:
        return satellites[0]
    if not satellites:
        raise ServiceValidationError(
            "В Home Assistant нет сущностей assist_satellite",
            translation_domain=DOMAIN,
            translation_key="no_satellite",
        )
    raise ServiceValidationError(
        "Несколько assist_satellite: укажите entity_id",
        translation_domain=DOMAIN,
        translation_key="multiple_satellites",
    )


async def async_unregister_services(hass: HomeAssistant) -> None:
    """Remove the services when the last entry is unloaded."""
    for service in (SERVICE_ASK, SERVICE_ANNOUNCE):
        if hass.services.has_service(DOMAIN, service):
            hass.services.async_remove(DOMAIN, service)
