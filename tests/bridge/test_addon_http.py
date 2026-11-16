"""Addon HTTP client against the mock addon."""

from __future__ import annotations

import aiohttp
import pytest

from helpers import MockAddonServer


@pytest.fixture
async def server():
    mock = MockAddonServer()
    await mock.start()
    yield mock
    await mock.stop()


@pytest.fixture
async def session():
    timeout = aiohttp.ClientTimeout(total=5, connect=1, sock_read=2)
    async with aiohttp.ClientSession(timeout=timeout) as client:
        yield client


async def test_health_status_config(component, server, session):
    client = component.bridge.AddonClient(
        session, server.host, server.port, server.token
    )
    health = await client.async_health()
    assert health["status"] == "ok"
    status = await client.async_status()
    assert status["bridge"]["connected"] is True
    config = await client.async_config()
    assert client.provider_id_from_config(config) == "mock"
    assert server.http_paths[:3] == ["/health", "/api/status", "/api/config"]


async def test_providers_and_selection(component, server, session):
    client = component.bridge.AddonClient(
        session, server.host, server.port, server.token
    )
    providers = await client.async_providers()
    assert [provider["id"] for provider in providers] == ["mock", "openai"]
    assert providers[1]["label"] == "OpenAI"
    payload = await client.async_set_provider("openai")
    assert client.provider_id_from_config(payload) == "openai"
    assert server.config_updates == [{"provider": {"id": "openai"}}]


async def test_test_text(component, server, session):
    client = component.bridge.AddonClient(
        session, server.host, server.port, server.token
    )
    result = await client.async_test_text("включи свет")
    assert result["text"] == "Ответ на запрос"
    assert result["speech"] == "Ответ на запрос"
    assert result["toolTraces"] == [{"name": "ha.call_service", "ok": True}]
    assert server.test_text_requests == [{"text": "включи свет"}]


async def test_wrong_token(component, server, session):
    client = component.bridge.AddonClient(
        session, server.host, server.port, "wrong-token"
    )
    with pytest.raises(component.bridge.AddonError) as error:
        await client.async_status()
    assert error.value.status == 401
    assert error.value.code == "unauthorized"


async def test_validate_addon(component, server, session):
    health, status = await component.bridge.async_validate_addon(
        session, server.host, server.port, server.token
    )
    assert health["status"] == "ok"
    assert "version" in status


async def test_validate_addon_rejects_wrong_token(component, server, session):
    with pytest.raises(component.bridge.AddonError) as error:
        await component.bridge.async_validate_addon(
            session, server.host, server.port, "wrong-token"
        )
    assert error.value.status == 401


async def test_invalid_host(component, session):
    with pytest.raises(component.bridge.AddonError):
        component.bridge.AddonClient(session, "http://ha.local", 8097, "token")
    with pytest.raises(component.bridge.AddonError):
        component.bridge.AddonClient(session, "127.0.0.1", 0, "token")


async def test_unreachable_addon(component, session):
    client = component.bridge.AddonClient(
        session, "127.0.0.1", 1, "token", request_timeout=0.5
    )
    with pytest.raises(component.bridge.AddonError) as error:
        await client.async_health()
    assert error.value.code in ("connection_error", "timeout")
