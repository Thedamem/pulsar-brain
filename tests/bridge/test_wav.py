"""RIFF/WAVE builder and parser."""

from __future__ import annotations

import struct


def test_build_and_parse_wav(component):
    pcm = b"\x01\x00" * 1600
    wav = component.wav.build_wav(pcm)
    assert len(wav) == 44 + len(pcm)
    assert wav[:4] == b"RIFF"
    assert wav[8:12] == b"WAVE"
    assert wav[12:16] == b"fmt "
    assert wav[36:40] == b"data"
    assert int.from_bytes(wav[40:44], "little") == len(pcm)
    info = component.wav.parse_wav(wav)
    assert info is not None
    assert info.sample_rate == 16000
    assert info.channels == 1
    assert info.bits_per_sample == 16
    assert info.data_size == len(pcm)
    assert abs(info.duration - 0.1) < 1e-9


def test_build_custom_format(component):
    pcm = b"\x00\x00" * 220
    wav = component.wav.build_wav(pcm, sample_rate=22050, channels=2)
    info = component.wav.parse_wav(wav)
    assert info is not None
    assert info.sample_rate == 22050
    assert info.channels == 2
    assert info.data_size == len(pcm)


def test_build_rejects_partial_frames(component):
    try:
        component.wav.build_wav(b"\x01")
    except ValueError:
        return
    raise AssertionError("partial frame was accepted")


def test_build_rejects_bad_format(component):
    for kwargs in (
        {"sample_rate": 0},
        {"channels": 0},
        {"bits_per_sample": 12},
    ):
        try:
            component.wav.build_wav(b"\x00\x00", **kwargs)
        except ValueError:
            continue
        raise AssertionError(f"accepted invalid format {kwargs}")


def test_parse_rejects_garbage(component):
    assert component.wav.parse_wav(b"") is None
    assert component.wav.parse_wav(b"not a wave file at all" + b"\x00" * 40) is None


def test_parse_rejects_truncated_data(component):
    wav = bytearray(component.wav.build_wav(b"\x00\x00" * 10))
    truncated = bytes(wav[:-4])
    assert component.wav.parse_wav(truncated) is None


def test_parse_rejects_non_pcm(component):
    wav = bytearray(component.wav.build_wav(b"\x00\x00" * 10))
    struct.pack_into("<H", wav, 20, 3)  # IEEE float
    assert component.wav.parse_wav(bytes(wav)) is None


def test_parse_rejects_empty_data_chunk(component):
    assert component.wav.parse_wav(component.wav.build_wav(b"")) is None
