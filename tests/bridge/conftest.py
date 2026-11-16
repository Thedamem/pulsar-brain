"""Test configuration for the bridge tests.

The integration package imports Home Assistant in __init__.py, which is not available in
the dev venv. Pure modules are loaded as submodules of a synthetic package so their
relative imports work without executing the HA-facing __init__.py.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import types

import pytest

COMPONENT_DIR = (
    Path(__file__).resolve().parents[2] / "custom_components" / "pulsar_brain"
)
PURE_MODULES = (
    "const",
    "events",
    "wav",
    "protocol",
    "tts_store",
    "bridge",
    "esphome_client",
)


def _ensure_package() -> types.ModuleType:
    package = sys.modules.get("pulsar_brain")
    if package is None:
        package = types.ModuleType("pulsar_brain")
        setattr(package, "__path__", [str(COMPONENT_DIR)])
        package.__package__ = "pulsar_brain"
        sys.modules["pulsar_brain"] = package
    return package


def load_component_module(name: str) -> types.ModuleType:
    """Load one file from custom_components/pulsar_brain as pulsar_brain.<name>."""
    _ensure_package()
    full_name = f"pulsar_brain.{name}"
    existing = sys.modules.get(full_name)
    if existing is not None:
        return existing
    path = COMPONENT_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(full_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[full_name] = module
    spec.loader.exec_module(module)
    return module


class _Component:
    const: types.ModuleType
    events: types.ModuleType
    wav: types.ModuleType
    protocol: types.ModuleType
    tts_store: types.ModuleType
    bridge: types.ModuleType
    esphome_client: types.ModuleType


@pytest.fixture(scope="session")
def component() -> _Component:
    """All pure bridge modules, loaded once."""
    loaded = _Component()
    for name in PURE_MODULES:
        setattr(loaded, name, load_component_module(name))
    return loaded
