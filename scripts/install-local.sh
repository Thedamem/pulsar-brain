#!/usr/bin/env bash
# Идемпотентная установка pulsar-brain на локальный dev-стенд.
#
#   scripts/install-local.sh          # собрать аддон, запустить контейнер, поставить мост
#   scripts/install-local.sh --no-restart  # без перезапуска HA (HA управляется отдельно)
#   scripts/install-local.sh --help   # эта справка
#
# Что делает:
#   1. проверяет docker compose и поднятый стенд (ha, whisper, piper);
#   2. собирает образ pulsar-brain-addon:local из addon/;
#   3. пересоздаёт контейнер pulsar-brain-addon в сети стенда на порту 8097;
#   4. ждёт GET /health;
#   5. копирует custom_components/pulsar_brain в dev/ha-config/custom_components;
#   6. перезапускает Home Assistant и печатает адреса и дальнейшие шаги.
#
# Повторный запуск безопасен: контейнер пересоздаётся, данные лежат в named
# volume pulsar-brain-data и не теряются.
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

COMPOSE_FILE="$REPO_DIR/dev/docker-compose.yml"
HA_TOKEN_FILE="$REPO_DIR/dev/ha-token.txt"
HA_CONFIG_DIR="$REPO_DIR/dev/ha-config"
INTEGRATION_SRC="$REPO_DIR/custom_components/pulsar_brain"

IMAGE="${PULSAR_BRAIN_IMAGE:-pulsar-brain-addon:local}"
CONTAINER="${PULSAR_BRAIN_CONTAINER:-pulsar-brain-addon}"
VOLUME="${PULSAR_BRAIN_VOLUME:-pulsar-brain-data}"
ADDON_PORT="${PULSAR_BRAIN_ADDON_PORT:-8097}"
HEALTH_TIMEOUT="${PULSAR_BRAIN_HEALTH_TIMEOUT:-90}"
HA_URL="${DEV_HA_URL:-http://127.0.0.1:8124}"
RESTART_HA=1

log() { printf '==> %s\n' "$*"; }
die() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

while (($# > 0)); do
  case "$1" in
    -h|--help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --no-restart)
      RESTART_HA=0
      shift
      ;;
    *)
      echo "неизвестный аргумент: $1 (см. $0 --help)" >&2
      exit 2
      ;;
  esac
done

# ─────────────────────────────────────────────────────── предпосылки ──

log "Проверка Docker и docker compose"
command -v docker >/dev/null 2>&1 || die "docker не найден. Установи Docker Engine и повтори."
docker info >/dev/null 2>&1 || die "Docker daemon недоступен. Запусти Docker и повтори."
if ! docker compose version >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ОШИБКА: docker compose v2 не найден.

Плагин можно поставить без root (как на этой машине):
  apt-get download docker-compose
  dpkg -x docker-compose_*.deb /tmp/compose-pkg
  mkdir -p ~/.docker/cli-plugins
  cp /tmp/compose-pkg/usr/libexec/docker/cli-plugins/docker-compose ~/.docker/cli-plugins/
  chmod +x ~/.docker/cli-plugins/docker-compose
Подробности — dev/README.md, раздел «Требования».
EOF
  exit 1
fi
[[ -f "$COMPOSE_FILE" ]] || die "нет $COMPOSE_FILE"

log "Проверка dev-стенда (ha, whisper, piper)"
running_services="$(docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null || true)"
for service in ha whisper piper; do
  if ! grep -qx "$service" <<<"$running_services"; then
    cat >&2 <<EOF
ОШИБКА: сервис "$service" не запущен.

Подними стенд и выполни onboarding:
  cd dev && docker compose up -d ha whisper piper
  cd .. && dev/.venv/bin/python dev/bootstrap-ha.py
  dev/check.sh
Затем повтори scripts/install-local.sh.
EOF
    exit 1
  fi
done

[[ -s "$HA_TOKEN_FILE" ]] || die "нет dev/ha-token.txt. Запусти dev/.venv/bin/python dev/bootstrap-ha.py — он создаст токен HA."
HA_TOKEN="$(tr -d '\r\n' < "$HA_TOKEN_FILE")"
[[ -n "$HA_TOKEN" ]] || die "dev/ha-token.txt пуст. Перезапусти dev/.venv/bin/python dev/bootstrap-ha.py."

[[ -d "$INTEGRATION_SRC" ]] || die "нет custom_components/pulsar_brain — Python-мост ещё не создан, устанавливать нечего."
[[ -f "$INTEGRATION_SRC/manifest.json" ]] || die "в custom_components/pulsar_brain нет manifest.json — Python-мост ещё не готов к установке."

HA_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q ha)"
[[ -n "$HA_CONTAINER" ]] || die "не удалось найти контейнер Home Assistant через docker compose."

NETWORK="$(
  docker inspect "$HA_CONTAINER" | python3 -c '
import json
import sys

containers = json.load(sys.stdin)
networks = containers[0].get("NetworkSettings", {}).get("Networks") or {}
print(next(iter(networks), ""))
'
)"
if [[ -z "$NETWORK" ]]; then
  NETWORK="$(docker network ls --format '{{.Name}}' | grep -E '(^|_)dev_default$|pulsar-dev_default$' | head -n1 || true)"
fi
[[ -n "$NETWORK" ]] || die "не удалось определить сеть стенда (docker network ls | grep dev)."
log "Сеть стенда: $NETWORK"

# ───────────────────────────────────────────────────────────── образ ──

log "Сборка образа $IMAGE из addon/"
if ! docker build -t "$IMAGE" "$REPO_DIR/addon"; then
  die "сборка образа не удалась (см. вывод выше). Пока модули аддона не завершены, npm run check/build может быть красным; прогони scripts/check-all.sh."
fi

# ──────────────────────────────────────────────────────── контейнер ──

log "Пересоздание контейнера $CONTAINER"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE "[:.]${ADDON_PORT}[[:space:]]"; then
  die "порт ${ADDON_PORT} уже занят. Если это compose-аддон стенда, останови его: docker compose -f dev/docker-compose.yml stop addon. Иначе освободи порт или задай PULSAR_BRAIN_ADDON_PORT=<свободный порт>."
fi

if ! docker run -d --name "$CONTAINER" \
  --restart unless-stopped \
  --network "$NETWORK" \
  -p "${ADDON_PORT}:8097" \
  -v "${VOLUME}:/data" \
  -e TZ="${TZ:-Europe/Moscow}" \
  -e PULSAR_BRAIN_PORT=8097 \
  -e PULSAR_BRAIN_HA_URL=http://ha:8123 \
  -e "PULSAR_BRAIN_HA_TOKEN=${HA_TOKEN}" \
  -e PULSAR_BRAIN_STT_HOST=whisper \
  -e PULSAR_BRAIN_STT_PORT=10300 \
  -e PULSAR_BRAIN_TTS_HOST=piper \
  -e PULSAR_BRAIN_TTS_PORT=10200 \
  -e PULSAR_BRAIN_MOCK=1 \
  "$IMAGE" >/dev/null; then
  die "не удалось запустить контейнер. Порт ${ADDON_PORT} занят? Проверь: ss -ltnp | grep ${ADDON_PORT}"
fi

log "Ожидание /health (до ${HEALTH_TIMEOUT} с)"
deadline=$((SECONDS + HEALTH_TIMEOUT))
while :; do
  if curl -fsS --max-time 3 "http://127.0.0.1:${ADDON_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if ((SECONDS >= deadline)); then
    docker logs --tail 50 "$CONTAINER" >&2 || true
    die "аддон не ответил на http://127.0.0.1:${ADDON_PORT}/health за ${HEALTH_TIMEOUT} с."
  fi
  sleep 2
done
printf '  /health: %s\n' "$(curl -fsS --max-time 3 "http://127.0.0.1:${ADDON_PORT}/health")"

# ─────────────────────────────────────────────────────── интеграция ──

log "Установка интеграции в dev/ha-config/custom_components"
DEST_DIR="$HA_CONFIG_DIR/custom_components"
DEST="$DEST_DIR/pulsar_brain"
mkdir -p "$DEST_DIR"
case "$DEST" in
  "$HA_CONFIG_DIR"/custom_components/*) ;;
  *) die "неожиданный путь назначения: $DEST" ;;
esac
rm -rf "$DEST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a "$INTEGRATION_SRC/" "$DEST/"
else
  cp -a "$INTEGRATION_SRC" "$DEST"
fi
printf '  скопировано: %s\n' "$DEST"

if ((RESTART_HA)); then
  log "Перезапуск Home Assistant"
  docker restart "$HA_CONTAINER" >/dev/null
  deadline=$((SECONDS + 180))
  while :; do
    if curl -fsS --max-time 3 "$HA_URL/manifest.json" >/dev/null 2>&1; then
      break
    fi
    if ((SECONDS >= deadline)); then
      echo "  ВНИМАНИЕ: HA не ответил за 180 с. Проверь: docker compose -f dev/docker-compose.yml logs --tail 50 ha" >&2
      break
    fi
    sleep 3
  done
else
  log "Home Assistant не перезапускаю (--no-restart)"
fi

# ──────────────────────────────────────────────────────────── итог ──

log "Проверка данных аддона (содержимое не печатается)"
if docker exec "$CONTAINER" test -s /data/config.json 2>/dev/null; then
  echo "  /data/config.json: создан (внутри зашифрованные секреты)"
else
  echo "  /data/config.json: ещё не создан — появится после первого сохранения настроек"
fi
if docker exec "$CONTAINER" test -s /data/bridge-token.json 2>/dev/null; then
  echo "  /data/bridge-token.json: создан — это bridge token для интеграции"
else
  echo "  /data/bridge-token.json: ещё не создан"
fi

cat <<EOF

Готово.
  UI (dev):      http://127.0.0.1:${ADDON_PORT}/
  Health:        http://127.0.0.1:${ADDON_PORT}/health
  Home Assistant http://127.0.0.1:8124 (логин dev / devpass)

Дальше:
  1. HA → Настройки → Устройства и службы → Добавить интеграцию → Pulsar Brain.
  2. Адрес аддона: pulsar-brain-addon, порт 8097 (оба контейнера в сети ${NETWORK}).
  3. Bridge token: UI аддона (Настройки → Токен моста) или
       docker exec ${CONTAINER} cat /data/bridge-token.json
     Это секрет: не коммить и не вставляй в чаты. Файл config.json содержит
     зашифрованные ключи провайдеров, целиком его не печатай.
  4. В интеграции выбери ESPHome-устройство (mock-satellite или колонку pulsar).

Провайдер сейчас mock (PULSAR_BRAIN_MOCK=1): ответы детерминированные, ключи не нужны.
EOF
