#!/usr/bin/env bash
# Wrapper for tests/e2e/run.py: keeps the venv requirement in one place.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="$ROOT_DIR/dev/.venv/bin/python"
if [ ! -x "$PY" ]; then
  PY="$(command -v python3 || true)"
fi
if [ -z "$PY" ]; then
  echo "ОШИБКА: не найден python3; создайте dev/.venv по dev/README.md" >&2
  exit 2
fi
exec "$PY" "$ROOT_DIR/tests/e2e/run.py" "$@"
