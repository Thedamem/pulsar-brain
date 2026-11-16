"""WAV helpers for the mock satellite.

pulsar/ESPHome voice assistant audio is raw PCM: 16 kHz, mono, signed 16-bit
little-endian.  The mock refuses anything else instead of silently resampling:
a WAV at the wrong rate would make the bridge tests fail for the wrong reason.
"""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2  # bytes per sample, s16le
CHANNELS = 1


class WavFormatError(ValueError):
    """The WAV file cannot be used as ESPHome voice assistant audio."""


@dataclass(frozen=True)
class PcmWav:
    pcm: bytes
    sample_rate: int = SAMPLE_RATE
    channels: int = CHANNELS
    sample_width: int = SAMPLE_WIDTH

    @property
    def duration_s(self) -> float:
        return len(self.pcm) / (self.sample_rate * self.channels * self.sample_width)


def wav_bytes(
    pcm: bytes,
    sample_rate: int = SAMPLE_RATE,
    channels: int = CHANNELS,
    sample_width: int = SAMPLE_WIDTH,
) -> bytes:
    """Wrap raw PCM into an in-memory RIFF/WAVE file."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return buffer.getvalue()


def read_wav(path: str) -> PcmWav:
    """Read a WAV file, requiring 16 kHz mono 16-bit PCM."""
    try:
        with wave.open(path, "rb") as wav:
            sample_rate = wav.getframerate()
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            pcm = wav.readframes(wav.getnframes())
    except (wave.Error, OSError) as err:
        raise WavFormatError(f"cannot read WAV '{path}': {err}") from err
    if (sample_rate, channels, sample_width) != (SAMPLE_RATE, CHANNELS, SAMPLE_WIDTH):
        raise WavFormatError(
            f"'{path}' is {sample_rate} Hz, {channels} ch, {sample_width * 8} bit; "
            "the mock satellite needs 16 kHz mono 16-bit s16le"
        )
    if not pcm:
        raise WavFormatError(f"'{path}' contains no audio frames")
    return PcmWav(pcm=pcm, sample_rate=sample_rate, channels=channels, sample_width=sample_width)


def is_riff_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def wav_duration_s(data: bytes) -> float | None:
    """Duration of a downloaded TTS file, or None when it is not a readable WAV."""
    if not is_riff_wav(data):
        return None
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getframerate() <= 0:
                return None
            return wav.getnframes() / wav.getframerate()
    except (wave.Error, OSError):
        return None
