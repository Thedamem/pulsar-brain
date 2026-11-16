#!/usr/bin/env python3
"""Generate synthetic 16 kHz mono WAV fixtures for the mock satellite.

Real end-to-end tests need human speech WAVs (they are provided separately).
These fixtures are only signals with a known duration and sample count, so the
protocol tests can check exact byte counts without depending on an ASR engine.
"""

from __future__ import annotations

import argparse
import math
import pathlib
import sys

from wav_utils import SAMPLE_RATE, wav_bytes

FIXTURES_DIR = pathlib.Path(__file__).resolve().parent / "fixtures"

# Amplitude of the synthetic tone, in full-scale units (0..1).
AMPLITUDE = 0.30
# Linear fade in/out, so the tone starts and ends at zero without a click.
FADE_S = 0.005


def tone_pcm(freq_hz: float, duration_s: float, amplitude: float = AMPLITUDE) -> bytes:
    """Sine tone as s16le PCM with a short fade, ready for a 16 kHz WAV."""
    frames = int(SAMPLE_RATE * duration_s)
    fade_frames = max(1, int(SAMPLE_RATE * FADE_S))
    samples = bytearray(frames * 2)
    for index in range(frames):
        envelope = 1.0
        if index < fade_frames:
            envelope = index / fade_frames
        elif index >= frames - fade_frames:
            envelope = (frames - 1 - index) / fade_frames
        value = int(amplitude * envelope * 32767 * math.sin(2 * math.pi * freq_hz * index / SAMPLE_RATE))
        samples[index * 2 : index * 2 + 2] = value.to_bytes(2, "little", signed=True)
    return bytes(samples)


def silence_pcm(duration_s: float) -> bytes:
    return b"\x00\x00" * int(SAMPLE_RATE * duration_s)


def fixture_payloads() -> dict[str, bytes]:
    """name -> WAV file bytes. Durations are visible in the name comments."""
    return {
        # Wake word "Алиса" + command, then the pause before the endpoint.
        "wake-run.wav": wav_bytes(tone_pcm(440.0, 0.6) + silence_pcm(0.4)),
        # Follow-up phrase ("а теперь выключи") without a wake word.
        "followup.wav": wav_bytes(tone_pcm(660.0, 0.5) + silence_pcm(0.3)),
        # Short utterance for cancellation/slot tests.
        "short.wav": wav_bytes(tone_pcm(880.0, 0.1) + silence_pcm(0.05)),
    }


def generate(out_dir: pathlib.Path, force: bool = False) -> list[pathlib.Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[pathlib.Path] = []
    for name, payload in fixture_payloads().items():
        path = out_dir / name
        if force or not path.exists() or path.read_bytes() != payload:
            path.write_bytes(payload)
            written.append(path)
    return written


def ensure(out_dir: pathlib.Path = FIXTURES_DIR) -> pathlib.Path:
    """Generate missing fixtures; called by --selftest so it works on a clean checkout."""
    generate(out_dir)
    return out_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate 16 kHz mono WAV fixtures for the mock satellite")
    parser.add_argument("--out-dir", type=pathlib.Path, default=FIXTURES_DIR, help="target directory")
    parser.add_argument("--force", action="store_true", help="rewrite files even when they are up to date")
    args = parser.parse_args(argv)

    written = generate(args.out_dir, force=args.force)
    for path in written:
        print(f"wrote {path} ({path.stat().st_size} bytes)")
    if not written:
        print(f"fixtures in {args.out_dir} are up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
