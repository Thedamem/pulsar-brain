"""Mock ESPHome voice satellite used by the pulsar_brain bridge tests.

Modules are run as scripts from this directory (``python run.py``), so they
import each other by plain module name; this file only marks the directory as
the test package and documents the entry points.
"""

__all__ = [
    "esphome_protocol",
    "make_fixtures",
    "mock_satellite",
    "run",
    "selftest",
    "wav_utils",
]
