"""Minimal RIFF/WAVE helpers for the bridge.

Pure module without Home Assistant imports. The addon sends a complete 16 kHz mono
s16le WAV answer; the bridge validates it before publishing it to the speaker.
"""

from __future__ import annotations

from dataclasses import dataclass
import struct

WAV_HEADER_BYTES = 44
PCM_FORMAT = 1
EXTENSIBLE_FORMAT = 0xFFFE


@dataclass(frozen=True)
class WavInfo:
    """Parsed WAV payload facts."""

    sample_rate: int
    channels: int
    bits_per_sample: int
    data_size: int

    @property
    def duration(self) -> float:
        """Duration in seconds."""
        block_align = self.channels * self.bits_per_sample // 8
        if block_align <= 0 or self.sample_rate <= 0:
            return 0.0
        return self.data_size / (block_align * self.sample_rate)


def build_wav(
    pcm: bytes,
    *,
    sample_rate: int = 16000,
    channels: int = 1,
    bits_per_sample: int = 16,
) -> bytes:
    """Wrap raw little-endian PCM in a RIFF/WAVE container."""
    if sample_rate <= 0 or sample_rate > 384000:
        raise ValueError("invalid sample rate")
    if channels <= 0 or channels > 8:
        raise ValueError("invalid channel count")
    if bits_per_sample <= 0 or bits_per_sample % 8 != 0:
        raise ValueError("invalid sample width")
    block_align = channels * bits_per_sample // 8
    if len(pcm) % block_align != 0:
        raise ValueError("PCM length is not a whole number of frames")
    byte_rate = sample_rate * block_align
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        PCM_FORMAT,
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        len(pcm),
    )
    return header + pcm


def parse_wav(data: bytes) -> WavInfo | None:
    """Parse a RIFF/WAVE payload, returning None when it is not playable PCM."""
    if len(data) < WAV_HEADER_BYTES or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None

    offset = 12
    fmt: tuple[int, int, int, int, int] | None = None
    data_size: int | None = None
    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        chunk_size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        body = offset + 8
        end = body + chunk_size
        if end > len(data):
            return None
        if chunk_id == b"fmt ":
            if chunk_size < 16:
                return None
            audio_format, channels, sample_rate, byte_rate, block_align, bits = (
                struct.unpack("<HHIIHH", data[body : body + 16])
            )
            if audio_format not in (PCM_FORMAT, EXTENSIBLE_FORMAT):
                return None
            if channels <= 0 or sample_rate <= 0 or bits <= 0 or bits % 8 != 0:
                return None
            if block_align != channels * bits // 8 or block_align <= 0:
                return None
            if byte_rate != sample_rate * block_align:
                return None
            fmt = (channels, sample_rate, bits, block_align, byte_rate)
        elif chunk_id == b"data" and data_size is None:
            data_size = chunk_size
        offset = end + (chunk_size & 1)

    if fmt is None or data_size is None or data_size <= 0:
        return None
    channels, sample_rate, bits, _block_align, _byte_rate = fmt
    return WavInfo(
        sample_rate=sample_rate,
        channels=channels,
        bits_per_sample=bits,
        data_size=data_size,
    )
