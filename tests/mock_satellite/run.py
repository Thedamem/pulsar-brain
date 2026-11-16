#!/usr/bin/env python3
"""CLI entry point for the mock ESPHome voice satellite.

Examples::

    # self test, no bridge required
    dev/.venv/bin/python tests/mock_satellite/run.py --selftest

    # serve a mock column, then trigger a run over HTTP control
    dev/.venv/bin/python tests/mock_satellite/run.py \
        --wav fixtures/wake-run.wav --followup-wav fixtures/followup.wav \
        --out /tmp/tts.wav --events-json /tmp/events.json
    curl -X POST localhost:8099/start

The process is the ESPHome API server (plaintext, no Noise): point the bridge's
ESPHome client at ``--host:--port``.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import pathlib
import signal
import sys

import make_fixtures
from mock_satellite import MockConfig, MockSatellite

FIXTURES_DIR = pathlib.Path(__file__).resolve().parent / "fixtures"
LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"


def _parse_int(value: str) -> int:
    """Accept decimal and 0x-prefixed integers for flags/ports."""
    return int(value, 0)


def _parse_header(value: str) -> tuple[str, str]:
    name, separator, header_value = value.partition(":")
    if not separator or not name.strip():
        raise argparse.ArgumentTypeError(f"expected 'Name: value', got {value!r}")
    return name.strip(), header_value.strip()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Mock ESPHome voice satellite (pulsar Yandex Station Lite 2) for bridge tests.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--selftest", action="store_true", help="run the built-in protocol self test and exit")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")

    audio = parser.add_argument_group("audio")
    audio.add_argument("--wav", default=str(FIXTURES_DIR / "wake-run.wav"), help="utterance WAV, 16 kHz mono 16-bit")
    audio.add_argument(
        "--followup-wav",
        default=str(FIXTURES_DIR / "followup.wav"),
        help="follow-up utterance WAV (pass an empty string to disable follow-up)",
    )
    audio.add_argument("--out", default="mock-satellite-tts.wav", help="where to save the TTS answer downloaded from TTS_END url")
    audio.add_argument(
        "--out-streamed-wav",
        default=None,
        help="debug: also save server-streamed VoiceAssistantAudio PCM here (pulsar ignores it)",
    )
    audio.add_argument("--chunk-ms", type=int, default=32, help="microphone audio chunk size in milliseconds (32 ms = 1024 bytes)")
    audio.add_argument(
        "--pace-factor",
        type=float,
        default=1.0,
        help="playback pacing speed-up: 1.0 real time, 4.0 four times faster (tests)",
    )

    protocol = parser.add_argument_group("ESPHome device")
    protocol.add_argument("--device-name", default="yandex-lite2-000001", help="ESPHome device name")
    protocol.add_argument("--friendly-name", default="Яндекс Станция Лайт 2", help="friendly name reported in DeviceInfo")
    protocol.add_argument("--mac", default="02:00:00:00:00:01", help="MAC address reported in DeviceInfo")
    protocol.add_argument("--feature-flags", type=_parse_int, default=61, help="voice_assistant_feature_flags (61 = pulsar)")
    protocol.add_argument(
        "--wake-word-phrase",
        default="Алиса",
        help="wake_word_phrase in the first VoiceAssistantRequest (pulsar sends the detected phrase)",
    )
    protocol.add_argument(
        "--flags",
        type=_parse_int,
        default=0,
        help="flags in the first VoiceAssistantRequest; real pulsar sends 0 (USE_WAKE_WORD is 2)",
    )
    protocol.add_argument("--conversation-id", default=None, help="fixed conversation id (generated when omitted)")

    server = parser.add_argument_group("servers")
    server.add_argument("--host", default="0.0.0.0", help="ESPHome API listen address")
    server.add_argument("--port", type=_parse_int, default=6053, help="ESPHome API listen port")
    server.add_argument("--control-host", default="127.0.0.1", help="HTTP control listen address")
    server.add_argument(
        "--control-port",
        type=_parse_int,
        default=8099,
        help="HTTP control listen port (negative disables the control API)",
    )

    run = parser.add_argument_group("run triggering")
    run.add_argument(
        "--auto-start",
        action="store_true",
        help="start a run as soon as a client subscribes to the voice assistant",
    )
    run.add_argument(
        "--cancel-after-ms",
        type=int,
        default=0,
        help="send VoiceAssistantRequest(start=false) this many ms after each run starts (barge-in test; 0 = off)",
    )
    run.add_argument("--turn-timeout", type=float, default=30.0, help="seconds to wait for RUN_END per turn")
    run.add_argument("--tts-timeout", type=float, default=15.0, help="seconds to download the TTS_END url")
    run.add_argument(
        "--tts-header",
        action="append",
        type=_parse_header,
        default=[],
        metavar="NAME:VALUE",
        help="extra HTTP header for the TTS download (repeatable, e.g. Authorization)",
    )
    run.add_argument(
        "--exit-after-run",
        action="store_true",
        help="exit after a triggered run finishes (after a short grace for the client to disconnect)",
    )
    run.add_argument(
        "--exit-grace",
        type=float,
        default=0.5,
        help="seconds to wait after the run before --exit-after-run stops the process",
    )

    journal = parser.add_argument_group("journal")
    journal.add_argument("--events-json", default="mock-satellite-events.json", help="JSON journal of runs and protocol events")
    return parser


def config_from_args(args: argparse.Namespace) -> MockConfig:
    followup = args.followup_wav or None
    return MockConfig(
        device_name=args.device_name,
        friendly_name=args.friendly_name,
        mac_address=args.mac,
        feature_flags=args.feature_flags,
        host=args.host,
        port=args.port,
        control_host=args.control_host,
        control_port=args.control_port,
        wake_word_phrase=args.wake_word_phrase,
        flags=args.flags,
        conversation_id=args.conversation_id,
        wav=args.wav,
        followup_wav=followup,
        out=args.out,
        out_streamed_wav=args.out_streamed_wav,
        events_json=args.events_json,
        chunk_ms=args.chunk_ms,
        pace_factor=args.pace_factor,
        turn_timeout=args.turn_timeout,
        tts_timeout=args.tts_timeout,
        tts_headers=args.tts_header,
        cancel_after_ms=args.cancel_after_ms,
        auto_start=args.auto_start,
        exit_after_run=args.exit_after_run,
        exit_grace_s=args.exit_grace,
        verbose=args.verbose,
    )


def _resolve_audio_paths(config: MockConfig, parser: argparse.ArgumentParser) -> None:
    """Generate the bundled fixtures on demand; report anything else that is missing."""
    fixture_names = {"wake-run.wav", "followup.wav", "short.wav"}
    missing = [path for path in (config.wav, config.followup_wav) if path and not pathlib.Path(path).is_file()]
    if missing and any(pathlib.Path(path).name in fixture_names for path in missing):
        make_fixtures.generate(FIXTURES_DIR)
    for path in (config.wav, config.followup_wav):
        if path and not pathlib.Path(path).is_file():
            parser.error(f"WAV file not found: {path} (the mock needs 16 kHz mono 16-bit audio)")


async def _run(config: MockConfig) -> int:
    mock = MockSatellite(config)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, mock.request_shutdown, f"signal {sig.name}")
    await mock.run_until_shutdown()
    return mock.exit_code


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format=LOG_FORMAT,
        stream=sys.stderr,
    )
    if args.selftest:
        from selftest import run_selftest

        return asyncio.run(run_selftest(verbose=args.verbose))

    if args.chunk_ms <= 0:
        parser.error("--chunk-ms must be positive")
    if args.pace_factor <= 0:
        parser.error("--pace-factor must be positive")
    config = config_from_args(args)
    _resolve_audio_paths(config, parser)
    try:
        return asyncio.run(_run(config))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
