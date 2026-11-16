#!/usr/bin/env bash
# Health checks for the local pulsar-brain dev stand (see dev/README.md).
#
#   dev/check.sh            # one pass over all services
#   dev/check.sh --wait 180 # wait up to 180 s for Home Assistant before checking
#
# Exit code 0: required services (HA, whisper, piper) are healthy.
# Exit code 1: at least one required check failed. Optional services (addon
# under profile "full", mock satellite under profile "tools") are reported as
# SKIP when they are not running.
set -uo pipefail

DEV_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname -- "$DEV_DIR")"

HA_URL="${DEV_HA_URL:-http://127.0.0.1:8124}"
ADDON_URL="${PULSAR_BRAIN_ADDON_URL:-http://127.0.0.1:8097}"
WHISPER_PORT="${PULSAR_BRAIN_STT_PORT:-10300}"
PIPER_PORT="${PULSAR_BRAIN_TTS_PORT:-10200}"
MOCK_SATELLITE_PORT="${MOCK_SATELLITE_PORT:-6053}"
HA_TOKEN_FILE="$DEV_DIR/ha-token.txt"
HA_WS_URL="$HA_URL"

PY="$DEV_DIR/.venv/bin/python"
if [ ! -x "$PY" ]; then
  PY="$(command -v python3 || true)"
fi

WAIT_SECONDS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --wait)
      WAIT_SECONDS="${2:-60}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "неизвестный аргумент: $1 (см. $0 --help)" >&2
      exit 2
      ;;
  esac
done

OK=0
FAILED=0
SKIPPED=0

pass() { printf '  [ OK ] %s\n' "$*"; OK=$((OK + 1)); }
fail() { printf '  [FAIL] %s\n' "$*"; FAILED=$((FAILED + 1)); }
skip() { printf '  [SKIP] %s\n' "$*"; SKIPPED=$((SKIPPED + 1)); }
section() { printf '\n%s\n' "$*"; }

curl_code() { # curl_code <url> [extra curl args...]
  local url="$1"
  shift
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" "$url" 2>/dev/null || true
}

curl_body() { # curl_body <url> [extra curl args...]
  local url="$1"
  shift
  curl -s --max-time 15 "$@" "$url" 2>/dev/null || true
}

if [ "$WAIT_SECONDS" -gt 0 ]; then
  section "Ожидание Home Assistant (до ${WAIT_SECONDS} с)…"
  deadline=$((SECONDS + WAIT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(curl_code "$HA_URL/manifest.json")" = "200" ]; then
      break
    fi
    sleep 2
  done
fi

section "Home Assistant ($HA_URL)"
ha_code="$(curl_code "$HA_URL/manifest.json")"
if [ "$ha_code" = "200" ]; then
  pass "frontend/API отвечает HTTP 200"
else
  fail "нет ответа HTTP 200 (получено: ${ha_code:-нет соединения}); посмотри: dev/check.sh --wait 180, docker compose logs ha"
fi

api_code="$(curl_code "$HA_URL/api/")"
if [ "$api_code" = "401" ]; then
  pass "GET /api/ без токена отвечает 401 (auth включён)"
else
  fail "GET /api/ без токена вернул ${api_code:-нет соединения}, ожидался 401"
fi

if [ -s "$HA_TOKEN_FILE" ]; then
  ha_token="$(tr -d '\r\n' < "$HA_TOKEN_FILE")"
  token_code="$(curl_code "$HA_URL/api/" -H "Authorization: Bearer $ha_token")"
  if [ "$token_code" = "200" ]; then
    pass "GET /api/ с токеном из dev/ha-token.txt отвечает 200"
    states="$(curl_body "$HA_URL/api/states" -H "Authorization: Bearer $ha_token")"
    entity_report="$(
      printf '%s' "$states" | "$PY" -c '
import json
import sys

expected = ("light.kitchen", "switch.tv", "media_player.speaker")
try:
    states = json.load(sys.stdin)
    present = {item.get("entity_id") for item in states}
except (json.JSONDecodeError, TypeError) as err:
    print(f"ERROR:{err}")
    raise SystemExit(0)
missing = [entity for entity in expected if entity not in present]
print("MISSING:" + ",".join(missing) if missing else "ALL")
' 2>&1
    )"
    case "$entity_report" in
      ALL) pass "тестовые сущности: light.kitchen, switch.tv, media_player.speaker" ;;
      MISSING:*)
        fail "нет тестовых сущностей ${entity_report#MISSING:}; проверь dev/ha-config/configuration.yaml и docker compose logs ha"
        ;;
      *)
        fail "не удалось прочитать /api/states: ${entity_report:-пустой ответ}"
        ;;
    esac
  else
    fail "GET /api/ с токеном вернул ${token_code:-нет соединения}; перезапусти dev/bootstrap-ha.py"
  fi
else
  skip "токен HA ещё не создан — запусти dev/.venv/bin/python dev/bootstrap-ha.py"
fi

section "Wyoming whisper (:${WHISPER_PORT})"
if whisper_out="$("$PY" "$DEV_DIR/wyoming_probe.py" --port "$WHISPER_PORT" --expect asr 2>&1)"; then
  pass "$whisper_out"
else
  fail "whisper не отвечает: $whisper_out (docker compose logs whisper; первая загрузка модели ~1-2 мин)"
fi

section "Wyoming piper (:${PIPER_PORT})"
if piper_out="$("$PY" "$DEV_DIR/wyoming_probe.py" --port "$PIPER_PORT" --expect tts 2>&1)"; then
  pass "$piper_out"
else
  fail "piper не отвечает: $piper_out (docker compose logs piper; первая загрузка голоса ~1 мин)"
fi

section "Аддон ($ADDON_URL, profile full)"
addon_code="$(curl_code "$ADDON_URL/health")"
if [ "$addon_code" = "200" ]; then
  addon_body="$(curl_body "$ADDON_URL/health")"
  addon_status="$(printf '%s' "$addon_body" | "$PY" -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except json.JSONDecodeError:
    print("")
else:
    print(payload.get("status", ""))
' 2>/dev/null)"
  if [ "$addon_status" = "ok" ]; then
    pass "/health отвечает 200 {\"status\":\"ok\"}"
  else
    fail "/health отвечает 200, но status=${addon_status:-?}: $addon_body"
  fi
elif [ "$addon_code" = "000" ] || [ -z "$addon_code" ]; then
  skip "аддон не запущен (docker compose --profile full up -d addon)"
else
  fail "/health вернул HTTP ${addon_code}"
fi

section "Mock satellite (:${MOCK_SATELLITE_PORT}, profile tools)"
if (exec 3<>"/dev/tcp/127.0.0.1/${MOCK_SATELLITE_PORT}") 2>/dev/null; then
  exec 3>&- 2>/dev/null || true
  pass "порт ${MOCK_SATELLITE_PORT} слушает (ESPHome API эмулятора)"
else
  skip "mock-satellite не запущен (docker compose --profile full --profile tools up -d mock-satellite)"
fi

printf '\nИтог: OK=%d FAIL=%d SKIP=%d\n' "$OK" "$FAILED" "$SKIPPED"
if [ "$FAILED" -gt 0 ]; then
  echo "Стенд не готов: устрани FAIL выше."
  exit 1
fi
echo "Стенд в порядке."
exit 0
