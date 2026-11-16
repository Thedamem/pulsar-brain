"""Shared infrastructure for the pulsar-brain addon e2e harness.

The harness runs the addon as a real Node process against a fake Home
Assistant REST API and a real wyoming whisper/piper pair. It never needs a
Home Assistant installation: the Python bridge and ESPHome satellite are out of
scope, the WebSocket client emulates the bridge side of the contract.
"""

from __future__ import annotations

import array
import asyncio
import contextlib
import io
import json
import math
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp

REPO_ROOT = Path(__file__).resolve().parents[2]
ADDON_DIR = REPO_ROOT / "addon"
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"
E2E_DIR = Path(__file__).resolve().parent
LOGS_DIR = E2E_DIR / "logs"
REPORTS_DIR = E2E_DIR / "reports"
ARTIFACTS_DIR = E2E_DIR / "artifacts"

DEFAULT_HA_TOKEN = "dev"
DEFAULT_BRIDGE_TOKEN = "test-token"
DEFAULT_DATA_DIR = Path("/tmp/pb-e2e-data")

PROBE_ROUTES: dict[str, str] = {
    "/api/status": "GET",
    "/api/test/text": "POST",
    "/api/test/audio": "POST",
    "/api/tts/preview": "POST",
    "/api/tts/voices": "GET",
    "/api/schedules": "GET",
    "/api/sessions": "GET",
}
BRIDGE_PATH = "/api/bridge/ws"


class HarnessError(RuntimeError):
    """Infrastructure is not ready; the scenario is skipped, not failed."""


class RouteUnavailable(HarnessError):
    """The addon does not implement a route needed by the scenario."""

    def __init__(self, method: str, url: str, status: int = 404) -> None:
        super().__init__(f"{method} {url}: HTTP {status} — маршрут не реализован")
        self.method = method
        self.url = url
        self.status = status


class ApiError(RuntimeError):
    """The addon answered with an unexpected status or malformed body."""


# ─────────────────────────────────────────────────────────────────── time ──


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def epoch_ms(value: Any) -> float | None:
    """Normalize an epoch value in seconds or milliseconds to milliseconds."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number < 1e12:
        number *= 1000.0
    return number


# ─────────────────────────────────────────────────────────────────- wav ──


@dataclass(frozen=True)
class WavInfo:
    sample_rate: int
    channels: int
    width: int
    frames: int
    duration_sec: float
    rms_dbfs: float

    def summary(self) -> str:
        return (
            f"{self.duration_sec:.2f} с, {self.sample_rate} Гц, "
            f"{self.channels} кан., {self.width * 8} бит, RMS {self.rms_dbfs:.1f} dBFS"
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "sampleRate": self.sample_rate,
            "channels": self.channels,
            "bitsPerSample": self.width * 8,
            "frames": self.frames,
            "durationSec": round(self.duration_sec, 3),
            "rmsDbfs": round(self.rms_dbfs, 2),
        }


def inspect_wav_bytes(data: bytes) -> WavInfo:
    """Parse a 16-bit RIFF/WAVE blob and compute its RMS level."""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("нет заголовка RIFF/WAVE")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav_file:
            channels = wav_file.getnchannels()
            width = wav_file.getsampwidth()
            sample_rate = wav_file.getframerate()
            frames = wav_file.getnframes()
            raw = wav_file.readframes(frames)
    except (wave.Error, EOFError) as err:
        raise ValueError(f"не читается как WAV: {err}") from err
    if width != 2:
        raise ValueError(f"ожидался 16-битный звук, получен {width * 8}-битный")
    if channels <= 0 or sample_rate <= 0:
        raise ValueError("некорректные параметры WAV")

    samples = array.array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % 2)])
    if sys.byteorder != "little":
        samples.byteswap()
    if samples:
        mean_square = sum(value * value for value in samples) / len(samples)
    else:
        mean_square = 0.0
    rms = math.sqrt(mean_square)
    rms_dbfs = 20.0 * math.log10(rms / 32768.0) if rms > 0 else float("-inf")
    duration = frames / sample_rate if sample_rate else 0.0
    return WavInfo(sample_rate, channels, width, frames, duration, rms_dbfs)


def analyze_answer_wav(data: bytes) -> tuple[WavInfo | None, str | None]:
    """Validate the WAV the addon sends for one answer; return (info, problem)."""
    if not data:
        return None, "аддон не прислал ни одного бинарного кадра"
    try:
        info = inspect_wav_bytes(data)
    except ValueError as err:
        return None, str(err)
    problems: list[str] = []
    if info.sample_rate != 16_000:
        problems.append(f"частота {info.sample_rate} Гц вместо 16000")
    if info.channels != 1:
        problems.append(f"{info.channels} канала вместо моно")
    if info.frames <= 0:
        problems.append("нет ни одного сэмпла")
    if info.rms_dbfs <= -55.0:
        problems.append("в WAV тишина")
    return info, ("; ".join(problems) if problems else None)


def read_wav_file(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as err:
        raise HarnessError(f"не читается фикстура {path}: {err}") from err


# ───────────────────────────────────────────────────────────────- network ──


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port


async def tcp_reachable(host: str, port: int, timeout: float = 1.5) -> bool:
    try:
        _reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout
        )
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    with contextlib.suppress(OSError, ConnectionError):
        await writer.wait_closed()
    return True


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


@dataclass(frozen=True)
class RawResponse:
    status: int
    headers: dict[str, str]
    body: bytes

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json_value(self) -> Any:
        try:
            return json.loads(self.body)
        except json.JSONDecodeError as err:
            raise ApiError(
                f"ответ не JSON (HTTP {self.status}): {self.text()[:300]!r}"
            ) from err


async def http_request(
    session: aiohttp.ClientSession,
    method: str,
    url: str,
    *,
    token: str = "",
    json_body: Any | None = None,
    form: aiohttp.FormData | None = None,
    timeout: float = 60.0,
) -> RawResponse:
    kwargs: dict[str, Any] = {
        "headers": auth_headers(token),
        "timeout": aiohttp.ClientTimeout(total=timeout),
    }
    if json_body is not None:
        kwargs["json"] = json_body
    if form is not None:
        kwargs["data"] = form
    try:
        async with session.request(method, url, **kwargs) as response:
            body = await response.read()
            return RawResponse(response.status, dict(response.headers), body)
    except asyncio.TimeoutError as err:
        raise HarnessError(f"HTTP {method} {url}: таймаут {timeout:.0f} с") from err
    except aiohttp.ClientError as err:
        raise HarnessError(f"HTTP {method} {url}: {err}") from err


async def api_json(
    session: aiohttp.ClientSession,
    method: str,
    url: str,
    token: str,
    *,
    json_body: Any | None = None,
    timeout: float = 60.0,
    expected: tuple[int, ...] = (200,),
) -> Any:
    response = await http_request(
        session, method, url, token=token, json_body=json_body, timeout=timeout
    )
    if response.status == 404:
        raise RouteUnavailable(method, url)
    if response.status not in expected:
        raise ApiError(
            f"{method} {url}: HTTP {response.status}: {response.text()[:400]}"
        )
    return response.json_value()


async def probe_routes(
    session: aiohttp.ClientSession, base_url: str, token: str
) -> dict[str, bool]:
    """Check which addon routes exist (404 means the module is not wired yet)."""
    routes: dict[str, bool] = {}
    for path, method in PROBE_ROUTES.items():
        try:
            # Invalid/empty bodies for POST routes are rejected by validation
            # before any side effect, which is exactly what a harmless probe needs.
            response = await http_request(
                session,
                method,
                base_url + path,
                token=token,
                timeout=10.0,
            )
            routes[path] = response.status != 404
        except HarnessError:
            routes[path] = False

    ws_url = base_url.replace("http://", "ws://", 1) + BRIDGE_PATH
    try:
        async with session.ws_connect(
            ws_url, headers=auth_headers(token), max_msg_size=0
        ):
            routes[BRIDGE_PATH] = True
    except aiohttp.WSServerHandshakeError as err:
        routes[BRIDGE_PATH] = err.status != 404
    except aiohttp.ClientError:
        routes[BRIDGE_PATH] = False
    return routes


async def addon_sessions(
    session: aiohttp.ClientSession, base_url: str, token: str, limit: int = 20
) -> list[dict[str, Any]]:
    payload = await api_json(
        session, "GET", f"{base_url}/api/sessions?limit={limit}", token
    )
    if not isinstance(payload, dict) or not isinstance(payload.get("sessions"), list):
        raise ApiError("/api/sessions вернул ответ без массива sessions")
    return [entry for entry in payload["sessions"] if isinstance(entry, dict)]


async def addon_schedules(
    session: aiohttp.ClientSession, base_url: str, token: str
) -> dict[str, Any]:
    payload = await api_json(session, "GET", f"{base_url}/api/schedules", token)
    if not isinstance(payload, dict) or not isinstance(payload.get("entries"), list):
        raise ApiError("/api/schedules вернул ответ без массива entries")
    return payload


# ───────────────────────────────────────────────────────────────- results ──


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "ok": self.ok, "detail": self.detail}


@dataclass
class ScenarioOutcome:
    status: str
    checks: list[Check] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)
    skip_reason: str = ""
    error: str | None = None

    def exit_code(self) -> int:
        if self.status == "passed":
            return 0
        if self.status == "failed":
            return 1
        return 2


def short_detail(value: Any, limit: int = 900) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= limit else text[: limit - 1] + "…"


class Checks:
    """Collects named assertions for one scenario."""

    def __init__(self) -> None:
        self.items: list[Check] = []

    def check(self, name: str, ok: bool, detail: Any = "") -> bool:
        self.items.append(Check(name, bool(ok), short_detail(detail)))
        return bool(ok)

    @property
    def failed(self) -> list[Check]:
        return [item for item in self.items if not item.ok]

    def outcome(self, details: dict[str, Any] | None = None) -> ScenarioOutcome:
        if not self.items:
            raise HarnessError("сценарий не добавил ни одной проверки")
        status = "passed" if not self.failed else "failed"
        return ScenarioOutcome(status=status, checks=list(self.items), details=details or {})


def skipped(reason: str, details: dict[str, Any] | None = None) -> ScenarioOutcome:
    return ScenarioOutcome(
        status="skipped", details=details or {}, skip_reason=reason
    )


def failed(message: str, details: dict[str, Any] | None = None) -> ScenarioOutcome:
    return ScenarioOutcome(
        status="failed", details=details or {}, error=message
    )


# ──────────────────────────────────────────────────────────────- addon ──


@dataclass
class StandOptions:
    addon_url: str | None = None
    force_build: bool = False
    data_dir: Path = DEFAULT_DATA_DIR
    fake_ha_url: str = ""
    stt_host: str = "127.0.0.1"
    stt_port: int = 10300
    tts_host: str = "127.0.0.1"
    tts_port: int = 10200
    bridge_token: str = DEFAULT_BRIDGE_TOKEN
    log_dir: Path = LOGS_DIR
    verbose: bool = False


def _tail(text: str, lines: int = 40) -> str:
    return "\n".join(text.splitlines()[-lines:])


def _newest_source_mtime() -> float:
    newest = 0.0
    for path in (ADDON_DIR / "src").rglob("*.ts"):
        try:
            newest = max(newest, path.stat().st_mtime)
        except OSError:
            continue
    return newest


def _resolve_entry() -> Path | None:
    for candidate in (ADDON_DIR / "dist" / "src" / "index.js", ADDON_DIR / "dist" / "index.js"):
        if candidate.exists():
            return candidate
    return None


def _build_addon() -> tuple[bool, str]:
    npm = shutil.which("npm")
    if npm is None:
        return False, "npm не найден в PATH"
    try:
        completed = subprocess.run(
            [npm, "run", "build"],
            cwd=str(ADDON_DIR),
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return False, "npm run build не завершился за 300 с"
    output = (completed.stdout or "") + (completed.stderr or "")
    return completed.returncode == 0, output


def default_data_dir_guard(path: Path) -> None:
    """Refuse to delete anything except the e2e data directory."""
    resolved = path.expanduser().resolve()
    if not str(resolved).startswith("/tmp/pb-e2e-"):
        raise HarnessError(
            f"отказ очищать {resolved}: ожидается путь вида /tmp/pb-e2e-*"
        )


def _reset_data_dir(path: Path) -> Path:
    default_data_dir_guard(path)
    resolved = path.expanduser().resolve()
    if resolved.exists():
        shutil.rmtree(resolved)
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


class AddonProcess:
    """Starts the addon with dev env vars and waits until /health answers."""

    def __init__(self, options: StandOptions) -> None:
        self.options = options
        self.base_url = ""
        self.port = 0
        self.log_path: Path | None = None
        self.mode = "external"
        self._proc: asyncio.subprocess.Process | None = None
        self._log_file: Any = None

    async def start(self) -> str:
        if self.options.addon_url:
            self.base_url = self.options.addon_url.rstrip("/")
            self.mode = "external"
            await self._wait_health(20.0)
            return self.base_url

        self.mode = "spawned"
        self.port = free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        command = await asyncio.to_thread(self._prepare_command)
        data_dir = _reset_data_dir(self.options.data_dir)

        self.options.log_dir.mkdir(parents=True, exist_ok=True)
        self.log_path = self.options.log_dir / (
            f"addon-{time.strftime('%Y%m%d-%H%M%S')}-{self.port}.log"
        )
        self._log_file = self.log_path.open("wb")

        env = os.environ.copy()
        env.update(
            {
                "PULSAR_BRAIN_DATA_DIR": str(data_dir),
                "PULSAR_BRAIN_HA_URL": self.options.fake_ha_url,
                "PULSAR_BRAIN_HA_TOKEN": DEFAULT_HA_TOKEN,
                "PULSAR_BRAIN_STT_HOST": self.options.stt_host,
                "PULSAR_BRAIN_STT_PORT": str(self.options.stt_port),
                "PULSAR_BRAIN_TTS_HOST": self.options.tts_host,
                "PULSAR_BRAIN_TTS_PORT": str(self.options.tts_port),
                "PULSAR_BRAIN_PROVIDER_ID": "mock",
                "PULSAR_BRAIN_PORT": str(self.port),
                "PULSAR_BRAIN_HOST": "127.0.0.1",
                "PULSAR_BRAIN_BRIDGE_TOKEN": self.options.bridge_token,
                "PULSAR_BRAIN_UI_TOKEN": self.options.bridge_token,
                "PULSAR_BRAIN_LOG_LEVEL": "debug",
            }
        )
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(ADDON_DIR),
                env=env,
                stdout=self._log_file,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as err:
            raise HarnessError(f"не удалось запустить аддон: {err}") from err
        await self._wait_health(60.0)
        return self.base_url

    def _prepare_command(self) -> list[str]:
        entry = _resolve_entry()
        source_mtime = _newest_source_mtime()
        needs_build = (
            self.options.force_build
            or entry is None
            or (entry is not None and source_mtime > entry.stat().st_mtime)
        )
        if needs_build:
            if self.options.verbose:
                print("сборка аддона: npm run build", file=sys.stderr)
            ok, output = _build_addon()
            if not ok:
                if entry is None:
                    raise HarnessError(
                        "аддон не собран, и сборка не удалась (npm run build):\n"
                        + _tail(output)
                    )
                print(
                    "ВНИМАНИЕ: npm run build завершился ошибкой; "
                    "использую существующий dist (может быть устаревшим):\n"
                    + _tail(output, 15),
                    file=sys.stderr,
                )
            else:
                entry = _resolve_entry()

        if entry is not None:
            return ["node", str(entry)]

        tsx = ADDON_DIR / "node_modules" / ".bin" / "tsx"
        if tsx.exists():
            return [str(tsx), "src/index.ts"]

        raise HarnessError(
            "в addon/ нет ни dist/src/index.js, ни node_modules/.bin/tsx; "
            "сначала соберите аддон (cd addon && npm run build)"
        )

    async def _wait_health(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        last_error = ""
        async with aiohttp.ClientSession() as session:
            while time.monotonic() < deadline:
                if self._proc is not None and self._proc.returncode is not None:
                    raise HarnessError(
                        f"аддон завершился с кодом {self._proc.returncode} до /health\n"
                        + self.log_tail()
                    )
                try:
                    response = await http_request(
                        session, "GET", f"{self.base_url}/health", timeout=2.0
                    )
                    if response.status == 200:
                        payload = response.json_value()
                        if isinstance(payload, dict) and payload.get("status") == "ok":
                            return
                        last_error = f"/health вернул {payload!r}"
                    else:
                        last_error = f"/health вернул HTTP {response.status}"
                except (HarnessError, ApiError) as err:
                    last_error = str(err)
                await asyncio.sleep(0.25)
        raise HarnessError(
            f"аддон не ответил /health за {timeout:.0f} с ({last_error})\n"
            + self.log_tail()
        )

    def log_tail(self, lines: int = 60) -> str:
        if self.log_path is None or not self.log_path.exists():
            return "(лог аддона недоступен)"
        try:
            return _tail(self.log_path.read_text(encoding="utf-8", errors="replace"), lines)
        except OSError as err:
            return f"(лог аддона не читается: {err})"

    async def stop(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            try:
                os.killpg(self._proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=8.0)
            except asyncio.TimeoutError:
                try:
                    os.killpg(self._proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await self._proc.wait()
        if self._log_file is not None:
            with contextlib.suppress(OSError):
                self._log_file.close()
            self._log_file = None
