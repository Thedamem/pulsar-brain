#!/usr/bin/env python3
"""Run pulsar-brain addon e2e scenarios without Home Assistant.

The runner starts a fake Home Assistant, starts the addon as a real Node process
with the dev env vars, waits for /health, probes which API routes are actually
wired, and then executes the scenarios from scenarios.py. Each scenario gets its
own JSON report; the aggregate report is tests/e2e/report.json.

Exit codes:
    0  all executed scenarios passed (skips are reported but do not fail the run)
    1  at least one scenario failed
    2  the stand is not ready: addon did not start, no scenario could run, or
       the requested scenario id is unknown

Examples:
    dev/.venv/bin/python tests/e2e/run.py --list
    dev/.venv/bin/python tests/e2e/run.py
    dev/.venv/bin/python tests/e2e/run.py --scenario ws_light_on --fast
    dev/.venv/bin/python tests/e2e/run.py --addon-url http://127.0.0.1:8097
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import shutil
import sys
import time
import traceback
from pathlib import Path
from typing import Any

E2E_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(E2E_DIR))

try:
    import aiohttp
except ModuleNotFoundError:
    print(
        "ОШИБКА: нужен aiohttp. Запускайте через окружение стенда:\n"
        "  dev/.venv/bin/python tests/e2e/run.py",
        file=sys.stderr,
    )
    raise SystemExit(2)

from fake_ha import FakeHa
from harness import (
    ARTIFACTS_DIR,
    AddonProcess,
    ApiError,
    HarnessError,
    LOGS_DIR,
    REPORTS_DIR,
    RouteUnavailable,
    ScenarioOutcome,
    StandOptions,
    default_data_dir_guard,
    failed,
    now_iso,
    probe_routes,
    skipped,
    tcp_reachable,
)
from scenarios import SCENARIOS, Scenario, ScenarioContext


# ────────────────────────────────────────────────────────────────── cli ──


def _env_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name, "").strip()
    if raw == "":
        return fallback
    try:
        return int(raw)
    except ValueError:
        return fallback


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Сквозные e2e-тесты аддона pulsar-brain без Home Assistant",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Сценарии: --list. Отчёт: tests/e2e/report.json. "
            "Нужны поднятые whisper и piper (dev/docker-compose.yml)."
        ),
    )
    parser.add_argument("--list", action="store_true", help="показать сценарии и выйти")
    parser.add_argument(
        "--scenario",
        action="append",
        default=[],
        metavar="ID",
        help="выполнить только указанный сценарий (можно несколько раз)",
    )
    parser.add_argument(
        "--report",
        default=str(E2E_DIR / "report.json"),
        help="путь агрегатного JSON-отчёта",
    )
    parser.add_argument(
        "--addon-url",
        default=None,
        help="использовать уже запущенный аддон вместо запуска своего",
    )
    parser.add_argument(
        "--build",
        action="store_true",
        help="принудительно пересобрать аддон (npm run build) перед запуском",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help="не пейсить PCM в реальном времени (быстрее, но barge-in всегда realtime)",
    )
    parser.add_argument(
        "--run-timeout",
        type=float,
        default=45.0,
        help="сколько ждать run.end после отправки аудио, с (по умолчанию 45)",
    )
    parser.add_argument(
        "--scenario-timeout",
        type=float,
        default=120.0,
        help="жёсткий лимит на один сценарий, с (по умолчанию 120)",
    )
    parser.add_argument(
        "--data-dir",
        default="/tmp/pb-e2e-data",
        help="PULSAR_BRAIN_DATA_DIR для аддона (по умолчанию /tmp/pb-e2e-data)",
    )
    parser.add_argument(
        "--keep-data",
        action="store_true",
        help="не удалять каталог данных аддона после прогона",
    )
    parser.add_argument(
        "--bridge-token",
        default="test-token",
        help="Bearer-токен моста и UI (по умолчанию test-token)",
    )
    parser.add_argument(
        "--stt-host",
        default=os.environ.get("PULSAR_BRAIN_STT_HOST", "127.0.0.1"),
        help="хост whisper (по умолчанию PULSAR_BRAIN_STT_HOST)",
    )
    parser.add_argument(
        "--stt-port",
        type=int,
        default=_env_int("PULSAR_BRAIN_STT_PORT", 10300),
        help="порт whisper (по умолчанию PULSAR_BRAIN_STT_PORT)",
    )
    parser.add_argument(
        "--tts-host",
        default=os.environ.get("PULSAR_BRAIN_TTS_HOST", "127.0.0.1"),
        help="хост piper (по умолчанию PULSAR_BRAIN_TTS_HOST)",
    )
    parser.add_argument(
        "--tts-port",
        type=int,
        default=_env_int("PULSAR_BRAIN_TTS_PORT", 10200),
        help="порт piper (по умолчанию PULSAR_BRAIN_TTS_PORT)",
    )
    parser.add_argument(
        "--tts-voice",
        default=os.environ.get("PULSAR_BRAIN_TTS_VOICE", "ru_RU-irina-medium"),
        help="голос Piper для /api/tts/preview",
    )
    parser.add_argument("--verbose", action="store_true", help="печатать сборку и отладку")
    return parser.parse_args(argv)


def select_scenarios(ids: list[str]) -> list[Scenario]:
    if not ids:
        return list(SCENARIOS)
    known = {scenario.id: scenario for scenario in SCENARIOS}
    unknown = [scenario_id for scenario_id in ids if scenario_id not in known]
    if unknown:
        print(
            "ОШИБКА: неизвестные сценарии: "
            + ", ".join(unknown)
            + "\nДоступные: "
            + ", ".join(known),
            file=sys.stderr,
        )
        raise SystemExit(2)
    selected: list[Scenario] = []
    for scenario_id in ids:
        scenario = known[scenario_id]
        if scenario not in selected:
            selected.append(scenario)
    return selected


def scenario_fixtures(scenario: Scenario) -> list[str]:
    names: list[str] = []
    if scenario.fixture:
        names.append(scenario.fixture)
    names.extend(scenario.extra_fixtures)
    return names


def print_scenarios(selected: list[Scenario]) -> None:
    print(f"Сценарии pulsar-brain e2e ({len(selected)}):")
    for scenario in selected:
        fixtures = scenario_fixtures(scenario)
        fixture_note = "без фикстуры"
        if fixtures:
            parts = []
            for name in fixtures:
                path = E2E_DIR.parent / "fixtures" / name
                parts.append(f"{name} [{'есть' if path.exists() else 'нет'}]")
            fixture_note = ", ".join(parts)
        print(f"  {scenario.id:22s} {scenario.transport:5s} {scenario.title}")
        print(f"  {'':22s} {'':5s} фикстура: {fixture_note}")


# ─────────────────────────────────────────────────────────────── run ──


class DirGuard:
    """Only our own generated directories may be cleaned."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def reset(self, path: Path) -> None:
        resolved = path.resolve()
        if self.root not in resolved.parents:
            raise HarnessError(f"отказ очищать {resolved}: путь вне {self.root}")
        if resolved.exists():
            shutil.rmtree(resolved)
        resolved.mkdir(parents=True, exist_ok=True)

    def ensure(self, path: Path) -> None:
        resolved = path.resolve()
        if self.root not in resolved.parents and resolved != self.root:
            raise HarnessError(f"отказ создавать {resolved}: путь вне {self.root}")
        resolved.mkdir(parents=True, exist_ok=True)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _relative(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(E2E_DIR.parent.parent))
    except ValueError:
        return str(path)


def _fixture_inventory() -> dict[str, int]:
    fixtures_dir = E2E_DIR.parent / "fixtures"
    if not fixtures_dir.exists():
        return {}
    return {
        path.name: path.stat().st_size
        for path in sorted(fixtures_dir.glob("*.wav"))
    }


def _skip_reason(
    scenario: Scenario,
    ctx: ScenarioContext,
    stt: tuple[str, int],
    tts: tuple[str, int],
) -> str | None:
    for name in scenario_fixtures(scenario):
        if not (ctx.fixtures_dir / name).exists():
            return (
                f"нет фикстуры {name}; запустите "
                "dev/.venv/bin/python tests/fixtures/make_ru_fixtures.py"
            )
    for requirement in scenario.requires:
        if requirement == "stt" and not ctx.stt_available:
            return f"STT {stt[0]}:{stt[1]} недоступен (нужен wyoming-whisper)"
        if requirement == "tts" and not ctx.tts_available:
            return f"TTS {tts[0]}:{tts[1]} недоступен (нужен wyoming-piper)"
        if requirement == "bridge" and not ctx.routes.get("/api/bridge/ws", False):
            return "аддон не реализует WS /api/bridge/ws (HTTP 404)"
        if requirement.startswith("route:"):
            path = requirement.split(":", 1)[1]
            if not ctx.routes.get(path, False):
                return f"аддон не реализует {path} (HTTP 404)"
    return None


def _scenario_record(
    scenario: Scenario,
    outcome: ScenarioOutcome,
    duration_ms: float,
    started_at: str,
) -> dict[str, Any]:
    return {
        "id": scenario.id,
        "title": scenario.title,
        "transport": scenario.transport,
        "fixture": scenario.fixture,
        "extraFixtures": list(scenario.extra_fixtures),
        "requires": list(scenario.requires),
        "status": outcome.status,
        "exitCode": outcome.exit_code(),
        "durationMs": round(duration_ms, 1),
        "startedAt": started_at,
        "finishedAt": now_iso(),
        "skipReason": outcome.skip_reason or None,
        "error": outcome.error,
        "checks": [check.as_dict() for check in outcome.checks],
        "details": outcome.details,
    }


def _print_header(args: argparse.Namespace, addon: AddonProcess, ctx: ScenarioContext) -> None:
    print("pulsar-brain e2e — аддон без Home Assistant")
    print(f"Аддон:    {addon.base_url} ({addon.mode})")
    if addon.log_path is not None:
        print(f"Лог:      {_relative(addon.log_path)}")
    print(f"Fake HA:  {ctx.fake_ha.base_url} (Bearer dev)")
    print(
        f"STT:      {args.stt_host}:{args.stt_port} — "
        + ("доступен" if ctx.stt_available else "НЕДОСТУПЕН")
    )
    print(
        f"TTS:      {args.tts_host}:{args.tts_port} — "
        + ("доступен" if ctx.tts_available else "НЕДОСТУПЕН")
    )
    fixtures = _fixture_inventory()
    print(f"Фикстуры: {_relative(ctx.fixtures_dir)} — {len(fixtures)} WAV")
    routes = ", ".join(
        f"{path}={'да' if available else 'нет'}" for path, available in ctx.routes.items()
    )
    print(f"Маршруты: {routes}")
    print()


def _print_outcome(record: dict[str, Any]) -> None:
    marks = {"passed": "[ OK ]", "failed": "[FAIL]", "skipped": "[SKIP]"}
    mark = marks.get(record["status"], "[????]")
    line = (
        f"{mark} {record['id']} · {record['title']} · "
        f"{record['durationMs'] / 1000.0:.1f} с"
    )
    if record["status"] == "skipped" and record["skipReason"]:
        line += f" — {record['skipReason']}"
    elif record["status"] == "failed":
        if record["error"]:
            line += f" — {record['error']}"
        else:
            failed_checks = [check for check in record["checks"] if not check["ok"]]
            if failed_checks:
                line += f" — {failed_checks[0]['name']}"
    print(line)
    if record["status"] == "failed":
        failed_checks = [check for check in record["checks"] if not check["ok"]]
        for check in failed_checks[:4]:
            detail = check["detail"]
            print(f"       — {check['name']}: {detail}")
        if len(failed_checks) > 4:
            print(f"       — и ещё {len(failed_checks) - 4} проверок")


async def run(args: argparse.Namespace, selected: list[Scenario]) -> int:
    guard = DirGuard(E2E_DIR)
    guard.reset(ARTIFACTS_DIR)
    guard.reset(REPORTS_DIR)
    guard.ensure(LOGS_DIR)

    started_wall = now_iso()
    started_mono = time.monotonic()
    report_path = Path(args.report).resolve()
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "tool": "pulsar-brain-e2e",
        "startedAt": started_wall,
        "finishedAt": None,
        "durationMs": None,
        "command": " ".join([Path(sys.argv[0]).name, *sys.argv[1:]]),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "realtime": not args.fast,
            "fixturesDir": _relative(E2E_DIR.parent / "fixtures"),
            "fixtures": _fixture_inventory(),
            "stt": {"host": args.stt_host, "port": args.stt_port, "available": None},
            "tts": {"host": args.tts_host, "port": args.tts_port, "available": None},
            "fakeHa": None,
            "addon": None,
            "routes": {},
        },
        "summary": {"total": len(selected), "passed": 0, "failed": 0, "skipped": 0},
        "exitCode": None,
        "infraError": None,
        "addonLogTail": None,
        "scenarios": [],
    }

    fake_ha = FakeHa()
    addon = AddonProcess(
        StandOptions(
            addon_url=args.addon_url,
            force_build=args.build,
            data_dir=Path(args.data_dir),
            fake_ha_url="",
            stt_host=args.stt_host,
            stt_port=args.stt_port,
            tts_host=args.tts_host,
            tts_port=args.tts_port,
            bridge_token=args.bridge_token,
            log_dir=LOGS_DIR,
            verbose=args.verbose,
        )
    )
    ctx: ScenarioContext | None = None

    try:
        await fake_ha.start()
        stt_available = await tcp_reachable(args.stt_host, args.stt_port)
        tts_available = await tcp_reachable(args.tts_host, args.tts_port)
        report["environment"]["fakeHa"] = fake_ha.base_url
        report["environment"]["stt"]["available"] = stt_available
        report["environment"]["tts"]["available"] = tts_available
        addon.options.fake_ha_url = fake_ha.base_url

        try:
            await addon.start()
        except HarnessError as err:
            report["infraError"] = str(err)
            report["environment"]["addon"] = {
                "url": addon.base_url or None,
                "mode": addon.mode,
                "logPath": _relative(addon.log_path) if addon.log_path else None,
            }
            if addon.log_path is not None:
                report["addonLogTail"] = addon.log_tail().splitlines()[-60:]
            for scenario in selected:
                outcome = skipped(f"аддон не запустился: {err}")
                record = _scenario_record(scenario, outcome, 0.0, now_iso())
                report["scenarios"].append(record)
                _write_json(REPORTS_DIR / f"{scenario.id}.json", record)
            _finalize_report(report, started_mono, 2)
            _write_json(report_path, report)
            print(f"ОШИБКА: {err}", file=sys.stderr)
            print("\nАддон не запущен, сценарии не выполнялись.", file=sys.stderr)
            print(f"Отчёт: {_relative(report_path)}")
            return 2

        report["environment"]["addon"] = {
            "url": addon.base_url,
            "mode": addon.mode,
            "logPath": _relative(addon.log_path) if addon.log_path else None,
            "dataDir": _relative(addon.options.data_dir),
        }

        async with aiohttp.ClientSession() as http:
            routes = await probe_routes(http, addon.base_url, args.bridge_token)
            report["environment"]["routes"] = routes
            ctx = ScenarioContext(
                fake_ha=fake_ha,
                base_url=addon.base_url,
                token=args.bridge_token,
                bridge_token=args.bridge_token,
                http=http,
                fixtures_dir=E2E_DIR.parent / "fixtures",
                artifacts_dir=ARTIFACTS_DIR,
                routes=routes,
                realtime=not args.fast,
                stt_available=stt_available,
                tts_available=tts_available,
                run_timeout_sec=args.run_timeout,
                tts_voice=args.tts_voice,
            )
            _print_header(args, addon, ctx)

            for scenario in selected:
                skip_reason = _skip_reason(
                    scenario,
                    ctx,
                    (args.stt_host, args.stt_port),
                    (args.tts_host, args.tts_port),
                )
                started_at = now_iso()
                scenario_mono = time.monotonic()
                if skip_reason is not None:
                    outcome = skipped(skip_reason)
                else:
                    fake_ha.reset()
                    try:
                        outcome = await asyncio.wait_for(
                            scenario.run(ctx), timeout=args.scenario_timeout
                        )
                    except asyncio.TimeoutError:
                        outcome = failed(
                            f"сценарий не завершился за {args.scenario_timeout:.0f} с"
                        )
                    except (RouteUnavailable, HarnessError) as err:
                        outcome = skipped(str(err))
                    except ApiError as err:
                        outcome = failed(f"ошибка API: {err}")
                    except Exception as err:  # noqa: BLE001 - the report needs the details
                        outcome = failed(
                            f"необработанная ошибка: {type(err).__name__}: {err}"
                        )
                        outcome.details["traceback"] = traceback.format_exc()[-4000:]
                duration_ms = (time.monotonic() - scenario_mono) * 1000.0
                record = _scenario_record(scenario, outcome, duration_ms, started_at)
                report["scenarios"].append(record)
                _write_json(REPORTS_DIR / f"{scenario.id}.json", record)
                _print_outcome(record)
                if args.verbose and outcome.status == "failed" and addon.log_path:
                    print("       последние строки лога аддона:")
                    for log_line in addon.log_tail(15).splitlines():
                        print(f"       | {log_line}")
    finally:
        await addon.stop()
        await fake_ha.stop()
        if not args.keep_data and args.addon_url is None:
            try:
                default_data_dir_guard(Path(args.data_dir))
            except HarnessError:
                pass
            else:
                shutil.rmtree(Path(args.data_dir), ignore_errors=True)

    records = report["scenarios"]
    passed = sum(1 for record in records if record["status"] == "passed")
    failed_count = sum(1 for record in records if record["status"] == "failed")
    skipped_count = sum(1 for record in records if record["status"] == "skipped")
    exit_code = 0 if failed_count == 0 else 1
    if passed == 0 and failed_count == 0:
        exit_code = 2
    _finalize_report(report, started_mono, exit_code)
    if addon.log_path is not None:
        report["addonLogTail"] = addon.log_tail(80).splitlines()[-80:]
    _write_json(report_path, report)

    print()
    print(
        f"Итог: {passed} passed, {failed_count} failed, {skipped_count} skipped "
        f"за {report['durationMs'] / 1000.0:.1f} с"
    )
    print(f"Отчёт: {_relative(report_path)}")
    print(f"Отчёты сценариев: {_relative(REPORTS_DIR)}")
    if addon.log_path is not None:
        print(f"Лог аддона: {_relative(addon.log_path)}")
    if exit_code == 2:
        print(
            "Прогон неполный: ни один сценарий не выполнен. "
            "Проверьте маршруты аддона, фикстуры и сервисы STT/TTS.",
            file=sys.stderr,
        )
    return exit_code


def _finalize_report(report: dict[str, Any], started_mono: float, exit_code: int) -> None:
    report["finishedAt"] = now_iso()
    report["durationMs"] = round((time.monotonic() - started_mono) * 1000.0, 1)
    report["exitCode"] = exit_code
    records = report["scenarios"]
    report["summary"] = {
        "total": len(records),
        "passed": sum(1 for record in records if record["status"] == "passed"),
        "failed": sum(1 for record in records if record["status"] == "failed"),
        "skipped": sum(1 for record in records if record["status"] == "skipped"),
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    selected = select_scenarios(args.scenario)
    if args.list:
        print_scenarios(selected)
        return 0
    try:
        return asyncio.run(run(args, selected))
    except KeyboardInterrupt:
        print("прервано", file=sys.stderr)
        return 130
    except HarnessError as err:
        print(f"ОШИБКА инфраструктуры: {err}", file=sys.stderr)
        return 2
    except Exception as err:  # noqa: BLE001 - the CLI must not print a bare traceback
        print(f"ОШИБКА: {type(err).__name__}: {err}", file=sys.stderr)
        if args.verbose:
            traceback.print_exc()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
