"""E2E scenarios for the pulsar-brain addon: full voice pipeline without HA.

Every scenario is independent: the runner resets the fake Home Assistant before
it starts and writes a separate JSON report afterwards. Voice scenarios speak to
/api/bridge/ws exactly like the Python bridge does; HTTP scenarios exercise
/api/test/text, /api/test/audio and /api/tts/preview.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

import aiohttp

from bridge_client import BridgeRunConfig, BridgeRunResult, pcm_from_wav, run_bridge
from fake_ha import FakeHa
from harness import (
    ApiError,
    Checks,
    HarnessError,
    RouteUnavailable,
    ScenarioOutcome,
    addon_schedules,
    addon_sessions,
    analyze_answer_wav,
    api_json,
    epoch_ms,
    http_request,
    read_wav_file,
    short_detail,
)

MOSCOW = ZoneInfo("Europe/Moscow")

LIGHT_ON_FIXTURE = "alisa_vklyuchi_svet.wav"
LIGHT_TV_FIXTURE = "alisa_vklyuchi_svet_i_televizor.wav"
TIMER_FIXTURE = "alisa_vklyuchi_svet_na_10_minut.wav"
CLOCK_FIXTURE = "alisa_vyklyuchi_svet_v_22_00.wav"
FOLLOWUP_FIXTURE = "alisa_a_teper_vyklyuchi.wav"
SILENCE_FIXTURE = "silence_3s.wav"

DEFAULT_TTS_VOICE = "ru_RU-irina-medium"


@dataclass
class ScenarioContext:
    fake_ha: FakeHa
    base_url: str
    token: str
    bridge_token: str
    http: aiohttp.ClientSession
    fixtures_dir: Path
    artifacts_dir: Path
    routes: dict[str, bool]
    realtime: bool
    stt_available: bool
    tts_available: bool
    run_timeout_sec: float
    tts_voice: str = DEFAULT_TTS_VOICE


@dataclass(frozen=True)
class Scenario:
    id: str
    title: str
    transport: str
    fixture: str | None
    requires: tuple[str, ...]
    run: Callable[[ScenarioContext], Awaitable[ScenarioOutcome]]
    extra_fixtures: tuple[str, ...] = ()


# ───────────────────────────────────────────────────────────────── helpers ──


def _fixture_path(ctx: ScenarioContext, name: str) -> Path:
    path = ctx.fixtures_dir / name
    if not path.exists():
        raise HarnessError(
            f"нет фикстуры {path}; запустите "
            "dev/.venv/bin/python tests/fixtures/make_ru_fixtures.py"
        )
    return path


def _ws_url(ctx: ScenarioContext) -> str:
    return ctx.base_url.replace("http://", "ws://", 1) + "/api/bridge/ws"


def _bridge_config(
    ctx: ScenarioContext,
    fixture: str,
    run_id: str,
    wake_word_phrase: str,
    *,
    realtime: bool | None = None,
    cancel_after_audio_ms: int | None = None,
    timeout_sec: float | None = None,
    use_wake_word: bool = True,
) -> BridgeRunConfig:
    pcm = pcm_from_wav(_fixture_path(ctx, fixture))
    return BridgeRunConfig(
        ws_url=_ws_url(ctx),
        token=ctx.bridge_token,
        run_id=run_id,
        wake_word_phrase=wake_word_phrase,
        audio_pcm=pcm,
        realtime=ctx.realtime if realtime is None else realtime,
        use_wake_word=use_wake_word,
        timeout_sec=ctx.run_timeout_sec if timeout_sec is None else timeout_sec,
        cancel_after_audio_ms=cancel_after_audio_ms,
    )


def _conversation(result: BridgeRunResult) -> dict[str, Any]:
    return {
        "transcript": result.transcript,
        "response": result.response_text,
        "runEndReason": result.run_end_reason,
        "ttsEndReason": result.tts_end_reason,
    }


def _check_accepted(checks: Checks, result: BridgeRunResult) -> None:
    accepted = [m for m in result.messages if m.payload.get("type") == "run.accepted"]
    checks.check(
        "аддон принял run (run.accepted)",
        bool(accepted),
        "нет run.accepted" if not accepted else f"{len(accepted)} сообщений",
    )


def _check_transcript(checks: Checks, result: BridgeRunResult, words: tuple[str, ...]) -> str:
    transcript = (result.transcript or "").strip()
    checks.check("получен транскрипт (device.event stt_end)", bool(transcript), transcript or "пусто")
    normalized = transcript.lower().replace("ё", "е")
    for word in words:
        checks.check(
            f"транскрипт содержит «{word}»",
            word.lower().replace("ё", "е") in normalized,
            transcript or "пусто",
        )
    return transcript


def _check_run_finished(
    checks: Checks, result: BridgeRunResult, expected_reasons: tuple[str, ...] = ("done",)
) -> None:
    checks.check(
        "run завершён (run.end)",
        result.run_end_reason is not None,
        f"таймаут={result.timed_out}, закрытие={result.close_code}",
    )
    checks.check(
        "run.end reason=" + "/".join(expected_reasons),
        result.run_end_reason in expected_reasons,
        result.run_end_reason or "run.end не получен",
    )
    checks.check(
        "аддон не прислал ошибку",
        not result.error_payloads(),
        result.error_codes() or "нет",
    )


def _save_tts(ctx: ScenarioContext, scenario_id: str, result: BridgeRunResult) -> dict[str, Any]:
    info, problem = analyze_answer_wav(result.tts_wav)
    artifact: str | None = None
    if result.tts_wav:
        path = ctx.artifacts_dir / f"{scenario_id}.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(result.tts_wav)
        artifact = str(path)
    return {"info": info, "problem": problem, "artifact": artifact}


def _check_tts(
    checks: Checks,
    ctx: ScenarioContext,
    scenario_id: str,
    result: BridgeRunResult,
    expected_reason: str | None = "done",
) -> dict[str, Any]:
    saved = _save_tts(ctx, scenario_id, result)
    info = saved["info"]
    problem = saved["problem"]
    checks.check(
        "получен tts.start",
        result.tts_start_at_ms is not None,
        result.timeline() or "нет сообщений",
    )
    checks.check(
        "WAV ответа разбирается как RIFF/WAV",
        info is not None,
        problem or "",
    )
    checks.check(
        "WAV ответа: 16 кГц, моно, 16 бит, не тишина",
        problem is None and info is not None,
        problem or (info.summary() if info else "нет WAV"),
    )
    checks.check(
        "длительность WAV больше нуля",
        info is not None and info.duration_sec > 0,
        f"{info.duration_sec:.2f} с" if info else "нет WAV",
    )
    if expected_reason is not None:
        checks.check(
            f"tts.end reason={expected_reason}",
            result.tts_end_reason == expected_reason,
            result.tts_end_reason or "tts.end не получен",
        )
    tts_device_events = [
        message.payload
        for message in result.device_events()
        if str(message.payload.get("event", "")).startswith("tts_")
    ]
    details: dict[str, Any] = {
        "tts": info.as_dict() if info is not None else None,
        "ttsProblem": problem,
        "artifact": saved["artifact"],
        "ttsStartText": result.tts_start_text,
        "ttsDeviceEvents": tts_device_events,
        "ttsUrlNote": (
            "URL из TTS_END здесь не проверяется: его публикует Python-мост, "
            "который в эти e2e не входит"
        ),
    }
    return details


def _calls_details(ctx: ScenarioContext) -> dict[str, Any]:
    return {
        "serviceCalls": [call.as_dict() for call in ctx.fake_ha.calls],
        "summaries": ctx.fake_ha.call_summaries(),
    }


def _action_targets_light_off(entry: dict[str, Any]) -> tuple[bool, Any]:
    action = entry.get("action")
    if not isinstance(action, dict):
        return False, action
    request = action.get("request")
    if not isinstance(request, dict):
        return False, action
    domain = request.get("domain")
    service = request.get("service")
    target = request.get("target")
    entities: list[str] = []
    entity_raw = request.get("entity_id")
    if isinstance(entity_raw, str):
        entities.append(entity_raw)
    elif isinstance(entity_raw, list):
        entities.extend(item for item in entity_raw if isinstance(item, str))
    if isinstance(target, dict):
        target_raw = target.get("entity_id")
        if isinstance(target_raw, str):
            entities.append(target_raw)
        elif isinstance(target_raw, list):
            entities.extend(item for item in target_raw if isinstance(item, str))
    ok = domain == "light" and service == "turn_off" and "light.kitchen" in entities
    return ok, action


def _find_schedule(
    entries: list[dict[str, Any]], expected_ms: float, tolerance_ms: float
) -> dict[str, Any] | None:
    for entry in entries:
        at = epoch_ms(entry.get("at"))
        if at is not None and abs(at - expected_ms) <= tolerance_ms:
            return entry
    return None


def _find_schedule_near_clock(
    entries: list[dict[str, Any]], expected_ms: float, tolerance_ms: float
) -> dict[str, Any] | None:
    """Match a daily clock time, tolerating a run that crosses the target minute."""
    day_ms = 86_400_000.0
    for shift in (-day_ms, 0.0, day_ms):
        entry = _find_schedule(entries, expected_ms + shift, tolerance_ms)
        if entry is not None:
            return entry
    return None


def _next_2200() -> tuple[float, str]:
    now = datetime.now(MOSCOW)
    target = now.replace(hour=22, minute=0, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target.timestamp() * 1000.0, target.isoformat(timespec="minutes")


def _session_view(session: dict[str, Any]) -> dict[str, Any]:
    tool_calls = session.get("toolCalls")
    return {
        "id": session.get("id"),
        "state": session.get("state"),
        "endReason": session.get("endReason"),
        "transcript": session.get("transcript"),
        "response": session.get("response"),
        "toolCalls": tool_calls if isinstance(tool_calls, list) else [],
    }


async def _schedules_entries(ctx: ScenarioContext) -> list[dict[str, Any]]:
    payload = await addon_schedules(ctx.http, ctx.base_url, ctx.token)
    entries = payload["entries"]
    return [entry for entry in entries if isinstance(entry, dict)]


# ──────────────────────────────────────────────────────────────── scenarios ──


async def ws_light_on(ctx: ScenarioContext) -> ScenarioOutcome:
    checks = Checks()
    result = await run_bridge(
        _bridge_config(
            ctx,
            LIGHT_ON_FIXTURE,
            "e2e-light-on",
            "Алиса, включи свет",
        )
    )
    _check_accepted(checks, result)
    _check_transcript(checks, result, ("включи", "свет"))
    calls = ctx.fake_ha.calls_for("light", "turn_on")
    checks.check(
        "fake HA получил light.turn_on",
        bool(calls),
        ctx.fake_ha.call_summaries() or "вызовов нет",
    )
    checks.check(
        "вызов адресован light.kitchen",
        ctx.fake_ha.called("light", "turn_on", "light.kitchen"),
        ctx.fake_ha.call_summaries() or "вызовов нет",
    )
    tts = _check_tts(checks, ctx, "ws_light_on", result)
    _check_run_finished(checks, result)
    return checks.outcome(
        {
            "fixture": LIGHT_ON_FIXTURE,
            "conversation": _conversation(result),
            **_calls_details(ctx),
            **tts,
        }
    )


async def ws_light_and_tv(ctx: ScenarioContext) -> ScenarioOutcome:
    checks = Checks()
    result = await run_bridge(
        _bridge_config(
            ctx,
            LIGHT_TV_FIXTURE,
            "e2e-light-and-tv",
            "Алиса, включи свет и телевизор",
        )
    )
    _check_accepted(checks, result)
    _check_transcript(checks, result, ("включи", "свет", "телевизор"))
    checks.check(
        "fake HA получил light.turn_on",
        ctx.fake_ha.called("light", "turn_on", "light.kitchen"),
        ctx.fake_ha.call_summaries() or "вызовов нет",
    )
    checks.check(
        "fake HA получил switch.turn_on",
        ctx.fake_ha.called("switch", "turn_on", "switch.tv"),
        ctx.fake_ha.call_summaries() or "вызовов нет",
    )
    checks.check(
        "выполнены оба действия одной фразы",
        len(ctx.fake_ha.calls_for("light", "turn_on")) >= 1
        and len(ctx.fake_ha.calls_for("switch", "turn_on")) >= 1,
        ctx.fake_ha.call_summaries(),
    )
    tts = _check_tts(checks, ctx, "ws_light_and_tv", result)
    _check_run_finished(checks, result)
    return checks.outcome(
        {
            "fixture": LIGHT_TV_FIXTURE,
            "conversation": _conversation(result),
            **_calls_details(ctx),
            **tts,
        }
    )


async def ws_timer_10min(ctx: ScenarioContext) -> ScenarioOutcome:
    checks = Checks()
    started = time.time() * 1000.0
    result = await run_bridge(
        _bridge_config(
            ctx,
            TIMER_FIXTURE,
            "e2e-timer-10min",
            "Алиса, включи свет на 10 минут",
        )
    )
    _check_accepted(checks, result)
    _check_transcript(checks, result, ("включи", "свет", "10"))
    checks.check(
        "fake HA получил light.turn_on",
        ctx.fake_ha.called("light", "turn_on", "light.kitchen"),
        ctx.fake_ha.call_summaries() or "вызовов нет",
    )

    entries = await _schedules_entries(ctx)
    expected_at = started + 600_000.0
    entry = _find_schedule(entries, expected_at, tolerance_ms=30_000.0)
    checks.check(
        "в планировщике есть задача на now+600 с",
        entry is not None,
        f"ожидалось около {expected_at:.0f}, задачи: "
        + json.dumps([e.get("at") for e in entries], ensure_ascii=False),
    )
    action_ok = False
    action_detail: Any = None
    if entry is not None:
        action_ok, action_detail = _action_targets_light_off(entry)
    checks.check(
        "задача выключает light.kitchen",
        action_ok,
        action_detail if action_detail is not None else "задача не найдена",
    )
    tts = _check_tts(checks, ctx, "ws_timer_10min", result)
    _check_run_finished(checks, result)
    return checks.outcome(
        {
            "fixture": TIMER_FIXTURE,
            "conversation": _conversation(result),
            "expectedAt": int(expected_at),
            "schedules": entries,
            **_calls_details(ctx),
            **tts,
        }
    )


async def ws_schedule_2200(ctx: ScenarioContext) -> ScenarioOutcome:
    checks = Checks()
    expected_at, expected_iso = _next_2200()
    result = await run_bridge(
        _bridge_config(
            ctx,
            CLOCK_FIXTURE,
            "e2e-schedule-2200",
            "Алиса, выключи свет в 22 часа",
        )
    )
    _check_accepted(checks, result)
    _check_transcript(checks, result, ("выключи", "свет", "22"))

    entries = await _schedules_entries(ctx)
    entry = _find_schedule_near_clock(entries, expected_at, tolerance_ms=120_000.0)
    checks.check(
        "в планировщике есть задача на ближайшие 22:00",
        entry is not None,
        f"ожидалось {expected_iso} ({expected_at:.0f}), задачи: "
        + json.dumps([e.get("at") for e in entries], ensure_ascii=False),
    )
    action_ok = False
    action_detail: Any = None
    if entry is not None:
        action_ok, action_detail = _action_targets_light_off(entry)
    checks.check(
        "задача выключает light.kitchen",
        action_ok,
        action_detail if action_detail is not None else "задача не найдена",
    )
    checks.check(
        "свет не выключен сразу (действие отложено)",
        not ctx.fake_ha.called("light", "turn_off"),
        ctx.fake_ha.call_summaries() or "вызовов нет",
    )
    tts = _check_tts(checks, ctx, "ws_schedule_2200", result)
    _check_run_finished(checks, result)
    return checks.outcome(
        {
            "fixture": CLOCK_FIXTURE,
            "expectedAt": int(expected_at),
            "expectedAtIso": expected_iso,
            "conversation": _conversation(result),
            "schedules": entries,
            **_calls_details(ctx),
            **tts,
        }
    )


async def ws_followup(ctx: ScenarioContext) -> ScenarioOutcome:
    checks = Checks()
    first = await run_bridge(
        _bridge_config(
            ctx,
            LIGHT_ON_FIXTURE,
            "e2e-followup-1",
            "Алиса, включи свет",
        )
    )
    _check_accepted(checks, first)
    _check_transcript(checks, first, ("включи", "свет"))
    checks.check(
        "первый run включил свет",
        ctx.fake_ha.called("light", "turn_on", "light.kitchen"),
        ctx.fake_ha.call_summaries() or "вызовов нет",
    )
    _check_run_finished(checks, first)

    second = await run_bridge(
        _bridge_config(
            ctx,
            FOLLOWUP_FIXTURE,
            "e2e-followup-2",
            "",
            use_wake_word=False,
        )
    )
    _check_accepted(checks, second)
    second_transcript = _check_transcript(checks, second, ("выключи",))
    checks.check(
        "второй run выключил свет по контексту (без имени устройства)",
        ctx.fake_ha.called("light", "turn_off", "light.kitchen"),
        ctx.fake_ha.call_summaries() or "вызовов нет",
    )
    _check_tts(checks, ctx, "ws_followup", second)
    _check_run_finished(checks, second)

    sessions = await addon_sessions(ctx.http, ctx.base_url, ctx.token, limit=20)
    views = [_session_view(session) for session in sessions]
    ids = {view["id"] for view in views}
    checks.check(
        "обе сессии сохранены",
        "e2e-followup-1" in ids and "e2e-followup-2" in ids,
        list(ids),
    )
    second_session = next((view for view in views if view["id"] == "e2e-followup-2"), None)
    if second_session is None:
        checks.check("сессия второго run доступна", False, list(ids))
    else:
        second_calls = second_session["toolCalls"]
        args_blob = json.dumps(second_calls, ensure_ascii=False)
        checks.check(
            "вторая сессия содержит ha.call_service для light.kitchen",
            any(
                isinstance(call, dict) and call.get("name") == "ha.call_service"
                for call in second_calls
            )
            and "light.kitchen" in args_blob
            and "turn_off" in args_blob,
            second_calls,
        )
        checks.check(
            "история второго run содержит транскрипт без wake word",
            isinstance(second_session["transcript"], str)
            and "выключи" in second_session["transcript"].lower(),
            second_session["transcript"],
        )
    return checks.outcome(
        {
            "fixtures": [LIGHT_ON_FIXTURE, FOLLOWUP_FIXTURE],
            "first": _conversation(first),
            "second": _conversation(second),
            "secondTranscript": second_transcript,
            "sessions": views,
            **_calls_details(ctx),
        }
    )


async def ws_barge_in(ctx: ScenarioContext) -> ScenarioOutcome:
    checks = Checks()
    # Real-time pacing is mandatory here: cancellation must race the reply.
    result = await run_bridge(
        _bridge_config(
            ctx,
            TIMER_FIXTURE,
            "e2e-barge-in",
            "Алиса, включи свет на 10 минут",
            realtime=True,
            cancel_after_audio_ms=0,
            timeout_sec=15.0,
        )
    )
    checks.check("run.cancel отправлен", result.cancel_sent_at_ms is not None)
    cancel_at = result.cancel_sent_at_ms
    tts_started = result.tts_start_at_ms
    tts_after_cancel = (
        tts_started is not None and cancel_at is not None and tts_started > cancel_at
    )
    checks.check(
        "аддон не начал TTS после отмены",
        not tts_after_cancel,
        f"tts.start на {tts_started} мс, отмена на {cancel_at} мс"
        if tts_after_cancel
        else "TTS после отмены не начат",
    )
    checks.check(
        "run завершён после отмены",
        result.run_end_reason is not None or result.closed_at_ms is not None,
        f"таймаут={result.timed_out}, run.end={result.run_end_reason}",
    )
    if result.run_end_reason is not None:
        checks.check(
            "run.end не done после отмены",
            result.run_end_reason != "done",
            result.run_end_reason,
        )
    if tts_started is not None:
        checks.check(
            "начатый TTS прерван (cancelled/error)",
            result.tts_end_reason in ("cancelled", "error"),
            result.tts_end_reason or "tts.end не получен",
        )
    checks.check(
        "аддон не прислал фатальную ошибку",
        not any(payload.get("fatal") is True for payload in result.error_payloads()),
        result.error_codes() or "нет",
    )
    return checks.outcome(
        {
            "fixture": TIMER_FIXTURE,
            "cancelSentAtMs": cancel_at,
            "ttsStartedAtMs": tts_started,
            "ttsStartedBeforeCancel": tts_started is not None
            and cancel_at is not None
            and tts_started <= cancel_at,
            "runEndReason": result.run_end_reason,
            "ttsEndReason": result.tts_end_reason,
            "timedOut": result.timed_out,
            "events": result.timeline(),
            "conversation": _conversation(result),
        }
    )


async def ws_no_speech(ctx: ScenarioContext) -> ScenarioOutcome:
    checks = Checks()
    # The addon owns the no-speech timeout (10 s), so the client keeps the
    # socket open and only waits: sending run.end here would be a device stop.
    result = await run_bridge(
        _bridge_config(
            ctx,
            SILENCE_FIXTURE,
            "e2e-no-speech",
            "Алиса",
            timeout_sec=20.0,
        )
    )
    codes = [code.lower().replace("_", "-") for code in result.error_codes()]
    checks.check(
        "получен error stt-no-text-recognized",
        any("no-text-recognized" in code for code in codes),
        result.error_codes() or "ошибки нет",
    )
    checks.check(
        "TTS не начат",
        result.tts_start_at_ms is None and not result.binary_sizes,
        f"tts.start={result.tts_start_at_ms}, бинарных кадров={len(result.binary_sizes)}",
    )
    checks.check(
        "run завершён",
        result.run_end_reason is not None or result.closed_at_ms is not None,
        f"таймаут={result.timed_out}",
    )
    if result.run_end_reason is not None:
        checks.check(
            "run.end reason=no_speech",
            result.run_end_reason == "no_speech",
            result.run_end_reason,
        )
    return checks.outcome(
        {
            "fixture": SILENCE_FIXTURE,
            "transcript": result.transcript,
            "errorCodes": result.error_codes(),
            "runEndReason": result.run_end_reason,
            "timedOut": result.timed_out,
            "events": result.timeline(),
        }
    )


async def http_test_text(ctx: ScenarioContext) -> ScenarioOutcome:
    checks = Checks()
    payload = await api_json(
        ctx.http,
        "POST",
        ctx.base_url + "/api/test/text",
        ctx.token,
        json_body={"text": "Алиса, включи свет"},
        timeout=30.0,
    )
    if not isinstance(payload, dict):
        raise ApiError("/api/test/text вернул не объект")
    text = payload.get("text")
    speech = payload.get("speech")
    checks.check("ответ содержит текст", isinstance(text, str) and text.strip() != "", text)
    checks.check(
        "ответ содержит озвучиваемую фразу",
        isinstance(speech, str) and speech.strip() != "",
        speech,
    )
    checks.check(
        "провайдер ответа — mock",
        payload.get("provider") == "mock",
        payload.get("provider"),
    )
    traces = payload.get("toolTraces")
    traces = traces if isinstance(traces, list) else []
    trace_blob = json.dumps(traces, ensure_ascii=False)
    checks.check(
        "toolTraces содержит ha.call_service",
        any(
            isinstance(trace, dict)
            and isinstance(trace.get("call"), dict)
            and trace["call"].get("name") == "ha.call_service"
            for trace in traces
        ),
        traces or "toolTraces пуст",
    )
    checks.check(
        "вызов инструмента адресован light.kitchen (turn_on)",
        "light.kitchen" in trace_blob and "turn_on" in trace_blob,
        short_detail(trace_blob),
    )
    checks.check(
        "fake HA получил light.turn_on",
        ctx.fake_ha.called("light", "turn_on", "light.kitchen"),
        ctx.fake_ha.call_summaries() or "вызовов нет",
    )
    timings = payload.get("timings")
    checks.check(
        "timings содержит llmMs и totalMs",
        isinstance(timings, dict)
        and isinstance(timings.get("llmMs"), (int, float))
        and isinstance(timings.get("totalMs"), (int, float))
        and timings["totalMs"] >= 0,
        timings,
    )
    return checks.outcome(
        {
            "request": {"text": "Алиса, включи свет"},
            "response": {
                "text": text,
                "speech": speech,
                "provider": payload.get("provider"),
                "timings": timings,
            },
            "toolTraces": traces,
            **_calls_details(ctx),
        }
    )


async def http_test_audio(ctx: ScenarioContext) -> ScenarioOutcome:
    checks = Checks()
    fixture = _fixture_path(ctx, LIGHT_ON_FIXTURE)
    data = read_wav_file(fixture)
    form = aiohttp.FormData()
    form.add_field("file", data, filename=LIGHT_ON_FIXTURE, content_type="audio/wav")
    response = await http_request(
        ctx.http,
        "POST",
        ctx.base_url + "/api/test/audio",
        token=ctx.token,
        form=form,
        timeout=120.0,
    )
    if response.status == 404:
        raise RouteUnavailable("POST", "/api/test/audio")
    if response.status != 200:
        raise ApiError(
            f"POST /api/test/audio: HTTP {response.status}: {response.text()[:400]}"
        )
    payload = response.json_value()
    if not isinstance(payload, dict):
        raise ApiError("/api/test/audio вернул не объект")
    transcript = payload.get("transcript")
    text = payload.get("text")
    speech = payload.get("speech")
    checks.check(
        "STT вернул транскрипт",
        isinstance(transcript, str) and transcript.strip() != "",
        transcript or "пусто",
    )
    normalized = transcript.lower().replace("ё", "е") if isinstance(transcript, str) else ""
    checks.check(
        "транскрипт содержит «включи» и «свет»",
        "включи" in normalized and "свет" in normalized,
        transcript,
    )
    checks.check("ответ содержит текст", isinstance(text, str) and text.strip() != "", text)
    checks.check(
        "ответ содержит озвучиваемую фразу",
        isinstance(speech, str) and speech.strip() != "",
        speech,
    )
    traces = payload.get("toolTraces")
    traces = traces if isinstance(traces, list) else []
    trace_blob = json.dumps(traces, ensure_ascii=False)
    checks.check(
        "toolTraces содержит ha.call_service для light.kitchen",
        "ha.call_service" in trace_blob
        and "light.kitchen" in trace_blob
        and "turn_on" in trace_blob,
        traces or "toolTraces пуст",
    )
    checks.check(
        "fake HA получил light.turn_on",
        ctx.fake_ha.called("light", "turn_on", "light.kitchen"),
        ctx.fake_ha.call_summaries() or "вызовов нет",
    )
    timings = payload.get("timings")
    checks.check(
        "timings содержит sttMs, llmMs, totalMs",
        isinstance(timings, dict)
        and all(isinstance(timings.get(key), (int, float)) for key in ("sttMs", "llmMs", "totalMs")),
        timings,
    )
    return checks.outcome(
        {
            "fixture": LIGHT_ON_FIXTURE,
            "response": {
                "transcript": transcript,
                "text": text,
                "speech": speech,
                "timings": timings,
                "provider": payload.get("provider"),
            },
            "toolTraces": traces,
            "ttsNote": "TTS озвучки проверяется сценарием http_tts_preview: "
            "/api/test/audio не возвращает аудио",
            **_calls_details(ctx),
        }
    )


def _pick_voice(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    voices = payload.get("voices")
    if not isinstance(voices, list):
        return None
    for voice in voices:
        if not isinstance(voice, dict):
            continue
        for key in ("id", "name"):
            value = voice.get(key)
            if isinstance(value, str) and value.strip() != "":
                return value
    return None


async def http_tts_preview(ctx: ScenarioContext) -> ScenarioOutcome:
    checks = Checks()
    voice = ctx.tts_voice
    try:
        voices_payload = await api_json(
            ctx.http, "GET", ctx.base_url + "/api/tts/voices", ctx.token, timeout=30.0
        )
        discovered = _pick_voice(voices_payload)
        if discovered is not None:
            voice = discovered
    except (RouteUnavailable, ApiError):
        # The preview is what this scenario tests; the voice list is auxiliary.
        pass

    text = "Свет включён."
    response = await http_request(
        ctx.http,
        "POST",
        ctx.base_url + "/api/tts/preview",
        token=ctx.token,
        json_body={"text": text, "voice": voice},
        timeout=90.0,
    )
    if response.status == 404:
        raise RouteUnavailable("POST", "/api/tts/preview")
    if response.status != 200:
        raise ApiError(
            f"POST /api/tts/preview: HTTP {response.status}: {response.text()[:400]}"
        )
    content_type = response.headers.get("Content-Type", "")
    checks.check(
        "Content-Type ответа — audio/wav",
        content_type.startswith("audio/wav"),
        content_type or "заголовок отсутствует",
    )
    info, problem = analyze_answer_wav(response.body)
    checks.check(
        "WAV ответа разбирается как RIFF/WAV",
        info is not None,
        problem or "",
    )
    checks.check(
        "WAV ответа: 16 кГц, моно, 16 бит, не тишина",
        problem is None,
        problem or (info.summary() if info else "нет WAV"),
    )
    checks.check(
        "длительность WAV больше нуля",
        info is not None and info.duration_sec > 0,
        info.duration_sec if info else "нет WAV",
    )
    artifact: str | None = None
    if response.body:
        path = ctx.artifacts_dir / "http_tts_preview.wav"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(response.body)
        artifact = str(path)
    return checks.outcome(
        {
            "request": {"text": text, "voice": voice},
            "contentType": content_type,
            "wav": info.as_dict() if info else None,
            "artifact": artifact,
        }
    )


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        "ws_light_on",
        "«Алиса, включи свет»",
        "ws",
        LIGHT_ON_FIXTURE,
        ("bridge", "stt", "tts"),
        ws_light_on,
    ),
    Scenario(
        "ws_light_and_tv",
        "«Алиса, включи свет и телевизор»",
        "ws",
        LIGHT_TV_FIXTURE,
        ("bridge", "stt", "tts"),
        ws_light_and_tv,
    ),
    Scenario(
        "ws_timer_10min",
        "«Алиса, включи свет на 10 минут»",
        "ws",
        TIMER_FIXTURE,
        ("bridge", "stt", "tts", "route:/api/schedules"),
        ws_timer_10min,
    ),
    Scenario(
        "ws_schedule_2200",
        "«Алиса, выключи свет в 22:00»",
        "ws",
        CLOCK_FIXTURE,
        ("bridge", "stt", "tts", "route:/api/schedules"),
        ws_schedule_2200,
    ),
    Scenario(
        "ws_followup",
        "Follow-up без wake word, контекст сохраняется",
        "ws",
        FOLLOWUP_FIXTURE,
        ("bridge", "stt", "tts", "route:/api/sessions"),
        ws_followup,
        extra_fixtures=(LIGHT_ON_FIXTURE,),
    ),
    Scenario(
        "ws_barge_in",
        "Barge-in: run.cancel останавливает TTS",
        "ws",
        TIMER_FIXTURE,
        ("bridge", "stt", "tts"),
        ws_barge_in,
    ),
    Scenario(
        "ws_no_speech",
        "Тишина: stt-no-text-recognized без TTS",
        "ws",
        SILENCE_FIXTURE,
        ("bridge", "stt"),
        ws_no_speech,
    ),
    Scenario(
        "http_test_text",
        "HTTP /api/test/text: LLM + инструмент HA",
        "http",
        None,
        ("route:/api/test/text",),
        http_test_text,
    ),
    Scenario(
        "http_test_audio",
        "HTTP /api/test/audio: STT + LLM + инструмент HA",
        "http",
        LIGHT_ON_FIXTURE,
        ("route:/api/test/audio", "stt"),
        http_test_audio,
    ),
    Scenario(
        "http_tts_preview",
        "HTTP /api/tts/preview: WAV 16 кГц моно",
        "http",
        None,
        ("route:/api/tts/preview", "tts"),
        http_tts_preview,
    ),
)
