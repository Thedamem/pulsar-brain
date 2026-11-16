#!/usr/bin/env bash
# Полный локальный прогон проверок pulsar-brain перед сдачей.
#
#   scripts/check-all.sh            # все проверки
#   scripts/check-all.sh --help     # эта справка
#
# Проверяет: tsc и vitest аддона, сборку SPA, py_compile моста, pytest моста,
# синтаксис всех shell-скриптов, YAML манифестов и docker build образа аддона.
# Отсутствующий каталог (например, ещё не созданный addon/web) — это SKIP с
# причиной, а не падение. Присутствующий, но падающий шаг — FAIL и exit 1.
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

IMAGE="${PULSAR_BRAIN_IMAGE:-pulsar-brain-addon:local}"

OK=0
FAILED=0
SKIPPED=0

pass() { printf '  [ OK ] %s\n' "$*"; OK=$((OK + 1)); }
fail() { printf '  [FAIL] %s\n' "$*"; FAILED=$((FAILED + 1)); }
skip() { printf '  [SKIP] %s\n' "$*"; SKIPPED=$((SKIPPED + 1)); }
section() { printf '\n%s\n' "$*"; }

case "${1:-}" in
  -h|--help)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "")
    ;;
  *)
    echo "неизвестный аргумент: $1 (см. $0 --help)" >&2
    exit 2
    ;;
esac

# ────────────────────────────────────────────────────────────── addon ──

section "Аддон: TypeScript и unit-тесты"
if [[ ! -f addon/package.json ]]; then
  skip "нет addon/package.json"
elif [[ ! -d addon/node_modules ]]; then
  echo "  … addon/node_modules отсутствует, ставлю зависимости по lock-файлу"
  if (cd addon && npm ci --no-audit --no-fund); then
    if (cd addon && npm run check); then
      pass "addon: npm run check (tsc --noEmit)"
    else
      fail "addon: npm run check (tsc --noEmit)"
    fi
    if (cd addon && npm test); then
      pass "addon: npm test (vitest run)"
    else
      fail "addon: npm test (vitest run)"
    fi
  else
    fail "addon: npm ci — check и test пропущены, зависимости не установлены"
  fi
else
  if (cd addon && npm run check); then
    pass "addon: npm run check (tsc --noEmit)"
  else
    fail "addon: npm run check (tsc --noEmit)"
  fi
  if (cd addon && npm test); then
    pass "addon: npm test (vitest run)"
  else
    fail "addon: npm test (vitest run)"
  fi
fi

# ──────────────────────────────────────────────────────────────── web ──

section "UI: сборка SPA"
if [[ ! -f addon/web/package.json ]]; then
  skip "addon/web ещё не создан (UI-модуль), сборка SPA невозможна"
elif [[ ! -d addon/web/node_modules ]]; then
  echo "  … addon/web/node_modules отсутствует, ставлю зависимости по lock-файлу"
  if (cd addon/web && npm ci --no-audit --no-fund); then
    if (cd addon/web && npm run build); then
      pass "addon/web: npm run build"
    else
      fail "addon/web: npm run build"
    fi
  else
    fail "addon/web: npm ci — сборка SPA пропущена"
  fi
else
  if (cd addon/web && npm run build); then
    pass "addon/web: npm run build"
  else
    fail "addon/web: npm run build"
  fi
fi

# ───────────────────────────────────────────────────────────── python ──

section "Мост: py_compile"
if [[ ! -d custom_components/pulsar_brain ]]; then
  skip "нет custom_components/pulsar_brain (мост ещё не создан)"
else
  shopt -s nullglob
  py_files=(custom_components/pulsar_brain/*.py)
  shopt -u nullglob
  if ((${#py_files[@]} == 0)); then
    skip "custom_components/pulsar_brain: нет *.py"
  elif python3 -m py_compile "${py_files[@]}"; then
    pass "python3 -m py_compile: ${#py_files[@]} файл(ов)"
  else
    fail "python3 -m py_compile"
  fi
fi

section "Мост: pytest"
if [[ ! -x dev/.venv/bin/pytest ]]; then
  skip "нет dev/.venv/bin/pytest (создай dev/.venv по dev/README.md)"
elif [[ ! -d tests/bridge ]]; then
  skip "нет tests/bridge (тесты моста ещё не созданы)"
else
  if pytest_out="$(dev/.venv/bin/pytest -q tests/bridge 2>&1)"; then
    pytest_status=0
  else
    pytest_status=$?
  fi
  printf '%s\n' "$pytest_out"
  case "$pytest_status" in
    0) pass "dev/.venv/bin/pytest -q tests/bridge" ;;
    5) skip "tests/bridge: тестов пока нет (pytest: no tests ran)" ;;
    *) fail "dev/.venv/bin/pytest -q tests/bridge" ;;
  esac
fi

# ───────────────────────────────────────────────────────────── shell ──

section "Синтаксис shell-скриптов"
shopt -s nullglob
shell_files=(scripts/*.sh)
if [[ -d tests/e2e ]]; then
  shell_files+=(tests/e2e/*.sh)
fi
shopt -u nullglob
if ((${#shell_files[@]} == 0)); then
  skip "нет scripts/*.sh и tests/e2e/*.sh"
else
  syntax_failed=0
  for file in "${shell_files[@]}"; do
    if ! bash -n "$file"; then
      printf '         ^ %s\n' "$file" >&2
      syntax_failed=1
    fi
  done
  if ((syntax_failed == 0)); then
    pass "bash -n: ${#shell_files[@]} скрипт(ов)"
  else
    fail "bash -n: есть синтаксические ошибки"
  fi
fi

# ─────────────────────────────────────────────────────────────── yaml ──

section "Манифесты: YAML"
if ! python3 -c 'import yaml' >/dev/null 2>&1; then
  skip "PyYAML не установлен (python3 -c 'import yaml' падает)"
else
  if yaml_out="$(
    python3 - <<'PY'
import yaml

paths = ("addon/config.yaml", "repository.yaml")
for path in paths:
    with open(path, encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: ожидался YAML-словарь, получено {type(data).__name__}")
print("YAML OK: " + ", ".join(paths))
PY
  )"; then
    pass "$yaml_out"
  else
    fail "YAML невалиден (см. ошибку выше)"
  fi
fi

# ────────────────────────────────────────────────────────────── docker ──

section "Docker-образ аддона"
if ! command -v docker >/dev/null 2>&1; then
  skip "docker не установлен"
elif ! docker info >/dev/null 2>&1; then
  skip "Docker daemon недоступен"
elif docker build -t "$IMAGE" addon; then
  pass "docker build -t $IMAGE addon"
else
  fail "docker build -t $IMAGE addon"
fi

# ────────────────────────────────────────────────────────────── итог ──

printf '\nИтог: OK=%d FAIL=%d SKIP=%d\n' "$OK" "$FAILED" "$SKIPPED"
if ((FAILED > 0)); then
  echo "Проверки не пройдены: устрани FAIL выше." >&2
  exit 1
fi
if ((SKIPPED > 0)); then
  echo "Проверки пройдены, но есть SKIP: на финальном прогоне их быть не должно."
else
  echo "Все проверки пройдены."
fi
exit 0
