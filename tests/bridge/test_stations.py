"""Unit tests for the station binding model (pure module, no Home Assistant)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest


def esphome_entry(entry_id: str, title: str, host: str, psk: str, unique_id: str = ""):
    return SimpleNamespace(
        entry_id=entry_id,
        title=title,
        unique_id=unique_id,
        data={"host": host, "port": 6053, "noise_psk": psk, "device_name": title},
    )


def test_parse_station_accepts_valid_and_rejects_malformed(component) -> None:
    const = component.const
    valid = {
        const.ATTR_MODE: const.STATION_MODE_MANUAL,
        const.ATTR_ENTRY_ID: "",
        const.ATTR_NAME: "Станция",
        const.ATTR_HOST: "192.0.2.61",
        const.ATTR_PORT: 6053,
        const.CONF_NOISE_PSK: "psk",
    }
    parse = component.stations.parse_station
    assert parse(valid) is not None
    assert parse(None) is None
    assert parse({**valid, const.ATTR_HOST: ""}) is None
    assert parse({**valid, const.ATTR_PORT: 0}) is None
    assert parse({**valid, const.ATTR_MODE: "other"}) is None


def test_manual_station_requires_host_and_defaults_port(component) -> None:
    const = component.const
    station = component.stations.manual_station({"name": "Колонка", "host": "192.0.2.61"})
    assert station[const.ATTR_PORT] == 6053
    with pytest.raises(component.stations.StationError):
        component.stations.manual_station({"name": "Колонка", "host": ""})


def test_station_from_esphome_entry_takes_psk_from_ha(component) -> None:
    const = component.const
    entry = esphome_entry(
        "01ESP", "yandex-lite2", "192.0.2.61", "psk-from-ha", unique_id="02:00:00:00:00:01"
    )
    station = component.stations.station_from_esphome_entry(entry)
    assert station[const.ATTR_MODE] == const.STATION_MODE_DISCOVERED
    assert station[const.ATTR_ENTRY_ID] == "01ESP"
    assert station[const.ATTR_HOST] == "192.0.2.61"
    assert station[const.CONF_NOISE_PSK] == "psk-from-ha"


def test_station_options_updated_discovered_and_manual(component) -> None:
    const = component.const
    entries = {"01ESP": esphome_entry("01ESP", "yandex-lite2", "192.0.2.61", "psk")}
    options = component.stations.station_options_updated({}, {"entry_id": "01ESP"}, entries)
    assert options[const.CONF_STATION][const.ATTR_ENTRY_ID] == "01ESP"
    manual = component.stations.station_options_updated(
        {}, {"name": "Моя", "host": "192.0.2.62"}, {}
    )
    assert manual[const.CONF_STATION][const.ATTR_MODE] == const.STATION_MODE_MANUAL
    with pytest.raises(component.stations.StationError) as err:
        component.stations.station_options_updated({}, {"entry_id": "missing"}, entries)
    assert err.value.code == "esphome_entry_missing"


def test_station_options_cleared_removes_only_station(component) -> None:
    const = component.const
    options = component.stations.station_options_cleared(
        {const.CONF_STATION: {"host": "x"}, "enabled": True}
    )
    assert const.CONF_STATION not in options
    assert options["enabled"] is True


def test_build_station_list_skips_entries_without_host_and_has_no_psk(component) -> None:
    const = component.const
    stations = component.stations.build_station_list(
        [
            esphome_entry(
                "01", "Станция 1", "192.0.2.61", "secret", "02:00:00:00:00:01"
            ),
            SimpleNamespace(entry_id="02", title="Без адреса", unique_id=None, data={}),
        ]
    )
    assert len(stations) == 1
    station = stations[0]
    assert station[const.ATTR_ENTRY_ID] == "01"
    assert station["mac"] == "02:00:00:00:00:01"
    assert const.CONF_NOISE_PSK not in station
    assert "secret" not in str(station)


def test_describe_station_never_includes_psk(component) -> None:
    const = component.const
    station = {
        const.ATTR_MODE: const.STATION_MODE_MANUAL,
        const.ATTR_NAME: "Станция",
        const.ATTR_HOST: "192.0.2.61",
        const.ATTR_PORT: 6053,
        const.CONF_NOISE_PSK: "super-secret",
    }
    text = component.stations.describe_station(station)
    assert "192.0.2.61:6053" in text
    assert "super-secret" not in text


def test_station_binding_payload_never_includes_psk(component) -> None:
    const = component.const
    station = {
        const.ATTR_MODE: const.STATION_MODE_DISCOVERED,
        const.ATTR_ENTRY_ID: "01ESP",
        const.ATTR_NAME: "yandex-lite2",
        const.ATTR_HOST: "192.0.2.61",
        const.ATTR_PORT: 6053,
        const.CONF_NOISE_PSK: "super-secret",
    }
    payload = component.stations.station_binding_payload(station)
    assert payload is not None
    assert payload[const.ATTR_ENTRY_ID] == "01ESP"
    assert payload["has_psk"] is True
    assert "super-secret" not in str(payload)
    assert component.stations.station_binding_payload(None) is None


def test_migrate_legacy_station_moves_device_data_to_options(component) -> None:
    const = component.const
    data = {
        "addon_host": "local-pulsar-brain",
        "device_host": "192.0.2.61",
        "device_port": 6053,
        "device_name": "yandex-lite2-000001",
        const.CONF_NOISE_PSK: "psk",
    }
    migrate = component.stations.migrate_legacy_station
    migrated = migrate(data, {"enabled": True})
    assert migrated is not None
    station = migrated[const.CONF_STATION]
    assert station[const.ATTR_MODE] == const.STATION_MODE_MANUAL
    assert station[const.ATTR_HOST] == "192.0.2.61"
    assert station[const.CONF_NOISE_PSK] == "psk"
    assert migrated["enabled"] is True
    assert migrate(data, migrated) is None
    assert migrate({"addon_host": "x"}, {}) is None
