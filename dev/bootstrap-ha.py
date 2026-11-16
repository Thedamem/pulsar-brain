#!/usr/bin/env python3
"""Bootstrap the dev Home Assistant: onboarding, dev user, long-lived token.

The stand has no Supervisor, so the addon needs a normal HA API token plus the
URL of the HA container. This script finishes HA onboarding, creates the dev
user (DEV_HA_USER/DEV_HA_PASS) and stores a long-lived access token in
dev/ha-token.txt, dev/state.json and dev/.env (all gitignored).

Idempotent: a stored token that still authenticates is reused, nothing is
recreated. Run it after `docker compose up -d ha`:

    dev/.venv/bin/python dev/bootstrap-ha.py

Endpoints used (verified against Home Assistant core sources):
  GET  /api/onboarding                 progress of the onboarding steps
  POST /api/onboarding/users           create the first user, returns auth_code (no auth)
  POST /auth/token                     exchange auth_code for access/refresh tokens (form data)
  POST /api/onboarding/core_config     requires Bearer
  POST /api/onboarding/integration     requires Bearer, needs a refresh-token session
  POST /api/onboarding/analytics       requires Bearer
  POST /auth/login_flow[/{flow_id}]    login for an already existing user
  WS   /api/websocket                  auth/long_lived_access_token command
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp

DEV_DIR = Path(__file__).resolve().parent
HA_URL = os.environ.get("DEV_HA_URL", "http://127.0.0.1:8124").rstrip("/")
HA_USER = os.environ.get("DEV_HA_USER", "dev")
HA_PASS = os.environ.get("DEV_HA_PASS", "devpass")
WAIT_SECONDS = int(os.environ.get("DEV_HA_WAIT", "180"))
TOKEN_FILE = DEV_DIR / "ha-token.txt"
STATE_FILE = DEV_DIR / "state.json"
ENV_FILE = DEV_DIR / ".env"

# Test devices provided by dev/ha-config/configuration.yaml.
EXPECTED_ENTITIES = ("light.kitchen", "switch.tv", "media_player.speaker")

ONBOARDING_STEPS = ("user", "core_config", "integration", "analytics")
ONBOARDING_ENDPOINTS = {
    "core_config": "/api/onboarding/core_config",
    "integration": "/api/onboarding/integration",
    "analytics": "/api/onboarding/analytics",
}


class BootstrapError(RuntimeError):
    """Fatal bootstrap problem with a message meant for the developer."""


def log(message: str) -> None:
    print(f"[bootstrap-ha] {message}", flush=True)


async def request(
    session: aiohttp.ClientSession,
    method: str,
    path: str,
    *,
    token: str | None = None,
    json_body: Any = None,
    form_body: dict[str, str] | None = None,
    expect: tuple[int, ...] = (200,),
    timeout: float = 15.0,
) -> tuple[int, Any]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    url = f"{HA_URL}{path}"
    async with session.request(
        method,
        url,
        json=json_body,
        data=form_body,
        headers=headers,
        timeout=aiohttp.ClientTimeout(total=timeout),
    ) as response:
        raw = await response.text()
        try:
            payload: Any = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = raw
        if response.status not in expect:
            raise BootstrapError(
                f"{method} {path} → HTTP {response.status}: {str(payload)[:400]}"
            )
        return response.status, payload


async def wait_until_ready(session: aiohttp.ClientSession) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        try:
            status, _ = await request(session, "GET", "/api/onboarding", timeout=5)
            if status == 200:
                log(f"Home Assistant отвечает на {HA_URL}")
                return
        except (aiohttp.ClientError, asyncio.TimeoutError, BootstrapError) as err:
            if attempt % 5 == 1:
                log(f"жду HA ({err.__class__.__name__})…")
        await asyncio.sleep(2)
    raise BootstrapError(
        f"HA не поднялся по {HA_URL} за {WAIT_SECONDS} с; проверь `docker compose logs ha`"
    )


async def get_progress(session: aiohttp.ClientSession) -> dict[str, bool]:
    _, payload = await request(session, "GET", "/api/onboarding")
    if not isinstance(payload, list):
        raise BootstrapError(f"неожиданный ответ /api/onboarding: {payload!r}")
    return {str(item.get("step")): bool(item.get("done")) for item in payload}


async def token_is_valid(session: aiohttp.ClientSession, token: str) -> bool:
    try:
        status, payload = await request(session, "GET", "/api/", token=token, timeout=10)
    except (aiohttp.ClientError, asyncio.TimeoutError, BootstrapError):
        return False
    return status == 200 and isinstance(payload, dict) and payload.get("message") == "API running."


async def exchange_auth_code(
    session: aiohttp.ClientSession, auth_code: str
) -> str:
    _, payload = await request(
        session,
        "POST",
        "/auth/token",
        form_body={
            "grant_type": "authorization_code",
            "code": auth_code,
            "client_id": HA_URL,
        },
    )
    access_token = payload.get("access_token") if isinstance(payload, dict) else None
    if not access_token:
        raise BootstrapError(f"/auth/token не вернул access_token: {payload!r}")
    return str(access_token)


async def create_onboarding_user(session: aiohttp.ClientSession) -> str:
    _, payload = await request(
        session,
        "POST",
        "/api/onboarding/users",
        json_body={
            "client_id": HA_URL,
            "name": HA_USER,
            "username": HA_USER,
            "password": HA_PASS,
            "language": "ru",
        },
        expect=(200,),
    )
    auth_code = payload.get("auth_code") if isinstance(payload, dict) else None
    if not auth_code:
        raise BootstrapError(f"/api/onboarding/users не вернул auth_code: {payload!r}")
    log(f"создан пользователь HA {HA_USER!r}")
    return str(auth_code)


async def login_existing_user(session: aiohttp.ClientSession) -> str:
    _, flow = await request(
        session,
        "POST",
        "/auth/login_flow",
        json_body={
            "client_id": HA_URL,
            "handler": ["homeassistant", None],
            "redirect_uri": f"{HA_URL}/",
        },
    )
    flow_id = flow.get("flow_id") if isinstance(flow, dict) else None
    if not flow_id:
        raise BootstrapError(f"/auth/login_flow не вернул flow_id: {flow!r}")

    _, result = await request(
        session,
        "POST",
        f"/auth/login_flow/{flow_id}",
        json_body={
            "client_id": HA_URL,
            "username": HA_USER,
            "password": HA_PASS,
        },
    )
    if not isinstance(result, dict) or result.get("type") != "create_entry":
        errors = result.get("errors") if isinstance(result, dict) else result
        raise BootstrapError(
            f"не удалось залогиниться пользователем {HA_USER!r}: {errors!r}. "
            "Если пароль другой — удали dev/ha-config и подними стенд заново"
        )
    auth_code = result.get("result")
    if not auth_code:
        raise BootstrapError(f"login flow не вернул auth_code: {result!r}")
    log(f"залогинен существующий пользователь {HA_USER!r}")
    return str(auth_code)


async def finish_onboarding_step(
    session: aiohttp.ClientSession, step: str, access_token: str
) -> None:
    path = ONBOARDING_ENDPOINTS[step]
    body: dict[str, str] = {}
    if step == "integration":
        body = {"client_id": HA_URL, "redirect_uri": f"{HA_URL}/"}
    try:
        await request(session, "POST", path, token=access_token, json_body=body)
    except BootstrapError as err:
        # The step can be completed concurrently by the HA frontend; that is fine.
        if "HTTP 403" not in str(err):
            raise
    log(f"onboarding: шаг {step} завершён")


async def create_long_lived_token(session: aiohttp.ClientSession, access_token: str) -> str:
    async with session.ws_connect(
        f"{HA_URL}/api/websocket", timeout=aiohttp.ClientWSTimeout(ws_close=10)
    ) as ws:
        hello = await ws.receive_json()
        if hello.get("type") != "auth_required":
            raise BootstrapError(f"неожиданное приветствие websocket: {hello!r}")
        await ws.send_json({"type": "auth", "access_token": access_token})
        auth_result = await ws.receive_json()
        if auth_result.get("type") != "auth_ok":
            raise BootstrapError(f"websocket auth отклонён: {auth_result!r}")
        await ws.send_json(
            {
                "id": 1,
                "type": "auth/long_lived_access_token",
                "client_name": "pulsar-brain dev stand",
                "lifespan": 365,
            }
        )
        while True:
            message = await ws.receive_json()
            if message.get("id") != 1:
                continue
            if not message.get("success"):
                raise BootstrapError(f"не удалось создать long-lived token: {message!r}")
            token = message.get("result")
            if not isinstance(token, str) or not token:
                raise BootstrapError(f"пустой long-lived token: {message!r}")
            return token


async def check_test_entities(session: aiohttp.ClientSession, token: str) -> None:
    await asyncio.sleep(1)
    try:
        _, states = await request(session, "GET", "/api/states", token=token)
    except (aiohttp.ClientError, asyncio.TimeoutError, BootstrapError) as err:
        log(f"не удалось прочитать /api/states: {err}")
        return
    if not isinstance(states, list):
        log("неожиданный ответ /api/states — тестовые сущности не проверены")
        return
    present = {str(item.get("entity_id")) for item in states}
    missing = [entity for entity in EXPECTED_ENTITIES if entity not in present]
    if missing:
        log(
            "ВНИМАНИЕ: нет тестовых сущностей "
            + ", ".join(missing)
            + "; проверь dev/ha-config/configuration.yaml и `docker compose logs ha`"
        )
    else:
        log("тестовые сущности на месте: " + ", ".join(EXPECTED_ENTITIES))


def write_secrets(token: str) -> None:
    TOKEN_FILE.write_text(token + "\n", encoding="utf-8")
    TOKEN_FILE.chmod(0o600)

    state = {
        "ha_url": HA_URL,
        "username": HA_USER,
        "token": token,
        "token_type": "long_lived_access_token",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    STATE_FILE.chmod(0o600)

    ENV_FILE.write_text(
        "# Generated by dev/bootstrap-ha.py; gitignored, contains the HA dev token.\n"
        f"PULSAR_BRAIN_HA_URL={HA_URL}\n"
        f"PULSAR_BRAIN_HA_TOKEN={token}\n",
        encoding="utf-8",
    )
    ENV_FILE.chmod(0o600)


def print_exports(token: str) -> None:
    print()
    print("Готово. Для запуска аддона вне compose:")
    print(f'export PULSAR_BRAIN_HA_URL="{HA_URL}"')
    print(f'export PULSAR_BRAIN_HA_TOKEN="{token}"')
    print()
    print("Токен также записан в dev/ha-token.txt и dev/.env (compose подхватит его сам).")


async def run() -> None:
    async with aiohttp.ClientSession() as session:
        await wait_until_ready(session)
        progress = await get_progress(session)
        log("onboarding: " + ", ".join(f"{step}={'done' if done else 'pending'}" for step, done in progress.items()))

        access_token: str | None = None
        stored = TOKEN_FILE.read_text(encoding="utf-8").strip() if TOKEN_FILE.exists() else ""
        if stored and await token_is_valid(session, stored):
            access_token = stored
            log("сохранённый токен действителен, пересоздавать не нужно")
        elif stored:
            log("сохранённый токен не работает, выпускаю новый")

        if not progress.get("user", False):
            auth_code = await create_onboarding_user(session)
            access_token = await exchange_auth_code(session, auth_code)
        elif access_token is None:
            auth_code = await login_existing_user(session)
            access_token = await exchange_auth_code(session, auth_code)

        if access_token is None:
            raise BootstrapError("не удалось получить access token")

        for step in ONBOARDING_STEPS:
            if step != "user" and not progress.get(step, False):
                await finish_onboarding_step(session, step, access_token)

        if stored and access_token == stored:
            token = stored
        else:
            token = await create_long_lived_token(session, access_token)
            if not await token_is_valid(session, token):
                raise BootstrapError("только что выпущенный long-lived token не проходит /api/")
            log("выпущен long-lived access token (365 дней)")

        write_secrets(token)
        log("секреты записаны: dev/ha-token.txt, dev/state.json, dev/.env")
        await check_test_entities(session, token)
        print_exports(token)


def main() -> int:
    try:
        asyncio.run(run())
    except BootstrapError as err:
        print(f"[bootstrap-ha] ОШИБКА: {err}", file=sys.stderr)
        return 1
    except aiohttp.ClientError as err:
        print(f"[bootstrap-ha] ОШИБКА сети: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
