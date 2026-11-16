"""Fake Home Assistant REST API for the pulsar-brain addon e2e scenarios.

It implements only the endpoints the addon uses (docs/contracts.md §2, addon/src/ha):
states, services, service calls, config and areas. Every service call is recorded
with its target entity ids, and light/switch/media_player states change as they
would in real Home Assistant, so follow-up turns see the expected state.

The server also exposes /__test/calls, /__test/reset, /__test/states and
/__test/requests for manual debugging; the scenario code reads the in-process
object directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from aiohttp import web

from harness import DEFAULT_HA_TOKEN, free_port

SUPPORTED_SERVICES: dict[str, tuple[str, ...]] = {
    "light": ("turn_on", "turn_off", "toggle"),
    "switch": ("turn_on", "turn_off", "toggle"),
    "media_player": (
        "turn_on",
        "turn_off",
        "volume_set",
        "volume_up",
        "volume_down",
        "media_play",
        "media_pause",
        "media_stop",
        "play_media",
    ),
    "scene": ("turn_on",),
    "automation": ("turn_on", "turn_off", "trigger"),
    "script": ("turn_on", "turn_off"),
    "assist_satellite": ("announce",),
    "homeassistant": ("turn_on", "turn_off"),
}


def _iso_now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def _initial_entities() -> dict[str, dict[str, Any]]:
    stamp = _iso_now()
    return {
        "light.kitchen": {
            "entity_id": "light.kitchen",
            "state": "off",
            "attributes": {
                "friendly_name": "Свет на кухне",
                "supported_color_modes": ["brightness"],
                "supported_features": 0,
            },
            "last_changed": stamp,
        },
        "switch.tv": {
            "entity_id": "switch.tv",
            "state": "off",
            "attributes": {"friendly_name": "Телевизор", "icon": "mdi:television"},
            "last_changed": stamp,
        },
        "media_player.speaker": {
            "entity_id": "media_player.speaker",
            "state": "off",
            "attributes": {
                "friendly_name": "Колонка",
                "volume_level": 0.3,
                "supported_features": 0,
            },
            "last_changed": stamp,
        },
        "scene.movie": {
            "entity_id": "scene.movie",
            "state": "unknown",
            "attributes": {"friendly_name": "Кино"},
            "last_changed": stamp,
        },
    }


@dataclass
class ServiceCall:
    domain: str
    service: str
    data: dict[str, Any]
    entity_ids: list[str]
    at_iso: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "service": self.service,
            "entityIds": list(self.entity_ids),
            "data": self.data,
            "at": self.at_iso,
        }

    def summary(self) -> str:
        targets = ", ".join(self.entity_ids) if self.entity_ids else "(без entity_id)"
        return f"{self.domain}.{self.service} → {targets}"


class FakeHa:
    def __init__(self, token: str = DEFAULT_HA_TOKEN) -> None:
        self.token = token
        self.port = 0
        self.calls: list[ServiceCall] = []
        self.requests: list[dict[str, Any]] = []
        self.states: dict[str, dict[str, Any]] = {}
        self._runner: web.AppRunner | None = None
        self._reset_state()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _reset_state(self) -> None:
        self.states = _initial_entities()

    def reset(self) -> None:
        self.calls.clear()
        self.requests.clear()
        self._reset_state()

    async def start(self) -> str:
        self.port = free_port()
        app = web.Application(middlewares=[self._middleware])
        app.router.add_get("/api/", self._api_root)
        app.router.add_get("/api/config", self._api_config)
        app.router.add_get("/api/states", self._api_states)
        app.router.add_get("/api/states/{entity_id}", self._api_state)
        app.router.add_get("/api/services", self._api_services)
        app.router.add_post("/api/services/{domain}/{service}", self._api_call_service)
        app.router.add_get("/api/areas", self._api_areas)
        app.router.add_get("/__test/calls", self._test_calls)
        app.router.add_post("/__test/reset", self._test_reset)
        app.router.add_get("/__test/states", self._test_states)
        app.router.add_get("/__test/requests", self._test_requests)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", self.port)
        await site.start()
        return self.base_url

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    # ─────────────────────────────────────────────────────────── middleware ──

    @web.middleware
    async def _middleware(
        self, request: web.Request, handler: Any
    ) -> web.StreamResponse:
        if request.path.startswith("/api/") and not self._authorized(request):
            return web.json_response({"message": "Unauthorized"}, status=401)
        response = await handler(request)
        self.requests.append(
            {"method": request.method, "path": request.path, "status": response.status, "at": _iso_now()}
        )
        if len(self.requests) > 500:
            del self.requests[:100]
        return response

    def _authorized(self, request: web.Request) -> bool:
        return request.headers.get("Authorization", "") == f"Bearer {self.token}"

    # ────────────────────────────────────────────────────────────── api ──

    async def _api_root(self, _request: web.Request) -> web.Response:
        return web.json_response({"message": "API running."})

    async def _api_config(self, _request: web.Request) -> web.Response:
        return web.json_response(
            {
                "location_name": "Pulsar Dev",
                "time_zone": "Europe/Moscow",
                "version": "2026.11.0",
                "unit_system": {"temperature": "°C"},
            }
        )

    async def _api_states(self, _request: web.Request) -> web.Response:
        return web.json_response(list(self.states.values()))

    async def _api_state(self, request: web.Request) -> web.Response:
        entity_id = request.match_info["entity_id"]
        state = self.states.get(entity_id)
        if state is None:
            return web.json_response({"message": "Entity not found."}, status=404)
        return web.json_response(state)

    async def _api_services(self, _request: web.Request) -> web.Response:
        return web.json_response(
            [
                {"domain": domain, "services": {name: {} for name in names}}
                for domain, names in SUPPORTED_SERVICES.items()
            ]
        )

    async def _api_areas(self, _request: web.Request) -> web.Response:
        return web.json_response([])

    async def _api_call_service(self, request: web.Request) -> web.Response:
        domain = request.match_info["domain"]
        service = request.match_info["service"]
        try:
            raw = await request.json()
        except ValueError:
            raw = {}
        data: dict[str, Any] = raw if isinstance(raw, dict) else {}
        entity_ids = _entity_ids(data)
        self.calls.append(
            ServiceCall(
                domain=domain,
                service=service,
                data=data,
                entity_ids=entity_ids,
                at_iso=_iso_now(),
            )
        )
        changed = self._apply_service(domain, service, data, entity_ids)
        return web.json_response(changed)

    # ──────────────────────────────────────────────────────────── /__test ──

    async def _test_calls(self, _request: web.Request) -> web.Response:
        return web.json_response({"calls": [call.as_dict() for call in self.calls]})

    async def _test_reset(self, _request: web.Request) -> web.Response:
        self.reset()
        return web.json_response({"ok": True})

    async def _test_states(self, _request: web.Request) -> web.Response:
        return web.json_response({"states": list(self.states.values())})

    async def _test_requests(self, _request: web.Request) -> web.Response:
        return web.json_response({"requests": self.requests[-100:]})

    # ───────────────────────────────────────────────────────────- helpers ──

    def _apply_service(
        self,
        domain: str,
        service: str,
        data: dict[str, Any],
        entity_ids: list[str],
    ) -> list[dict[str, Any]]:
        changed: list[dict[str, Any]] = []
        for entity_id in entity_ids:
            state = self.states.get(entity_id)
            if state is None:
                continue
            new_state = state["state"]
            attributes = dict(state["attributes"])

            if domain in ("light", "switch") and service in ("turn_on", "turn_off", "toggle"):
                if service == "turn_on":
                    new_state = "on"
                elif service == "turn_off":
                    new_state = "off"
                else:
                    new_state = "off" if state["state"] == "on" else "on"
                if isinstance(data.get("brightness"), (int, float)):
                    attributes["brightness"] = data["brightness"]
            elif domain == "homeassistant" and service in ("turn_on", "turn_off"):
                if state["entity_id"].split(".", 1)[0] in ("light", "switch"):
                    new_state = "on" if service == "turn_on" else "off"
            elif domain == "media_player":
                if service == "turn_on":
                    new_state = "on"
                elif service == "turn_off":
                    new_state = "off"
                elif service == "media_play":
                    new_state = "playing"
                elif service == "media_pause":
                    new_state = "paused"
                elif service == "media_stop":
                    new_state = "idle"
                elif service == "volume_set":
                    level = data.get("volume_level")
                    if isinstance(level, (int, float)):
                        attributes["volume_level"] = max(0.0, min(1.0, float(level)))
                elif service in ("volume_up", "volume_down"):
                    level = attributes.get("volume_level", 0.3)
                    if isinstance(level, (int, float)):
                        delta = 0.05 if service == "volume_up" else -0.05
                        attributes["volume_level"] = max(0.0, min(1.0, float(level) + delta))
            elif domain in ("scene", "script", "automation", "assist_satellite"):
                continue
            else:
                continue

            if new_state != state["state"] or attributes != state["attributes"]:
                state = {
                    "entity_id": entity_id,
                    "state": new_state,
                    "attributes": attributes,
                    "last_changed": _iso_now(),
                }
                self.states[entity_id] = state
            changed.append(dict(state))
        return changed

    def calls_for(self, domain: str, service: str | None = None) -> list[ServiceCall]:
        return [
            call
            for call in self.calls
            if call.domain == domain and (service is None or call.service == service)
        ]

    def called(self, domain: str, service: str, entity_id: str | None = None) -> bool:
        for call in self.calls_for(domain, service):
            if entity_id is None or entity_id in call.entity_ids:
                return True
        return False

    def call_summaries(self) -> list[str]:
        return [call.summary() for call in self.calls]


def _entity_ids(data: dict[str, Any]) -> list[str]:
    raw = data.get("entity_id")
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, str)]
    target = data.get("target")
    if isinstance(target, dict):
        target_raw = target.get("entity_id")
        if isinstance(target_raw, str):
            return [target_raw]
        if isinstance(target_raw, list):
            return [item for item in target_raw if isinstance(item, str)]
    return []
