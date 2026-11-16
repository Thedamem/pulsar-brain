#!/usr/bin/env python3
"""Synthesize Russian speech fixtures for the pulsar-brain e2e tests.

The fixtures are generated through a real wyoming-piper server (the same server
the addon uses for TTS), never hand-written: an ASR false positive on invented
audio would make the e2e results meaningless.

Usage:
    dev/.venv/bin/python tests/fixtures/make_ru_fixtures.py
    dev/.venv/bin/python tests/fixtures/make_ru_fixtures.py --port 10201
    dev/.venv/bin/python tests/fixtures/make_ru_fixtures.py --list

The script writes 16 kHz mono 16-bit WAV files into tests/fixtures/. Every
speech fixture gets a short leading silence and a longer trailing silence, so
the addon's endpointing can see the end of the utterance exactly as it would
from the satellite.
"""

from __future__ import annotations

import argparse
import array
import asyncio
import hashlib
import json
import os
import sys
import time
import wave
from dataclasses import dataclass
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent
OUTPUT_RATE = 16_000
LEAD_SILENCE_SEC = 0.25
TAIL_SILENCE_SEC = 0.9
SILENCE_FIXTURE_SEC = 3.0
MAX_FIXTURE_BYTES = 200 * 1024
SYNTH_TIMEOUT_SEC = 180.0


@dataclass(frozen=True)
class SpeechFixture:
    """One phrase to synthesize and the scenario that uses it."""

    name: str
    text: str
    scenario: str


# Keep this list in sync with tests/e2e/scenarios.py.
SPEECH_FIXTURES: tuple[SpeechFixture, ...] = (
    SpeechFixture("alisa_vklyuchi_svet", "Алиса, включи свет", "ws_light_on"),
    SpeechFixture(
        "alisa_vklyuchi_svet_i_televizor",
        "Алиса, включи свет и телевизор",
        "ws_light_and_tv",
    ),
    SpeechFixture(
        "alisa_vklyuchi_svet_na_10_minut",
        "Алиса, включи свет на 10 минут",
        "ws_timer_10min",
    ),
    SpeechFixture(
        "alisa_vyklyuchi_svet_v_22_00",
        # "22:00" is pronounced as "в двадцать два часа"; whisper transcribes the
        # spoken form consistently, while the colon form comes out as "20, 2-0-0".
        "Алиса, выключи свет в 22 часа",
        "ws_schedule_2200",
    ),
    SpeechFixture("alisa_a_teper_vyklyuchi", "А теперь выключи", "ws_followup"),
)


class FixtureError(RuntimeError):
    """Fixture generation cannot proceed; the message is shown to the operator."""


@dataclass(frozen=True)
class PiperFormat:
    rate: int
    width: int
    channels: int


# ─────────────────────────────────────────────────────── wyoming protocol ──


async def _send_json(writer: asyncio.StreamWriter, message: dict[str, object]) -> None:
    line = (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")
    writer.write(line)
    await writer.drain()


async def _read_event(
    reader: asyncio.StreamReader, timeout: float
) -> tuple[dict[str, object], bytes]:
    """Read one Wyoming event.

    Wyoming >= 1.10 sends the event data as a separate JSON block after the
    header (`data_length`), then the binary payload (`payload_length`). Older
    servers inline the data in the header, so both forms are accepted.
    """
    line = await asyncio.wait_for(reader.readline(), timeout=timeout)
    if not line:
        raise FixtureError("piper закрыл соединение до ответа")
    try:
        header = json.loads(line)
    except json.JSONDecodeError as err:
        raise FixtureError(f"piper прислал некорректный JSON: {line[:120]!r}") from err
    if not isinstance(header, dict):
        raise FixtureError("piper прислал событие не в виде JSON-объекта")

    data_length = header.get("data_length", 0)
    if isinstance(data_length, int) and data_length > 0:
        data_bytes = await asyncio.wait_for(reader.readexactly(data_length), timeout=timeout)
        try:
            header["data"] = json.loads(data_bytes)
        except json.JSONDecodeError as err:
            raise FixtureError(
                f"piper прислал некорректные данные события: {data_bytes[:120]!r}"
            ) from err

    payload_length = header.get("payload_length", 0)
    payload = b""
    if isinstance(payload_length, int) and payload_length > 0:
        payload = await asyncio.wait_for(reader.readexactly(payload_length), timeout=timeout)
    return header, payload


async def _describe(host: str, port: int, timeout: float) -> list[str]:
    _reader, writer = await _connect(host, port)
    try:
        await _send_json(writer, {"type": "describe"})
        header, _payload = await _read_event(_reader, timeout)
    finally:
        writer.close()
        await writer.wait_closed()
    if header.get("type") == "error":
        data = header.get("data")
        raise FixtureError(f"piper describe вернул ошибку: {data!r}")
    voices: list[str] = []
    data = header.get("data")
    if isinstance(data, dict):
        tts = data.get("tts")
        if isinstance(tts, list):
            for engine in tts:
                if not isinstance(engine, dict):
                    continue
                engine_voices = engine.get("voices")
                if not isinstance(engine_voices, list):
                    continue
                for voice in engine_voices:
                    if isinstance(voice, dict) and isinstance(voice.get("name"), str):
                        voices.append(voice["name"])
    return voices


async def _connect(host: str, port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    try:
        return await asyncio.wait_for(asyncio.open_connection(host, port), timeout=10.0)
    except (OSError, asyncio.TimeoutError) as err:
        raise FixtureError(
            f"piper недоступен на {host}:{port}: {describe_os_error(err)}"
        ) from err


async def synthesize(
    host: str, port: int, text: str, voice: str, timeout: float = SYNTH_TIMEOUT_SEC
) -> tuple[bytes, int]:
    """Return raw s16le mono PCM for text plus the server's native sample rate."""
    reader, writer = await _connect(host, port)
    try:
        request: dict[str, object] = {"type": "synthesize", "data": {"text": text}}
        if voice:
            request["data"] = {"text": text, "voice": {"name": voice}}
        await _send_json(writer, request)

        pcm = bytearray()
        fmt: PiperFormat | None = None
        while True:
            header, payload = await _read_event(reader, timeout)
            event_type = header.get("type")
            if event_type == "audio-start":
                fmt = _format_from_event(header)
            elif event_type == "audio-chunk":
                chunk_fmt = _format_from_event(header)
                if fmt is None:
                    fmt = chunk_fmt
                elif chunk_fmt != fmt:
                    raise FixtureError(
                        f"piper сменил формат посреди синтеза: {fmt} -> {chunk_fmt}"
                    )
                if not payload:
                    continue
                pcm.extend(payload)
            elif event_type == "audio-stop":
                break
            elif event_type == "error":
                raise FixtureError(f"piper вернул ошибку синтеза: {header.get('data')!r}")
        if fmt is None:
            raise FixtureError("piper не прислал audio-start/audio-chunk")
        if not pcm:
            raise FixtureError(f"piper вернул пустой звук для фразы {text!r}")
        if fmt.width != 2:
            raise FixtureError(f"piper вернул {fmt.width * 8}-битный звук, ожидался 16-битный")
        if fmt.channels != 1:
            raise FixtureError(f"piper вернул {fmt.channels} каналов, ожидался моно")
        return bytes(pcm), fmt.rate
    finally:
        writer.close()
        await writer.wait_closed()


def _format_from_event(header: dict[str, object]) -> PiperFormat:
    data = header.get("data")
    if not isinstance(data, dict):
        raise FixtureError("piper не указал формат аудио")
    rate = data.get("rate")
    width = data.get("width")
    channels = data.get("channels")
    if not isinstance(rate, int) or rate <= 0:
        raise FixtureError(f"piper вернул некорректный sample rate: {rate!r}")
    if not isinstance(width, int) or width <= 0:
        raise FixtureError(f"piper вернул некорректную ширину сэмпла: {width!r}")
    if not isinstance(channels, int) or channels <= 0:
        raise FixtureError(f"piper вернул некорректное число каналов: {channels!r}")
    return PiperFormat(rate=rate, width=width, channels=channels)


def describe_os_error(err: BaseException) -> str:
    if isinstance(err, ConnectionRefusedError):
        return "соединение отклонено (сервис не запущен)"
    if isinstance(err, asyncio.TimeoutError):
        return "таймаут подключения"
    return str(err) or err.__class__.__name__


# ───────────────────────────────────────────────────────────── resampling ──


def resample_s16le(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    """Linear-interpolation resampler for mono s16le; enough for speech fixtures."""
    if src_rate == dst_rate:
        return pcm
    if len(pcm) % 2 != 0:
        raise FixtureError("длина PCM не кратна размеру сэмпла s16le")
    samples = array.array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()

    if len(samples) == 0:
        return b""
    out_count = max(1, int(round(len(samples) * dst_rate / src_rate)))
    out = array.array("h", bytes(out_count * 2))
    last = len(samples) - 1
    for index in range(out_count):
        position = index * src_rate / dst_rate
        base = int(position)
        if base >= last:
            value = float(samples[last])
        else:
            fraction = position - base
            value = samples[base] * (1.0 - fraction) + samples[base + 1] * fraction
        out[index] = max(-32768, min(32767, int(round(value))))
    if sys.byteorder != "little":
        out.byteswap()
    return out.tobytes()


def silence_pcm(seconds: float, rate: int = OUTPUT_RATE) -> bytes:
    return b"\x00\x00" * int(round(rate * seconds))


def write_wav(path: Path, pcm: bytes, rate: int = OUTPUT_RATE) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(rate)
        wav_file.writeframes(pcm)


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wav_file:
        frames = wav_file.getnframes()
        rate = wav_file.getframerate()
        return frames / rate if rate else 0.0


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


# ─────────────────────────────────────────────────────────────────── main ──


def build_manifest(entries: list[dict[str, object]], voice: str) -> dict[str, object]:
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "piper": {"voice": voice, "outputRate": OUTPUT_RATE},
        "fixtures": entries,
    }


def print_piper_help(host: str, port: int) -> None:
    print(
        "\nФикстуры не созданы: синтез должен идти через живой piper, "
        "подделывать WAV нельзя.\n"
        "Поднимите piper одним из способов:\n"
        "  cd dev && docker compose up -d piper          # порт 10200\n"
        "  docker run -d --rm --name pb-piper-fixtures -p 10201:10200 "
        "rhasspy/wyoming-piper --voice ru_RU-irina-medium   # порт 10201\n"
        "Затем повторите с адресом запущенного сервиса:\n"
        f"  dev/.venv/bin/python tests/fixtures/make_ru_fixtures.py "
        f"--host {host} --port {port}\n"
        "  (для временного контейнера выше: --host 127.0.0.1 --port 10201)\n",
        file=sys.stderr,
    )


async def generate(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        voices = await _describe(args.host, args.port, timeout=15.0)
    except FixtureError as err:
        print(f"ОШИБКА: {err}", file=sys.stderr)
        print_piper_help(args.host, args.port)
        return 2

    if args.voice and voices and args.voice not in voices:
        print(
            f"ОШИБКА: у piper нет голоса {args.voice!r}; доступны: {', '.join(voices)}",
            file=sys.stderr,
        )
        return 2

    print(f"piper: {args.host}:{args.port}, голос: {args.voice or '(по умолчанию)'}")
    print(f"фикстуры: {out_dir}")

    entries: list[dict[str, object]] = []
    failures = 0

    for spec in SPEECH_FIXTURES:
        file_name = f"{spec.name}.wav"
        path = out_dir / file_name
        if path.exists() and not args.force:
            entries.append(
                {
                    "name": spec.name,
                    "file": file_name,
                    "kind": "speech",
                    "text": spec.text,
                    "scenario": spec.scenario,
                    "durationSec": round(wav_duration(path), 3),
                    "sampleRate": OUTPUT_RATE,
                    "bytes": path.stat().st_size,
                    "sha256": sha256_of(path),
                    "reused": True,
                }
            )
            print(f"  [SKIP] {file_name} уже есть (--force для пересинтеза)")
            continue

        try:
            pcm, source_rate = await synthesize(args.host, args.port, spec.text, args.voice)
        except FixtureError as err:
            print(f"  [FAIL] {file_name}: {err}", file=sys.stderr)
            failures += 1
            continue

        # The satellite sends 16 kHz mono; piper usually speaks at 22.05 kHz.
        pcm = resample_s16le(pcm, source_rate, OUTPUT_RATE)
        pcm = silence_pcm(LEAD_SILENCE_SEC) + pcm + silence_pcm(TAIL_SILENCE_SEC)
        write_wav(path, pcm)

        size = path.stat().st_size
        if size > MAX_FIXTURE_BYTES:
            print(
                f"  [WARN] {file_name}: {size} байт, больше {MAX_FIXTURE_BYTES}; "
                "укоротите фразу",
                file=sys.stderr,
            )
        entries.append(
            {
                "name": spec.name,
                "file": file_name,
                "kind": "speech",
                "text": spec.text,
                "scenario": spec.scenario,
                "durationSec": round(wav_duration(path), 3),
                "sampleRate": OUTPUT_RATE,
                "bytes": size,
                "sha256": sha256_of(path),
                "reused": False,
            }
        )
        print(
            f"  [ OK ] {file_name}: «{spec.text}», "
            f"{wav_duration(path):.2f} с, {size // 1024} КиБ"
        )

    # Pure digital silence needs no TTS and is byte-exact by construction.
    silence_path = out_dir / "silence_3s.wav"
    silence = silence_pcm(SILENCE_FIXTURE_SEC)
    write_wav(silence_path, silence)
    entries.append(
        {
            "name": "silence_3s",
            "file": "silence_3s.wav",
            "kind": "silence",
            "text": "",
            "scenario": "ws_no_speech",
            "durationSec": SILENCE_FIXTURE_SEC,
            "sampleRate": OUTPUT_RATE,
            "bytes": silence_path.stat().st_size,
            "sha256": sha256_of(silence_path),
            "reused": False,
        }
    )
    print(f"  [ OK ] silence_3s.wav: {SILENCE_FIXTURE_SEC:.1f} с цифровой тишины")

    manifest = build_manifest(entries, args.voice)
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"манифест: {manifest_path}")

    if failures:
        print(f"\nОШИБКА: не синтезировано фраз: {failures}", file=sys.stderr)
        return 1
    return 0


def list_fixtures() -> int:
    print("Фразы для e2e (генерируются через wyoming-piper):")
    for spec in SPEECH_FIXTURES:
        path = FIXTURES_DIR / f"{spec.name}.wav"
        status = "есть" if path.exists() else "нет"
        print(f"  {spec.name}.wav [{status}] «{spec.text}» -> {spec.scenario}")
    silence = FIXTURES_DIR / "silence_3s.wav"
    print(f"  silence_3s.wav [{'есть' if silence.exists() else 'нет'}] -> ws_no_speech")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Синтез русских WAV-фикстур через wyoming-piper",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("PULSAR_BRAIN_TTS_HOST", "127.0.0.1"),
        help="хост piper (по умолчанию PULSAR_BRAIN_TTS_HOST или 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PULSAR_BRAIN_TTS_PORT", "10200")),
        help="порт piper (по умолчанию PULSAR_BRAIN_TTS_PORT или 10200)",
    )
    parser.add_argument(
        "--voice",
        default=os.environ.get("PULSAR_BRAIN_TTS_VOICE", "ru_RU-irina-medium"),
        help="голос piper (пустая строка — голос по умолчанию)",
    )
    parser.add_argument(
        "--out-dir",
        default=str(FIXTURES_DIR),
        help="куда сохранять WAV (по умолчанию tests/fixtures)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="пересинтезировать существующие WAV",
    )
    parser.add_argument("--list", action="store_true", help="показать фразы и выйти")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.list:
        return list_fixtures()
    try:
        return asyncio.run(generate(args))
    except KeyboardInterrupt:
        print("прервано", file=sys.stderr)
        return 130
    except FixtureError as err:
        print(f"ОШИБКА: {err}", file=sys.stderr)
        print_piper_help(args.host, args.port)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
