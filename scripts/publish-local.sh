#!/usr/bin/env bash
# Публикация репозитория pulsar-brain на локальный Forgejo.
#
#   scripts/publish-local.sh          # создать приватный репозиторий и запушить main
#   scripts/publish-local.sh --help   # эта справка
#
# Токен берётся из FORGEJO_TOKEN, иначе из dev/forgejo-token.txt (файл должен
# быть в .gitignore). Без токена скрипт печатает инструкцию и выходит с кодом 2.
#
# Скрипт создаёт приватный репозиторий через API POST /api/v1/user/repos,
# добавляет remote local (если его нет) и делает git push -u local main.
# Force-push не используется. Существующий репозиторий и remote считаются
# нормальным состоянием: повторный запуск идемпотентен.
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

FORGEJO_URL="${FORGEJO_URL:-}"
if [[ -z "$FORGEJO_URL" ]]; then
  echo "ОШИБКА: задайте FORGEJO_URL, например https://git.example.com" >&2
  exit 2
fi
FORGEJO_URL="${FORGEJO_URL%/}"
REPO_NAME="${FORGEJO_REPO:-pulsar-brain}"
TOKEN_FILE="$REPO_DIR/dev/forgejo-token.txt"
TOKEN="${FORGEJO_TOKEN:-}"

die() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

case "${1:-}" in
  -h|--help)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "")
    ;;
  *)
    echo "неизвестный аргумент: $1 (см. $0 --help)" >&2
    exit 2
    ;;
esac

[[ "$REPO_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "недопустимое имя репозитория: $REPO_NAME"
command -v curl >/dev/null 2>&1 || die "curl не найден."
command -v python3 >/dev/null 2>&1 || die "python3 не найден."
command -v git >/dev/null 2>&1 || die "git не найден."

# ─────────────────────────────────────────────────────────────── токен ──

if [[ -z "$TOKEN" && -f "$TOKEN_FILE" ]]; then
  if ! git check-ignore -q dev/forgejo-token.txt; then
    cat >&2 <<'EOF'
ОШИБКА: dev/forgejo-token.txt существует, но не исключён .gitignore.
Токен нельзя коммитить. Добавь в корневой .gitignore строку:
  dev/forgejo-token.txt
или передай токен через переменную окружения FORGEJO_TOKEN.
EOF
    exit 2
  fi
  TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
fi

if [[ -z "$TOKEN" ]]; then
  cat >&2 <<'EOF'
Не найден токен Forgejo — публикация не выполнена (exit 2).

Как получить токен:
  1. Открой ${FORGEJO_URL}/user/settings/applications
     (пользователь Ai; для командного репозитория — токен команды).
  2. Создай токен с правом write:repository (достаточно repo).
  3. Передай его одним из способов:
       export FORGEJO_TOKEN=<токен>
       scripts/publish-local.sh
     или положи в dev/forgejo-token.txt (файл должен быть в .gitignore).

Другие переменные: FORGEJO_URL (обязательна),
FORGEJO_REPO (default pulsar-brain).
EOF
  exit 2
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

api() { # api <method> <path> <output-file> [body]
  local method="$1" path="$2" out="$3" body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sS --max-time 30 -o "$out" -w '%{http_code}' \
      -X "$method" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$body" \
      "$FORGEJO_URL$path"
  else
    curl -sS --max-time 30 -o "$out" -w '%{http_code}' \
      -X "$method" \
      -H "Authorization: Bearer $TOKEN" \
      "$FORGEJO_URL$path"
  fi
}

# ─────────────────────────────────────────────────────────── владелец ──

log "Проверка токена: $FORGEJO_URL/api/v1/user"
code="$(api GET /api/v1/user "$TMP_DIR/user.json")" || die "Forgejo недоступен: $FORGEJO_URL"
if [[ "$code" != "200" ]]; then
  printf 'Ответ Forgejo (HTTP %s): %s\n' "$code" "$(head -c 500 "$TMP_DIR/user.json")" >&2
  die "токен не принят. Проверь FORGEJO_TOKEN и права write:repository."
fi
OWNER="$(
  python3 - "$TMP_DIR/user.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle)["login"])
PY
)"
[[ -n "$OWNER" ]] || die "Forgejo не вернул login пользователя."
log "Владелец репозитория: $OWNER"

# ─────────────────────────────────────────────────────────── репозиторий ──

payload="$(printf '{"name":"%s","private":true,"description":"Pulsar Brain — voice assistant brain for Yandex Station with pulsar firmware"}' "$REPO_NAME")"
log "Создание приватного репозитория $OWNER/$REPO_NAME"
code="$(api POST /api/v1/user/repos "$TMP_DIR/repo.json" "$payload")" || die "запрос создания репозитория не удался"

case "$code" in
  200|201)
    ;;
  409|422)
    log "Репозиторий уже существует, проверяю доступ"
    code="$(api GET "/api/v1/repos/$OWNER/$REPO_NAME" "$TMP_DIR/repo.json")" || die "не удалось прочитать существующий репозиторий"
    if [[ "$code" != "200" ]]; then
      printf 'Ответ Forgejo (HTTP %s): %s\n' "$code" "$(head -c 500 "$TMP_DIR/repo.json")" >&2
      die "репозиторий $OWNER/$REPO_NAME не создан и недоступен."
    fi
    ;;
  *)
    printf 'Ответ Forgejo (HTTP %s): %s\n' "$code" "$(head -c 500 "$TMP_DIR/repo.json")" >&2
    die "не удалось создать репозиторий $OWNER/$REPO_NAME."
    ;;
esac

CLONE_URL="$(
  python3 - "$TMP_DIR/repo.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle)["clone_url"])
PY
)"
[[ -n "$CLONE_URL" ]] || die "Forgejo не вернул clone_url."
log "clone_url: $CLONE_URL"

# ────────────────────────────────────────────────────────────── remote ──

if git remote get-url local >/dev/null 2>&1; then
  existing="$(git remote get-url local)"
  if [[ "$existing" != "$CLONE_URL" ]]; then
    die "remote local уже указывает на $existing, ожидался $CLONE_URL. Поправь remote вручную."
  fi
  log "remote local уже настроен"
else
  git remote add local "$CLONE_URL"
  log "добавлен remote local"
fi

# ──────────────────────────────────────────────────────── .gitignore ──

log "Проверка .gitignore для секретов и данных"
missing_ignores=()
while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  if ! git check-ignore -q "$path"; then
    missing_ignores+=("$path")
  fi
done <<'EOF'
dev/ha-config/.storage/core.config
dev/.venv/bin/python
dev/data/sessions.db
dev/ha-token.txt
EOF

if ((${#missing_ignores[@]} > 0)); then
  printf 'ОШИБКА: .gitignore не исключает:\n' >&2
  printf '  %s\n' "${missing_ignores[@]}" >&2
  die "исправь .gitignore до push, иначе секреты и runtime-данные попадут в репозиторий."
fi
log ".gitignore: ha-config, .venv, данные и токены исключены"

# ───────────────────────────────────────────────────────────────── push ──

git rev-parse --verify --quiet refs/heads/main >/dev/null || die "нет локальной ветки main."
log "git push -u local main (без force)"
ASKPASS="$TMP_DIR/askpass.sh"
cat >"$ASKPASS" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *sername*|*Username*) printf '%s\n' "${FORGEJO_GIT_USER:-git}" ;;
  *) printf '%s\n' "${FORGEJO_TOKEN:-}" ;;
esac
EOF
chmod 700 "$ASKPASS"

if ! GIT_ASKPASS="$ASKPASS" \
  GIT_TERMINAL_PROMPT=0 \
  FORGEJO_TOKEN="$TOKEN" \
  FORGEJO_GIT_USER="$OWNER" \
  git push -u local main; then
  die "git push не удался. Если это non-fast-forward — не делай force, разберись с историей вручную."
fi

printf '\nГотово: %s/%s (приватный), ветка main запушена в remote local.\n' "$OWNER" "$REPO_NAME"
printf 'Открыть: %s/%s/%s\n' "$FORGEJO_URL" "$OWNER" "$REPO_NAME"
