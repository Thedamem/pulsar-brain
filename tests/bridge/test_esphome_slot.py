"""Voice-slot handover used around HA announcements."""

from __future__ import annotations

import types



class FakeClient:
    def __init__(self) -> None:
        self.is_connected = True
        self.subscribed = 0
        self.unsubscribed = 0
        self.events: list[object] = []

    def subscribe_voice_assistant(self, **kwargs):
        self.subscribed += 1
        self.last_kwargs = kwargs

        def _unsub() -> None:
            self.unsubscribed += 1

        return _unsub

    def send_voice_assistant_event(self, event_type, data):
        self.events.append((event_type, data))


class FakeBridge:
    def start_run(self, *args, **kwargs):
        raise AssertionError("start_run is not used by this test")


def make_client(component):
    esphome_client = component.esphome_client
    return esphome_client.EsphomeVoiceClient(
        types.SimpleNamespace(),
        host="127.0.0.1",
        port=6053,
        noise_psk="",
        device_name="test",
        bridge=FakeBridge(),
        tts_store=component.tts_store.TtsStore("token"),
        get_tts_base_url=lambda: "http://ha.local:8123",
        on_device_event=lambda name, data: None,
        on_run_started=lambda run_id: None,
        on_run_finished=lambda run_id, reason: None,
        on_connection_change=lambda connected: None,
    )


async def test_release_without_subscription_is_a_noop(component):
    client = make_client(component)
    assert await client.async_release_voice_slot() is False


async def test_release_and_claim_roundtrip(component):
    client = make_client(component)
    fake = FakeClient()
    client._client = fake
    client._connected = True
    unsub_calls: list[bool] = []

    def _unsub() -> None:
        unsub_calls.append(True)

    client._unsub = _unsub
    assert await client.async_release_voice_slot() is True
    assert unsub_calls == [True]
    assert client._unsub is None
    assert client._slot_released is True

    await client.async_claim_voice_slot()
    assert client._slot_released is False
    assert fake.subscribed == 1
    assert callable(client._unsub)


async def test_claim_without_connection_waits_for_reconnect(component):
    client = make_client(component)
    client._slot_released = True
    await client.async_claim_voice_slot()
    assert client._slot_released is False
    assert client._unsub is None


async def test_start_is_ignored_while_slot_released(component):
    client = make_client(component)
    client._slot_released = True
    result = await client._async_handle_start("conversation", 0, None, "")
    assert result == 0
    assert client.active_run_id is None
