"""In-process mock of the pulsar_brain addon: HTTP API plus the bridge WebSocket."""

from __future__ import annotations

import asyncio
import json
import socket
from typing import Any

from aiohttp import web

BRIDGE_PATH = "/api/bridge/ws"


class MockAddonServer:
    """Minimal addon that records the bridge protocol and can script responses."""

    def __init__(self, token: str = "test-token") -> None:
        self.token = token
        self.messages: list[dict[str, Any]] = []
        self.binary: list[bytes] = []
        self.auth_headers: list[str | None] = []
        self.http_paths: list[str] = []
        self.config_updates: list[dict[str, Any]] = []
        self.test_text_requests: list[dict[str, Any]] = []
        self.provider_id = "mock"
        self.ws: web.WebSocketResponse | None = None
        self.run_start: dict[str, Any] | None = None
        self.run_start_event = asyncio.Event()
        self.connected = asyncio.Event()
        self.disconnected = asyncio.Event()
        self._runner: web.AppRunner | None = None
        self._sock: socket.socket | None = None
        self.port = 0

    @property
    def host(self) -> str:
        return "127.0.0.1"

    @property
    def ws_url(self) -> str:
        return f"ws://{self.host}:{self.port}{BRIDGE_PATH}"

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    async def start(self) -> None:
        app = web.Application()
        app.router.add_get(BRIDGE_PATH, self._ws_handler)
        app.router.add_get("/health", self._health)
        app.router.add_get("/api/status", self._status)
        app.router.add_get("/api/config", self._config)
        app.router.add_put("/api/config", self._put_config)
        app.router.add_get("/api/providers", self._providers)
        app.router.add_post("/api/test/text", self._test_text)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind((self.host, 0))
        self._sock.listen(128)
        self.port = self._sock.getsockname()[1]
        site = web.SockSite(self._runner, self._sock)
        await site.start()

    async def stop(self) -> None:
        if self.ws is not None and not self.ws.closed:
            await self.ws.close()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        if self._sock is not None:
            self._sock.close()
            self._sock = None

    async def send_json(self, payload: dict[str, Any]) -> None:
        if self.ws is None or self.ws.closed:
            raise AssertionError("mock addon WebSocket is not connected")
        await self.ws.send_json(payload)

    async def send_bytes(self, payload: bytes) -> None:
        if self.ws is None or self.ws.closed:
            raise AssertionError("mock addon WebSocket is not connected")
        await self.ws.send_bytes(payload)

    async def wait_run_start(self, timeout: float = 2.0) -> dict[str, Any]:
        await asyncio.wait_for(self.run_start_event.wait(), timeout)
        assert self.run_start is not None
        return self.run_start

    async def wait_message(
        self,
        predicate,
        *,
        timeout: float = 2.0,
        start: int = 0,
    ) -> dict[str, Any]:
        async def _wait() -> dict[str, Any]:
            while True:
                for message in self.messages[start:]:
                    if predicate(message):
                        return message
                await asyncio.sleep(0.01)

        return await asyncio.wait_for(_wait(), timeout)

    async def wait_binary(self, count: int = 1, *, timeout: float = 2.0) -> list[bytes]:
        async def _wait() -> list[bytes]:
            while len(self.binary) < count:
                await asyncio.sleep(0.01)
            return self.binary

        return await asyncio.wait_for(_wait(), timeout)

    async def wait_disconnected(self, timeout: float = 2.0) -> None:
        await asyncio.wait_for(self.disconnected.wait(), timeout)

    # ────────────────────────────────────────────────────────────── handlers ──

    async def _ws_handler(self, request: web.Request) -> web.StreamResponse:
        self.auth_headers.append(request.headers.get("Authorization"))
        if request.headers.get("Authorization") != f"Bearer {self.token}":
            return web.json_response(
                {"error": {"code": "unauthorized", "message": "bad token"}},
                status=401,
            )
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.ws = ws
        self.connected.set()
        try:
            async for message in ws:
                if message.type is web.WSMsgType.TEXT:
                    parsed = json.loads(message.data)
                    self.messages.append(parsed)
                    if parsed.get("type") == "run.start":
                        self.run_start = parsed
                        self.run_start_event.set()
                elif message.type is web.WSMsgType.BINARY:
                    self.binary.append(message.data)
                elif message.type in (web.WSMsgType.CLOSE, web.WSMsgType.ERROR):
                    break
        finally:
            self.disconnected.set()
        return ws

    def _authorized(self, request: web.Request) -> bool:
        return request.headers.get("Authorization") == f"Bearer {self.token}"

    def _unauthorized(self) -> web.Response:
        return web.json_response(
            {"error": {"code": "unauthorized", "message": "bad token"}},
            status=401,
        )

    async def _health(self, request: web.Request) -> web.Response:
        self.http_paths.append(request.path)
        return web.json_response({"status": "ok", "version": "test", "uptimeSec": 1})

    async def _status(self, request: web.Request) -> web.Response:
        self.http_paths.append(request.path)
        if not self._authorized(request):
            return self._unauthorized()
        return web.json_response(
            {
                "version": "test",
                "uptimeSec": 1,
                "bridge": {"connected": True, "lastRunAt": None},
                "activeRuns": [],
                "health": {},
                "scheduler": {"active": 0, "nextAt": None},
                "configWarnings": [],
            }
        )

    async def _config(self, request: web.Request) -> web.Response:
        self.http_paths.append(request.path)
        if not self._authorized(request):
            return self._unauthorized()
        return web.json_response(
            {
                "config": {"version": 1, "provider": {"id": self.provider_id}},
                "warnings": [],
                "bridgeToken": self.token,
            }
        )

    async def _put_config(self, request: web.Request) -> web.Response:
        self.http_paths.append(request.path)
        if not self._authorized(request):
            return self._unauthorized()
        payload = await request.json()
        self.config_updates.append(payload)
        provider = payload.get("provider")
        if isinstance(provider, dict) and isinstance(provider.get("id"), str):
            self.provider_id = provider["id"]
        return web.json_response(
            {
                "config": {"version": 1, "provider": {"id": self.provider_id}},
                "warnings": [],
                "bridgeToken": self.token,
            }
        )

    async def _providers(self, request: web.Request) -> web.Response:
        self.http_paths.append(request.path)
        if not self._authorized(request):
            return self._unauthorized()
        return web.json_response(
            {
                "providers": [
                    {"id": "mock", "label": "Mock", "capabilities": {}},
                    {"id": "openai", "label": "OpenAI", "capabilities": {}},
                ]
            }
        )

    async def _test_text(self, request: web.Request) -> web.Response:
        self.http_paths.append(request.path)
        if not self._authorized(request):
            return self._unauthorized()
        payload = await request.json()
        self.test_text_requests.append(payload)
        return web.json_response(
            {
                "transcript": payload.get("text", ""),
                "text": "Ответ на запрос",
                "speech": "Ответ на запрос",
                "toolTraces": [{"name": "ha.call_service", "ok": True}],
                "timings": {"llmMs": 1, "totalMs": 2},
                "provider": "mock",
            }
        )
