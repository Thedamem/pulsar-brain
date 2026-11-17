"""Config flow and set_station service tests against the HA-free shim."""

from __future__ import annotations

import pytest


def _discovery(config_flow, shim, **config):
    return config_flow.HassioServiceInfo(
        config={
            "host": "local_pulsar_brain",
            "port": 8097,
            "bridge_token": "bridge-token",
            **config,
        },
        name="Pulsar Brain",
        slug="local_pulsar_brain",
        uuid="discovery-uuid-1",
    )


async def test_hassio_discovery_creates_entry_without_user_input(
    ha_component, monkeypatch
) -> None:
    config_flow = ha_component.config_flow
    const = ha_component.shim and __import__("pulsar_brain.const", fromlist=["const"])
    flow = config_flow.PulsarBrainConfigFlow()
    flow.hass = ha_component.shim.FakeHass([])

    async def healthy(*args, **kwargs):
        del args, kwargs

    monkeypatch.setattr(config_flow, "async_check_health", healthy)
    result = await flow.async_step_hassio(_discovery(config_flow, ha_component.shim))
    assert result["type"] == "create_entry"
    assert result["data"] == {
        const.CONF_ADDON_HOST: "local_pulsar_brain",
        const.CONF_ADDON_PORT: 8097,
        const.CONF_BRIDGE_TOKEN: "bridge-token",
        const.CONF_ADDON_SLUG: "local_pulsar_brain",
    }
    assert result["options"] == {
        const.CONF_TTS_BASE_URL: "",
        const.CONF_ENABLED: True,
    }
    assert flow.unique_id == "discovery-uuid-1"


async def test_hassio_discovery_is_idempotent(ha_component, monkeypatch) -> None:
    config_flow = ha_component.config_flow
    flow = config_flow.PulsarBrainConfigFlow()
    flow.hass = ha_component.shim.FakeHass(
        [ha_component.shim.ConfigEntry(entry_id="e", unique_id="discovery-uuid-1")]
    )

    async def healthy(*args, **kwargs):
        del args, kwargs

    monkeypatch.setattr(config_flow, "async_check_health", healthy)
    with pytest.raises(ha_component.shim.AbortFlow) as err:
        await flow.async_step_hassio(_discovery(config_flow, ha_component.shim))
    assert err.value.reason == "already_configured"


async def test_hassio_discovery_rejects_malformed_payload(ha_component) -> None:
    config_flow = ha_component.config_flow
    flow = config_flow.PulsarBrainConfigFlow()
    flow.hass = ha_component.shim.FakeHass([])
    info = config_flow.HassioServiceInfo(config={}, uuid="u", slug="s")
    result = await flow.async_step_hassio(info)
    assert result == {"type": "abort", "reason": "invalid_discovery"}


async def test_manual_setup_asks_only_for_addon_connection(ha_component, monkeypatch) -> None:
    config_flow = ha_component.config_flow
    const = __import__("pulsar_brain.const", fromlist=["const"])
    flow = config_flow.PulsarBrainConfigFlow()
    flow.hass = ha_component.shim.FakeHass([])

    form = await flow.async_step_user(None)
    assert form["type"] == "form"
    assert form["step_id"] == "user"

    async def validate(*args, **kwargs):
        del args, kwargs

    monkeypatch.setattr(config_flow, "async_validate_addon", validate)
    result = await flow.async_step_user(
        {
            const.CONF_ADDON_HOST: "local-pulsar-brain",
            const.CONF_ADDON_PORT: 8097,
            const.CONF_BRIDGE_TOKEN: "bridge-token",
        }
    )
    assert result["type"] == "create_entry"
    assert result["data"][const.CONF_ADDON_HOST] == "local-pulsar-brain"


def _station_entries(shim):
    const = __import__("pulsar_brain.const", fromlist=["const"])
    integration = shim.ConfigEntry(
        entry_id="pb",
        domain=const.DOMAIN,
        data={
            const.CONF_ADDON_HOST: "local-pulsar-brain",
            const.CONF_ADDON_PORT: 8097,
            const.CONF_BRIDGE_TOKEN: "bridge-token",
        },
        options={const.CONF_ENABLED: True},
    )
    esphome = shim.ConfigEntry(
        entry_id="esp",
        domain=const.ESPHOME_DOMAIN,
        data={
            "host": "192.0.2.61",
            "port": 6053,
            "noise_psk": "psk-from-ha",
            const.CONF_DEVICE_NAME: "yandex-lite2",
        },
    )
    return integration, esphome


async def test_set_station_resolves_esphome_entry(ha_component) -> None:
    shim = ha_component.shim
    const = __import__("pulsar_brain.const", fromlist=["const"])
    integration, esphome = _station_entries(shim)
    hass = shim.FakeHass([integration, esphome])
    await ha_component.services.async_setup_services(hass)
    handler = hass.services.handlers[(const.DOMAIN, const.SERVICE_SET_STATION)]

    await handler(shim.ServiceCall({const.ATTR_ENTRY_ID: "esp"}))
    station = integration.options[const.CONF_STATION]
    assert station[const.ATTR_HOST] == "192.0.2.61"
    assert station[const.ATTR_PORT] == 6053
    assert station[const.CONF_NOISE_PSK] == "psk-from-ha"
    assert hass.config_entries.reloaded == ["pb"]

    await handler(shim.ServiceCall({const.ATTR_CLEAR: True}))
    assert const.CONF_STATION not in integration.options
    assert hass.config_entries.reloaded == ["pb", "pb"]


async def test_set_station_manual_and_missing_entry(ha_component) -> None:
    shim = ha_component.shim
    const = __import__("pulsar_brain.const", fromlist=["const"])
    integration, _esphome = _station_entries(shim)
    hass = shim.FakeHass([integration])
    await ha_component.services.async_setup_services(hass)
    handler = hass.services.handlers[(const.DOMAIN, const.SERVICE_SET_STATION)]

    await handler(
        shim.ServiceCall(
            {const.ATTR_NAME: "Колонка", const.ATTR_HOST: "192.0.2.61", "noise_psk": "p"}
        )
    )
    station = integration.options[const.CONF_STATION]
    assert station[const.ATTR_MODE] == const.STATION_MODE_MANUAL
    assert station[const.CONF_NOISE_PSK] == "p"

    with pytest.raises(shim.ServiceValidationError) as err:
        await handler(shim.ServiceCall({const.ATTR_ENTRY_ID: "missing"}))
    assert err.value.translation_key == "esphome_entry_missing"
