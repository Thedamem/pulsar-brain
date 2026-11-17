"""Minimal Home Assistant and voluptuous surface for config_flow/services tests.

The dev venv intentionally has no Home Assistant. These shims implement only the APIs
that ``config_flow.py`` and ``services.py`` touch, so their orchestration can be tested
without HA; the HA-facing files themselves are additionally checked with py_compile and
an import against the running dev container.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from dataclasses import dataclass
from enum import Enum
from typing import Any

import pytest


class AbortFlow(Exception):
    """Stand-in for homeassistant.data_entry_flow.AbortFlow."""

    def __init__(
        self,
        reason: str,
        description_placeholders: dict[str, str] | None = None,
    ) -> None:
        super().__init__(reason)
        self.reason = reason
        self.description_placeholders = description_placeholders or {}


class ConfigEntry:
    """Config entry attributes used by the integration."""

    def __init__(
        self,
        entry_id: str = "entry",
        *,
        domain: str = "pulsar_brain",
        title: str = "",
        data: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
        unique_id: str | None = None,
    ) -> None:
        self.entry_id = entry_id
        self.domain = domain
        self.title = title
        self.data = dict(data or {})
        self.options = dict(options or {})
        self.unique_id = unique_id
        self.state = "loaded"


class ConfigFlow:
    """The subset of ConfigFlow used by PulsarBrainConfigFlow."""

    VERSION = 1
    domain = "pulsar_brain"

    def __init_subclass__(cls, *, domain: str | None = None, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        if domain is not None:
            cls.domain = domain

    def __init__(self) -> None:
        self.hass: Any = None
        self.context: dict[str, Any] = {}
        self._unique_id: str | None = None

    @property
    def unique_id(self) -> str | None:
        return self._unique_id

    async def async_set_unique_id(
        self, unique_id: str | None = None, *, raise_on_progress: bool = True
    ) -> None:
        del raise_on_progress
        self._unique_id = unique_id
        self.context["unique_id"] = unique_id

    def _abort_if_unique_id_configured(self) -> None:
        if self._unique_id is None:
            return
        for entry in self.hass.config_entries.async_entries(self.domain):
            if entry.unique_id == self._unique_id:
                raise AbortFlow("already_configured")

    def _async_current_entries(self) -> list[ConfigEntry]:
        return self.hass.config_entries.async_entries(self.domain)

    def async_abort(self, *, reason: str, **kwargs: Any) -> dict[str, Any]:
        del kwargs
        return {"type": "abort", "reason": reason}

    def async_create_entry(
        self,
        *,
        title: str,
        data: dict[str, Any],
        options: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        del kwargs
        return {
            "type": "create_entry",
            "title": title,
            "data": dict(data),
            "options": dict(options or {}),
        }

    def async_show_form(
        self,
        *,
        step_id: str,
        data_schema: Any = None,
        errors: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        del kwargs
        return {
            "type": "form",
            "step_id": step_id,
            "data_schema": data_schema,
            "errors": errors or {},
        }


class OptionsFlowWithReload:
    """The subset of OptionsFlowWithReload used by PulsarBrainOptionsFlow."""

    automatic_reload = True

    def __init__(self) -> None:
        self.hass: Any = None
        self._config_entry: ConfigEntry | None = None

    @property
    def config_entry(self) -> ConfigEntry:
        if self._config_entry is None:
            raise RuntimeError("config entry is not set")
        return self._config_entry

    def async_create_entry(
        self, *, data: dict[str, Any], **kwargs: Any
    ) -> dict[str, Any]:
        del kwargs
        return {"type": "create_entry", "data": dict(data)}

    def async_show_form(
        self,
        *,
        step_id: str,
        data_schema: Any = None,
        errors: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        del kwargs
        return {
            "type": "form",
            "step_id": step_id,
            "data_schema": data_schema,
            "errors": errors or {},
        }


class HomeAssistantError(Exception):
    """Stand-in for homeassistant.exceptions.HomeAssistantError."""


class ServiceValidationError(HomeAssistantError):
    """Stand-in for homeassistant.exceptions.ServiceValidationError."""

    def __init__(
        self,
        message: str = "",
        *,
        translation_domain: str | None = None,
        translation_key: str | None = None,
        translation_placeholders: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.translation_domain = translation_domain
        self.translation_key = translation_key
        self.translation_placeholders = translation_placeholders


class ServiceCall:
    """Stand-in for homeassistant.core.ServiceCall."""

    def __init__(self, data: dict[str, Any] | None = None) -> None:
        self.data = dict(data or {})


class SupportsResponse(Enum):
    """Stand-in for homeassistant.core.SupportsResponse."""

    NONE = "none"
    OPTIONAL = "optional"
    ONLY = "only"


class TextSelectorType(Enum):
    TEXT = "text"
    PASSWORD = "password"


class TextSelectorConfig:
    def __init__(self, *, type: TextSelectorType = TextSelectorType.TEXT) -> None:
        self.type = type


class TextSelector:
    def __init__(self, config: TextSelectorConfig | None = None) -> None:
        self.config = config


class HassioServiceInfo:
    """Stand-in for homeassistant.helpers.service_info.hassio.HassioServiceInfo."""

    def __init__(
        self,
        *,
        config: dict[str, Any] | None = None,
        name: str = "",
        slug: str = "",
        uuid: str = "",
    ) -> None:
        self.config = dict(config or {})
        self.name = name
        self.slug = slug
        self.uuid = uuid


class _FakeStates:
    def async_entity_ids(self, domain: str) -> list[str]:
        del domain
        return []


class FakeConfigEntries:
    """Config entry registry for the service tests."""

    def __init__(self, entries: list[ConfigEntry] | None = None) -> None:
        self.entries = list(entries or [])
        self.updates: list[tuple[str, bool]] = []
        self.reloaded: list[str] = []
        self.scheduled: list[str] = []

    def async_entries(self, domain: str) -> list[ConfigEntry]:
        return [entry for entry in self.entries if entry.domain == domain]

    def async_get_entry(self, entry_id: str) -> ConfigEntry | None:
        return next(
            (entry for entry in self.entries if entry.entry_id == entry_id), None
        )

    def async_update_entry(
        self,
        entry: ConfigEntry,
        *,
        data: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> bool:
        del kwargs
        changed = False
        if data is not None and dict(data) != entry.data:
            entry.data = dict(data)
            changed = True
        if options is not None and dict(options) != entry.options:
            entry.options = dict(options)
            changed = True
        self.updates.append((entry.entry_id, changed))
        return changed

    async def async_reload(self, entry_id: str) -> bool:
        self.reloaded.append(entry_id)
        return True

    def async_schedule_reload(self, entry_id: str) -> None:
        self.scheduled.append(entry_id)


class FakeServices:
    """Service registry for the service tests."""

    def __init__(self) -> None:
        self.handlers: dict[tuple[str, str], Any] = {}
        self.schemas: dict[tuple[str, str], Any] = {}

    def has_service(self, domain: str, service: str) -> bool:
        return (domain, service) in self.handlers

    def async_register(
        self,
        domain: str,
        service: str,
        handler: Any,
        schema: Any = None,
        supports_response: Any = None,
    ) -> None:
        del supports_response
        self.handlers[(domain, service)] = handler
        self.schemas[(domain, service)] = schema

    def async_remove(self, domain: str, service: str) -> None:
        self.handlers.pop((domain, service), None)
        self.schemas.pop((domain, service), None)


class FakeHass:
    """Home Assistant object with the registries the integration reads."""

    def __init__(self, entries: list[ConfigEntry] | None = None) -> None:
        self.config_entries = FakeConfigEntries(entries)
        self.services = FakeServices()
        self.states = _FakeStates()
        self.data: dict[str, Any] = {}


@dataclass(frozen=True)
class Shim:
    """Classes exported to tests."""

    AbortFlow: type[AbortFlow]
    ConfigEntry: type[ConfigEntry]
    FakeEntry: type[ConfigEntry]
    FakeHass: type[FakeHass]
    ServiceCall: type[ServiceCall]
    ServiceValidationError: type[ServiceValidationError]
    HomeAssistantError: type[HomeAssistantError]


_SHIM: Shim | None = None


def install() -> Shim:
    """Install the shims once and return their classes."""
    global _SHIM
    if _SHIM is not None:
        return _SHIM
    if "homeassistant" not in sys.modules and _real_homeassistant_installed():
        pytest.skip(
            "Home Assistant is installed; the shim tests target the HA-free dev venv"
        )

    _install_voluptuous()
    _install_homeassistant()
    _SHIM = Shim(
        AbortFlow=AbortFlow,
        ConfigEntry=ConfigEntry,
        FakeEntry=ConfigEntry,
        FakeHass=FakeHass,
        ServiceCall=ServiceCall,
        ServiceValidationError=ServiceValidationError,
        HomeAssistantError=HomeAssistantError,
    )
    return _SHIM


def _real_homeassistant_installed() -> bool:
    try:
        return importlib.util.find_spec("homeassistant") is not None
    except (ImportError, ValueError):
        return False


def _install_voluptuous() -> None:
    if "voluptuous" in sys.modules:
        return
    module = types.ModuleType("voluptuous")

    class Schema:
        def __init__(self, schema: Any = None, **kwargs: Any) -> None:
            del kwargs
            self.schema = schema

        def __call__(self, value: Any) -> Any:
            return value

    def _key(key: str, default: Any = None) -> str:
        del default
        return key

    class All:
        def __init__(self, *validators: Any) -> None:
            self.validators = validators

    class Coerce:
        def __init__(self, target: type) -> None:
            self.target = target

    class Range:
        def __init__(self, *, min: Any = None, max: Any = None) -> None:
            self.min = min
            self.max = max

    class In:
        def __init__(self, container: Any) -> None:
            self.container = container

    module.Schema = Schema
    module.Required = _key
    module.Optional = _key
    module.All = All
    module.Coerce = Coerce
    module.Range = Range
    module.In = In
    sys.modules["voluptuous"] = module


def _install_homeassistant() -> None:
    if "homeassistant" in sys.modules:
        return

    homeassistant = _package("homeassistant")
    helpers = _package("homeassistant.helpers")
    service_info = _package("homeassistant.helpers.service_info")
    _package("homeassistant.helpers.service_info.hassio")

    config_entries = _package("homeassistant.config_entries")
    config_entries.ConfigEntry = ConfigEntry
    config_entries.ConfigFlow = ConfigFlow
    config_entries.ConfigFlowResult = dict[str, Any]
    config_entries.OptionsFlowWithReload = OptionsFlowWithReload
    config_entries.AbortFlow = AbortFlow

    const = _package("homeassistant.const")
    const.ATTR_ENTITY_ID = "entity_id"

    core = _package("homeassistant.core")
    core.HomeAssistant = object
    core.ServiceCall = ServiceCall
    core.SupportsResponse = SupportsResponse
    core.callback = _callback

    exceptions = _package("homeassistant.exceptions")
    exceptions.HomeAssistantError = HomeAssistantError
    exceptions.ServiceValidationError = ServiceValidationError

    selector = _package("homeassistant.helpers.selector")
    selector.TextSelector = TextSelector
    selector.TextSelectorConfig = TextSelectorConfig
    selector.TextSelectorType = TextSelectorType

    aiohttp_client = _package("homeassistant.helpers.aiohttp_client")
    aiohttp_client.async_get_clientsession = lambda hass: None

    config_validation = _package("homeassistant.helpers.config_validation")
    config_validation.entity_id = "entity_id"

    hassio_module = sys.modules["homeassistant.helpers.service_info.hassio"]
    hassio_module.HassioServiceInfo = HassioServiceInfo

    homeassistant.config_entries = config_entries
    homeassistant.const = const
    homeassistant.core = core
    homeassistant.exceptions = exceptions
    homeassistant.helpers = helpers
    helpers.selector = selector
    helpers.aiohttp_client = aiohttp_client
    helpers.config_validation = config_validation
    helpers.service_info = service_info
    service_info.hassio = hassio_module


def _package(name: str) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__path__ = []
    sys.modules[name] = module
    return module


def _callback(function: Any) -> Any:
    return function
