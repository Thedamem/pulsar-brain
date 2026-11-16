"""Pulsar Brain bridge integration.

Transport only: the addon owns the brain (STT/LLM/TTS/tools), this integration owns
the ESPHome voice-assistant slot and publishes the synthesized WAV for the speaker.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
import logging

import aiohttp

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_create_clientsession
from homeassistant.helpers.network import get_url

from .bridge import AddonClient, AddonError, BridgeClient
from .const import (
    BRIDGE_CONNECT_TIMEOUT,
    BRIDGE_READ_TIMEOUT,
    CONF_ADDON_HOST,
    CONF_ADDON_PORT,
    CONF_BRIDGE_TOKEN,
    CONF_DEVICE_HOST,
    CONF_DEVICE_NAME,
    CONF_DEVICE_PORT,
    CONF_ENABLED,
    CONF_NOISE_PSK,
    CONF_TTS_BASE_URL,
    DEFAULT_ADDON_PORT,
    DEFAULT_DEVICE_PORT,
    DEFAULT_ENABLED,
    DOMAIN,
    KEEPALIVE_INTERVAL,
    PLATFORMS,
    STATUS_REFRESH_INTERVAL,
)
from .esphome_client import EsphomeVoiceClient
from .services import async_setup_services, async_unregister_services
from .tts_store import TtsStore
from .tts_view import PulsarBrainTtsView

_LOGGER = logging.getLogger(__name__)

PLATFORM_ENUM = [Platform(platform) for platform in PLATFORMS]


@dataclass
class PulsarBrainData:
    """Domain-wide singletons shared by config entry reloads."""

    tts_store: TtsStore | None = None
    tts_view: PulsarBrainTtsView | None = None
    runtime: BridgeRuntime | None = None


@dataclass
class _Callbacks:
    listeners: set[Callable[[], None]] = field(default_factory=set)


class BridgeRuntime:
    """One config entry: addon HTTP/WS client, ESPHome client and entity state."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: PulsarBrainConfigEntry,
        tts_store: TtsStore,
    ) -> None:
        self.hass = hass
        self.entry = entry
        self.tts_store = tts_store
        data = {**entry.data, **entry.options}
        self._session = async_create_clientsession(
            hass,
            timeout=aiohttp.ClientTimeout(
                total=None,
                connect=BRIDGE_CONNECT_TIMEOUT,
                sock_read=BRIDGE_READ_TIMEOUT,
            ),
        )
        self.bridge = BridgeClient(
            self._session,
            str(data[CONF_ADDON_HOST]),
            int(data.get(CONF_ADDON_PORT, DEFAULT_ADDON_PORT)),
            str(data[CONF_BRIDGE_TOKEN]),
            keepalive_interval=KEEPALIVE_INTERVAL,
            connect_timeout=BRIDGE_CONNECT_TIMEOUT,
        )
        self.esphome = EsphomeVoiceClient(
            hass,
            host=str(data[CONF_DEVICE_HOST]),
            port=int(data.get(CONF_DEVICE_PORT, DEFAULT_DEVICE_PORT)),
            noise_psk=str(data.get(CONF_NOISE_PSK) or ""),
            device_name=str(data.get(CONF_DEVICE_NAME) or data[CONF_DEVICE_HOST]),
            bridge=self.bridge,
            tts_store=tts_store,
            get_tts_base_url=self._get_tts_base_url,
            on_device_event=self._handle_device_event,
            on_run_started=self._handle_run_started,
            on_run_finished=self._handle_run_finished,
            on_connection_change=self._handle_connection_change,
        )
        self.enabled = bool(data.get(CONF_ENABLED, DEFAULT_ENABLED))

        self.last_transcript: str = ""
        self.last_response: str = ""
        self.last_provider: str | None = None
        self.providers: list[dict[str, str]] = []
        self.addon_connected = False
        self.last_error: str | None = None
        self.last_run_id: str | None = None

        self._callbacks = _Callbacks()
        self._refresh_task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._lifecycle_lock = asyncio.Lock()

    # ───────────────────────────────────────────────────────────── lifecycle ──

    async def async_start(self) -> None:
        """Start device connection and the addon status refresh loop."""
        async with self._lifecycle_lock:
            self._stop_event.clear()
            self.tts_store.set_enabled(True)
            if self.enabled:
                await self.esphome.async_start()
            try:
                async with asyncio.timeout(5):
                    await self._async_refresh_addon()
            except TimeoutError:
                _LOGGER.warning("Addon did not answer during setup; continuing")
            self._refresh_task = self.hass.async_create_background_task(
                self._async_refresh_loop(), name=f"{DOMAIN} status refresh"
            )

    async def async_stop(self) -> None:
        """Stop everything owned by this entry."""
        async with self._lifecycle_lock:
            self._stop_event.set()
            task = self._refresh_task
            self._refresh_task = None
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            await self.esphome.async_stop()
            self.addon_connected = False
            self.tts_store.set_enabled(False)
            self._notify()

    async def async_set_enabled(self, enabled: bool) -> None:
        """Apply the master switch without reloading the entry."""
        async with self._lifecycle_lock:
            self.enabled = enabled
            if enabled:
                await self.esphome.async_start()
                await self._async_refresh_addon()
            else:
                await self.esphome.async_stop()
                self.addon_connected = False
            self._notify()

    async def async_restart(self) -> None:
        """Reconnect both sides; used by the restart button."""
        async with self._lifecycle_lock:
            await self.esphome.async_stop()
            if self.enabled:
                await self.esphome.async_start()
            await self._async_refresh_addon()
            self._notify()

    @callback
    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Subscribe to runtime state changes."""
        self._callbacks.listeners.add(listener)

        @callback
        def _remove() -> None:
            self._callbacks.listeners.discard(listener)

        return _remove

    # ─────────────────────────────────────────────────────────── addon state ──

    @property
    def addon(self) -> AddonClient:
        """Addon HTTP client."""
        return self.bridge.addon

    @property
    def device_connected(self) -> bool:
        """ESPHome API/VA subscription state."""
        return self.esphome.connected

    @property
    def active_run(self) -> str | None:
        """Voice run currently in progress, if any."""
        return self.esphome.active_run_id

    async def async_release_voice_slot(self) -> bool:
        """Temporarily hand the voice slot to Home Assistant for an announcement."""
        return await self.esphome.async_release_voice_slot()

    async def async_claim_voice_slot(self) -> None:
        """Reclaim the voice slot after an announcement."""
        await self.esphome.async_claim_voice_slot()

    @property
    def connected(self) -> bool:
        """True when both the addon and the speaker are reachable."""
        return self.addon_connected and self.esphome.connected

    @property
    def device_name(self) -> str:
        """Speaker name."""
        return self.esphome.device_name

    @property
    def firmware(self) -> str:
        """Speaker firmware/project version."""
        return self.esphome.firmware

    async def async_load_providers(self) -> None:
        """Refresh the provider list for the select entity."""
        try:
            providers = await self.addon.async_providers()
        except AddonError as err:
            _LOGGER.debug("Could not load addon providers: %s", err)
            return
        if providers != self.providers:
            self.providers = providers
            self._notify()

    async def async_select_provider(self, provider_id: str) -> None:
        """Ask the addon to switch provider."""
        payload = await self.addon.async_set_provider(provider_id)
        selected = self.addon.provider_id_from_config(payload) or provider_id
        self.last_provider = selected
        self._notify()

    async def async_test_text(self, text: str) -> dict[str, object]:
        """Run text through the addon brain (pulsar_brain.ask)."""
        return await self.addon.async_test_text(text)

    async def _async_refresh_addon(self) -> None:
        try:
            health = await self.addon.async_health()
            if health.get("status") != "ok":
                raise AddonError("unhealthy", "Addon health check did not report ok")
            config = await self.addon.async_config()
        except AddonError as err:
            if self.addon_connected:
                _LOGGER.warning("Addon became unavailable: %s", err)
            else:
                _LOGGER.debug("Addon is unavailable: %s", err)
            self.addon_connected = False
            self.last_error = err.code
            self._notify()
            return
        self.addon_connected = True
        provider = self.addon.provider_id_from_config(config)
        if provider and provider != self.last_provider:
            self.last_provider = provider
        self._notify()

    async def _async_refresh_loop(self) -> None:
        try:
            while not self._stop_event.is_set():
                try:
                    await asyncio.wait_for(
                        self._stop_event.wait(), timeout=STATUS_REFRESH_INTERVAL
                    )
                except TimeoutError:
                    pass
                if self._stop_event.is_set():
                    return
                await self._async_refresh_addon()
        except asyncio.CancelledError:
            raise

    # ────────────────────────────────────────────────────────────── callbacks ──

    def _get_tts_base_url(self) -> str:
        override = str(self.entry.options.get(CONF_TTS_BASE_URL) or "").strip()
        if override:
            return override.rstrip("/")
        return get_url(self.hass, prefer_external=False).rstrip("/")

    def _handle_device_event(self, event: str, data: dict[str, str]) -> None:
        changed = False
        if event == "stt_end":
            text = data.get("text", "")
            if text:
                self.last_transcript = text
                changed = True
        elif event == "intent_end":
            speech = data.get("speech", "")
            if speech:
                self.last_response = speech
                changed = True
        elif event == "tts_start":
            text = data.get("text", "")
            if text and not self.last_response:
                self.last_response = text
                changed = True
        elif event == "error":
            code = data.get("code")
            if code:
                self.last_error = code
                changed = True
        if changed:
            self._notify()

    def _handle_run_started(self, run_id: str) -> None:
        self.last_run_id = run_id
        self.last_error = None
        self._notify()

    def _handle_run_finished(self, run_id: str, reason: str) -> None:
        if self.last_run_id == run_id:
            self.last_run_id = None
            if reason in ("error", "timeout"):
                self.last_error = reason
        self._notify()

    def _handle_connection_change(self, connected: bool) -> None:
        _LOGGER.debug("ESPHome connection state: %s", connected)
        self._notify()

    @callback
    def _notify(self) -> None:
        for listener in list(self._callbacks.listeners):
            try:
                listener()
            except Exception:  # noqa: BLE001 - one entity must not break the rest
                _LOGGER.exception("Runtime listener failed")


async def async_setup_entry(hass: HomeAssistant, entry: PulsarBrainConfigEntry) -> bool:
    """Set up one bridge entry."""
    domain_data: PulsarBrainData = hass.data.get(DOMAIN) or PulsarBrainData()
    hass.data[DOMAIN] = domain_data

    token = str(entry.data[CONF_BRIDGE_TOKEN])
    store = TtsStore(token)
    if domain_data.tts_view is None:
        view = PulsarBrainTtsView(store)
        hass.http.register_view(view)
        domain_data.tts_view = view
    else:
        domain_data.tts_view.set_store(store)
    domain_data.tts_store = store

    runtime = BridgeRuntime(hass, entry, store)
    domain_data.runtime = runtime
    entry.runtime_data = runtime

    await runtime.async_start()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORM_ENUM)
    await async_setup_services(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: PulsarBrainConfigEntry) -> bool:
    """Unload one bridge entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORM_ENUM)
    if not unload_ok:
        return False
    runtime: BridgeRuntime | None = getattr(entry, "runtime_data", None)
    if runtime is not None:
        await runtime.async_stop()
    domain_data: PulsarBrainData | None = hass.data.get(DOMAIN)
    if domain_data is not None and domain_data.tts_store is not None:
        domain_data.tts_store.set_enabled(False)
    await async_unregister_services(hass)
    return True


type PulsarBrainConfigEntry = ConfigEntry[BridgeRuntime]
