"""ESPHome voice-assistant client for the pulsar speaker.

The bridge owns the voice-assistant slot: it subscribes as a separate APIClient,
answers VoiceAssistantRequest(start=true) with port 0 (API audio), forwards
microphone PCM to the addon and turns addon events into device events.

aioesphomeapi is provided by Home Assistant (46.25 on HA 2026.11; the dev venv has
46.30). The optional wake_word_audio keyword is probed at runtime because 46.25 does
not accept it yet.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
import inspect
import logging
import time
from typing import TYPE_CHECKING
import uuid

from aioesphomeapi import (
    APIClient,
    APIConnectionError,
    DeviceInfo,
    VoiceAssistantAnnounceFinished,
    VoiceAssistantAudioSettings,
    VoiceAssistantEventType,
)

from .bridge import BridgeClient, BridgeRun
from .const import (
    ADDON_REQUEST_TIMEOUT,
    DOMAIN,
    RECONNECT_MAX_DELAY,
    RECONNECT_MIN_DELAY,
    RESUBSCRIBE_INTERVAL,
    SPEAKING_GUARD_SECONDS,
    VERSION,
    VOICE_ASSISTANT_FLAG_USE_WAKE_WORD,
)
from .events import EVENT_ENUM_NAMES, event_from_addon, normalize_event_data
from .protocol import DeviceDescriptor, RunRequest, join_base_url
from .tts_store import TtsStore

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

DeviceEventCallback = Callable[[str, dict[str, str]], None]
RunStartedCallback = Callable[[str], None]
RunFinishedCallback = Callable[[str, str], None]
ConnectionCallback = Callable[[bool], None]


@lru_cache(maxsize=1)
def _supports_wake_word_audio() -> bool:
    """Whether this aioesphomeapi version knows the wake_word_audio keyword."""
    return "wake_word_audio" in inspect.signature(
        APIClient.subscribe_voice_assistant
    ).parameters


@dataclass
class _ActiveRun:
    run_id: str
    base_url: str
    bridge: BridgeRun


class EsphomeVoiceClient:
    """Lifecycle wrapper around APIClient's voice-assistant subscription."""

    def __init__(
        self,
        hass: HomeAssistant,
        *,
        host: str,
        port: int,
        noise_psk: str,
        device_name: str,
        bridge: BridgeClient,
        tts_store: TtsStore,
        get_tts_base_url: Callable[[], str],
        on_device_event: DeviceEventCallback,
        on_run_started: RunStartedCallback,
        on_run_finished: RunFinishedCallback,
        on_connection_change: ConnectionCallback,
    ) -> None:
        self._hass = hass
        self._host = host
        self._port = port
        self._noise_psk = noise_psk or None
        self._device_name = device_name
        self._bridge = bridge
        self._tts_store = tts_store
        self._get_tts_base_url = get_tts_base_url
        self._on_device_event = on_device_event
        self._on_run_started = on_run_started
        self._on_run_finished = on_run_finished
        self._on_connection_change = on_connection_change

        self._client: APIClient | None = None
        self._unsub: Callable[[], None] | None = None
        self._connect_task: asyncio.Task[None] | None = None
        self._renew_task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._connected = False
        self._device_info: DeviceInfo | None = None
        self._active: _ActiveRun | None = None
        self._run_base_urls: dict[str, str] = {}
        self._last_run_started = 0.0
        self._speaking = False
        self._last_tts_at = 0.0
        self._slot_released = False

    @property
    def connected(self) -> bool:
        """Whether the ESPHome API connection and VA subscription are up."""
        return self._connected

    @property
    def active_run_id(self) -> str | None:
        """Run currently owned by the bridge, if any."""
        return self._active.run_id if self._active is not None else None

    @property
    def device_name(self) -> str:
        """ESPHome device name (from the device when connected)."""
        if self._device_info is not None and self._device_info.name:
            return self._device_info.name
        return self._device_name

    @property
    def mac_address(self) -> str:
        """Device MAC address when known."""
        return self._device_info.mac_address if self._device_info is not None else ""

    @property
    def firmware(self) -> str:
        """Firmware/project version when known."""
        if self._device_info is None:
            return ""
        return self._device_info.project_version or self._device_info.esphome_version or ""

    async def async_start(self) -> None:
        """Start connecting, subscribing and the ownership-renewal loop."""
        if self._connect_task is not None and not self._connect_task.done():
            return
        self._stop_event.clear()
        self._connect_task = self._hass.async_create_background_task(
            self._async_connect_loop(),
            name=f"{DOMAIN} esphome connect",
        )
        if self._renew_task is None or self._renew_task.done():
            self._renew_task = self._hass.async_create_background_task(
                self._async_renew_loop(),
                name=f"{DOMAIN} esphome resubscribe",
            )

    async def async_stop(self) -> None:
        """Unsubscribe, disconnect and cancel background work."""
        self._stop_event.set()
        self._unsubscribe()
        active = self._active
        if active is not None:
            active.bridge.cancel("client")
            try:
                async with asyncio.timeout(2):
                    await active.bridge.wait_closed()
            except TimeoutError:
                active.bridge.abort()
        client = self._client
        if client is not None:
            client.force_disconnect()
        tasks = [
            task
            for task in (self._connect_task, self._renew_task)
            if task is not None and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._connect_task = None
        self._renew_task = None
        self._client = None
        self._active = None
        self._run_base_urls.clear()
        self._speaking = False
        self._last_tts_at = 0.0
        self._last_run_started = 0.0
        self._set_connected(False)

    # ────────────────────────────────────────────────────────────── connection ──

    async def _async_connect_loop(self) -> None:
        delay = RECONNECT_MIN_DELAY
        while not self._stop_event.is_set():
            client: APIClient | None = None
            closed = asyncio.Event()

            try:
                client = APIClient(
                    self._host,
                    self._port,
                    noise_psk=self._noise_psk,
                    client_info=f"{DOMAIN}/{VERSION}",
                )

                async def _on_stop(
                    expected_disconnect: bool,
                    active_client: APIClient = client,
                ) -> None:
                    closed.set()
                    _LOGGER.debug(
                        "ESPHome connection closed (expected=%s)",
                        expected_disconnect,
                    )
                    if self._client is active_client and self._active is not None:
                        self._active.bridge.cancel("client")

                self._client = client
                await client.connect(
                    on_stop=_on_stop,
                    login=False,
                    log_errors=False,
                )
                await self._async_load_device_info(client)
                if self._stop_event.is_set():
                    break
                # Mark the connection usable before subscribing: the device may send
                # VoiceAssistantRequest as soon as the subscription lands.
                self._set_connected(True)
                if not self._slot_released and not self._subscribe(client):
                    self._set_connected(False)
                    raise RuntimeError("voice assistant subscription failed")
                delay = RECONNECT_MIN_DELAY
                _LOGGER.info(
                    "Connected to ESPHome voice device %s at %s:%s",
                    self.device_name,
                    self._host,
                    self._port,
                )
                await closed.wait()
            except asyncio.CancelledError:
                raise
            except APIConnectionError as err:
                _LOGGER.warning(
                    "ESPHome connection to %s:%s failed: %s", self._host, self._port, err
                )
            except Exception:  # noqa: BLE001 - keep the reconnect loop alive
                _LOGGER.exception(
                    "ESPHome client error for %s:%s", self._host, self._port
                )
            finally:
                self._unsubscribe()
                active = self._active
                if active is not None:
                    active.bridge.cancel("client")
                self._set_connected(False)
                if self._client is client:
                    self._client = None
                if client is not None:
                    try:
                        await client.disconnect()
                    except (APIConnectionError, OSError):
                        pass
                    except Exception:  # noqa: BLE001 - already disconnecting
                        _LOGGER.debug("ESPHome disconnect raised", exc_info=True)
            if self._stop_event.is_set():
                break
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=delay
                )
            except TimeoutError:
                pass
            delay = min(delay * 2, RECONNECT_MAX_DELAY)

    async def _async_load_device_info(self, client: APIClient) -> None:
        try:
            async with asyncio.timeout(ADDON_REQUEST_TIMEOUT):
                info = await client.device_info()
        except (APIConnectionError, OSError, TimeoutError) as err:
            _LOGGER.warning("Could not read ESPHome device info: %s", err)
            return
        self._device_info = info
        _LOGGER.debug(
            "ESPHome device: name=%s mac=%s project=%s/%s",
            info.name,
            info.mac_address,
            info.project_name,
            info.project_version,
        )

    def _subscribe(self, client: APIClient) -> bool:
        if self._unsub is not None:
            return True
        if not client.is_connected:
            return False
        kwargs: dict[str, bool] = {}
        if _supports_wake_word_audio():
            kwargs["wake_word_audio"] = False
        try:
            self._unsub = client.subscribe_voice_assistant(
                handle_start=self._async_handle_start,
                handle_stop=self._async_handle_stop,
                handle_audio=self._async_handle_audio,
                handle_announcement_finished=self._async_handle_announcement_finished,
                **kwargs,
            )
        except (APIConnectionError, OSError) as err:
            _LOGGER.warning("Voice assistant subscription failed: %s", err)
            self._unsub = None
            return False
        if _supports_wake_word_audio():
            _LOGGER.debug("Subscribed to voice assistant (wake_word_audio=False)")
        else:
            _LOGGER.debug("Subscribed to voice assistant")
        return True

    def _unsubscribe(self) -> None:
        unsub = self._unsub
        self._unsub = None
        if unsub is None:
            return
        try:
            unsub()
        except (APIConnectionError, OSError, RuntimeError) as err:
            _LOGGER.debug("Voice assistant unsubscribe failed: %s", err)

    async def _async_renew_loop(self) -> None:
        try:
            while not self._stop_event.is_set():
                try:
                    await asyncio.wait_for(
                        self._stop_event.wait(), timeout=RESUBSCRIBE_INTERVAL
                    )
                except TimeoutError:
                    pass
                if self._stop_event.is_set():
                    return
                if not self._connected or self._active is not None:
                    continue
                if self._slot_released:
                    continue
                # Playback keeps the slot busy; unsubscribing cuts the answer short.
                if self._speaking and (
                    time.monotonic() - self._last_tts_at < SPEAKING_GUARD_SECONDS
                ):
                    continue
                if self._last_tts_at and (
                    time.monotonic() - self._last_tts_at < RESUBSCRIBE_INTERVAL
                ):
                    continue
                if (
                    self._last_run_started
                    and time.monotonic() - self._last_run_started < RESUBSCRIBE_INTERVAL
                ):
                    continue
                client = self._client
                if client is None or not client.is_connected:
                    continue
                # Re-sending SubscribeVoiceAssistant(true) is what moves the slot back to
                # us; aioesphomeapi has no cheaper "renew" call, and a plain second call
                # would register duplicate handlers.
                self._unsubscribe()
                self._subscribe(client)
                _LOGGER.debug("Renewed voice assistant subscription")
        except asyncio.CancelledError:
            raise

    async def async_release_voice_slot(self) -> bool:
        """Temporarily let Home Assistant's own ESPHome client own the slot.

        pulsar reports AnnounceFinished only to the voice owner, so an
        assist_satellite.announce issued by HA would otherwise wait for its 5 minute
        timeout while the answer is already playing.
        """
        if self._unsub is None:
            return False
        self._slot_released = True
        self._unsubscribe()
        _LOGGER.debug("Released voice assistant slot for an HA announcement")
        return True

    async def async_claim_voice_slot(self) -> None:
        """Re-acquire the slot after an HA announcement."""
        self._slot_released = False
        client = self._client
        if client is not None and client.is_connected:
            self._subscribe(client)
            _LOGGER.debug("Re-claimed voice assistant slot after an HA announcement")

    def _set_connected(self, connected: bool) -> None:
        if self._connected == connected:
            return
        self._connected = connected
        if not connected:
            # No playback can be running once the API connection is gone; do not let
            # the renewal loop keep skipping after a reconnect.
            self._speaking = False
            self._last_tts_at = 0.0
        try:
            self._on_connection_change(connected)
        except Exception:  # noqa: BLE001 - entity callbacks must not break reconnect
            _LOGGER.exception("Connection state callback failed")

    # ───────────────────────────────────────────────────────── voice callbacks ──

    async def _async_handle_start(
        self,
        conversation_id: str,
        flags: int,
        audio_settings: VoiceAssistantAudioSettings,
        wake_word_phrase: str | None,
    ) -> int:
        """Open one addon run and answer with port 0 (API audio)."""
        del audio_settings  # the addon owns VAD settings
        if self._slot_released:
            _LOGGER.debug("Ignoring voice start while the slot is released")
            return 0
        phrase = wake_word_phrase or ""
        previous = self._active
        if previous is not None:
            _LOGGER.debug(
                "New voice request while run %s is active; replacing it",
                previous.run_id,
            )
            if not previous.bridge.done and not previous.bridge.run_end_sent:
                # pulsar binds events to a run and expects the replaced run's RUN_END
                # before the new RUN_START.
                self._send_device_event("run_end", {})
                previous.bridge.cancel("barge_in")
        self._speaking = False
        self._last_run_started = time.monotonic()
        try:
            base_url = self._get_tts_base_url()
        except Exception as err:  # noqa: BLE001 - reported to the speaker below
            _LOGGER.error("No URL is available to serve TTS: %s", err)
            self._send_device_event("run_start", {})
            self._send_device_event("stt_start", {})
            self._send_device_event(
                "error",
                {
                    "code": "tts-url-unavailable",
                    "message": "Не удалось получить адрес Home Assistant для ответа",
                },
            )
            self._send_device_event("run_end", {})
            return 0

        run_id = uuid.uuid4().hex
        request = RunRequest(
            run_id=run_id,
            device=self._device_descriptor(),
            wake_word_phrase=phrase,
            use_wake_word=bool(phrase) or bool(flags & VOICE_ASSISTANT_FLAG_USE_WAKE_WORD),
        )
        try:
            run = self._bridge.start_run(
                request,
                on_device_event=self._send_device_event,
                publish_tts=self._async_publish_tts,
                on_finished=self._handle_run_finished,
            )
        except Exception as err:  # noqa: BLE001 - must still answer the device
            _LOGGER.exception("Could not start bridge run %s", run_id)
            self._send_device_event("run_start", {})
            self._send_device_event("stt_start", {})
            self._send_device_event(
                "error",
                {"code": "bridge-start-failed", "message": "Не удалось открыть run"},
            )
            self._send_device_event("run_end", {})
            return 0
        self._active = _ActiveRun(run_id=run_id, base_url=base_url, bridge=run)
        self._run_base_urls[run_id] = base_url
        _LOGGER.debug(
            "Voice run %s started (conversation=%s, phrase=%s)",
            run_id,
            conversation_id,
            bool(phrase),
        )
        try:
            self._on_run_started(run_id)
        except Exception:  # noqa: BLE001 - entity callbacks must not abort the run
            _LOGGER.exception("Run start callback failed")
        return 0

    async def _async_handle_stop(self, abort: bool) -> None:
        active = self._active
        if active is None:
            return
        _LOGGER.debug("Device stopped voice run %s (abort=%s)", active.run_id, abort)
        if not active.bridge.done:
            if not active.bridge.run_end_sent:
                self._send_device_event("run_end", {})
            if abort:
                active.bridge.cancel("barge_in")
            else:
                active.bridge.end("device_stop")

    async def _async_handle_audio(self, data: bytes, data2: bytes | None) -> None:
        del data2  # second microphone channel is unused
        active = self._active
        if active is None or not data:
            return
        active.bridge.send_audio(data)

    async def _async_handle_announcement_finished(
        self, finished: VoiceAssistantAnnounceFinished
    ) -> None:
        self._speaking = False
        _LOGGER.debug("Answer playback finished (success=%s)", finished.success)

    # ─────────────────────────────────────────────────────────────── run bridge ──

    async def _async_publish_tts(self, run_id: str, text: str, wav: bytes) -> str:
        del text  # the text is carried in the TTS_START event
        path = self._tts_store.publish(run_id, wav)
        base_url = self._run_base_urls.get(run_id)
        if base_url is None:
            base_url = self._get_tts_base_url()
        return join_base_url(base_url, path)

    def _handle_run_finished(self, run_id: str, reason: str) -> None:
        self._run_base_urls.pop(run_id, None)
        if self._active is not None and self._active.run_id == run_id:
            self._active = None
        try:
            self._on_run_finished(run_id, reason)
        except Exception:  # noqa: BLE001 - entity callbacks must not break cleanup
            _LOGGER.exception("Run finish callback failed")

    def _send_device_event(self, name: str, data: dict[str, str]) -> None:
        if event_from_addon(name) is None:
            _LOGGER.warning("Unknown device event %s ignored", name)
            return
        clean = normalize_event_data(data)
        try:
            self._on_device_event(name, clean)
        except Exception:  # noqa: BLE001 - status callbacks are best effort
            _LOGGER.exception("Device event state callback failed")
        if name == "tts_end":
            self._speaking = True
            self._last_tts_at = time.monotonic()
        client = self._client
        if client is None or not self._connected:
            return
        enum_name = EVENT_ENUM_NAMES.get(name)
        event_type = getattr(VoiceAssistantEventType, enum_name, None) if enum_name else None
        if event_type is None:
            _LOGGER.warning("No VoiceAssistantEventType for %s", name)
            return
        try:
            client.send_voice_assistant_event(event_type, clean or None)
        except (APIConnectionError, OSError) as err:
            _LOGGER.warning("Sending device event %s failed: %s", name, err)
        except Exception:  # noqa: BLE001 - one lost event must not abort the run
            _LOGGER.exception("Sending device event %s failed", name)

    def _device_descriptor(self) -> DeviceDescriptor:
        info = self._device_info
        name = self.device_name or "pulsar"
        mac = info.mac_address if info is not None else ""
        firmware = self.firmware
        return DeviceDescriptor(name=name, mac=mac, firmware=firmware)
