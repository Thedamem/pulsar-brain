# dev — локальный стенд pulsar-brain

Стенд для разработки без HAOS/Supervisor: HA Core в Docker, Wyoming whisper (STT),
Wyoming piper (TTS), сам аддон и (опционально) мок-сателлит ESPHome.

```
dev/
  docker-compose.yml        # сервисы стенда
  ha-config/                # /config HA Core: runtime state (gitignored)
  bootstrap-ha.py           # onboarding HA + dev-пользователь + long-lived token
  check.sh                  # health-проверки всех сервисов
  wyoming_probe.py          # describe-запрос к whisper/piper (используется check.sh)
  .env.example              # какие переменные читают скрипты
  ha-token.txt, state.json, .env, data/   # секреты и данные, gitignored
```

## Требования

- Docker с плагином compose v2 (`docker compose version`). В этом окружении compose
  не был установлен и поставлен без root в user-level плагин:
  `apt-get download docker-compose && dpkg -x docker-compose_*.deb /tmp/compose-pkg &&
  mkdir -p ~/.docker/cli-plugins && cp /tmp/compose-pkg/usr/libexec/docker/cli-plugins/docker-compose ~/.docker/cli-plugins/`
  (Debian trixie, compose 2.26.1).
- Python-окружение `dev/.venv` (aiohttp) для `bootstrap-ha.py`. `check.sh` и
  `wyoming_probe.py` работают и на system python3.
- Свободные порты: 8124 (HA на хосте; 8123 занят socat-форвардом), 10300, 10200,
  8097, 6053, 8099.

## Запуск

```sh
cd dev
docker compose up -d ha whisper piper   # базовый стенд без аддона
docker compose logs -f ha               # HA поднимается ~40-70 с
cd .. && dev/.venv/bin/python dev/bootstrap-ha.py && dev/check.sh
                                        # ожидаем exit 0 и все [ OK ]
```

Первый старт whisper/piper скачивает модель/голос (нужна сеть: whisper
small-int8 ~500 МБ, голос piper ~60 МБ; при медленном канале это занимает
несколько минут), данные кладутся в named volumes `whisper-data` и `piper-data` —
повторно не качаются. Готовность проверяй `dev/check.sh --wait 600`.

Профили compose:

| команда | что поднимает |
|---|---|
| `docker compose up -d ha whisper piper` | HA, whisper, piper (аддон не нужен) |
| `docker compose --profile full up -d` | + аддон из `../addon` (порт 8097) |
| `docker compose --profile tools up -d` | + мок-сателлит ESPHome (6053 API, 8099 control) |
| `docker compose --profile full --profile tools up -d` | всё вместе (аддон + мок) |

Аддон собирается из `addon/Dockerfile`; пока модули аддона не готовы, сборка может
падать — это не мешает базовому стенду (`ha whisper piper`). Если на `:8097` уже
запущен аддон с хоста (`cd addon && npm run dev`), контейнер profile `full` не
займёт порт — останови dev-сервер или проверяй `/health` того, что уже слушает. Мок-сателлит
собирается из `tests/mock_satellite/Dockerfile`: ESPHome native API (plaintext) на
6053 и HTTP-control на 8099 (`GET /health`, `GET /status`, `POST /start`,
`POST /stop`, `GET /events`). По умолчанию ждёт `POST /start`; добавь `--auto-start`
в `command:` сервиса, чтобы run стартовал сразу после подписки моста. Зависимость
от аддона в compose мягкая (`required: false`), поэтому профиль `tools` работает
и без профиля `full`.

## bootstrap-ha.py

Идемпотентный скрипт. Что делает:

1. Ждёт `GET /api/onboarding` (до `DEV_HA_WAIT`, по умолчанию 180 с).
2. Завершает onboarding HA: пользователь `dev`/`devpass` (`DEV_HA_USER`/`DEV_HA_PASS`),
   шаги `core_config`, `integration`, `analytics`. API: `/api/onboarding/*`,
   `/auth/token`, `/auth/login_flow`.
3. Выпускает long-lived access token через WS `auth/long_lived_access_token` (365 дней).
4. Пишет `dev/ha-token.txt`, `dev/state.json`, `dev/.env` (chmod 600, gitignored);
   compose подхватывает `PULSAR_BRAIN_HA_TOKEN` из `dev/.env`.
5. Проверяет, что тестовые сущности HA на месте, и печатает `export`-строки.

Повторный запуск: если токен из `ha-token.txt` проходит `GET /api/`, ничего не
пересоздаётся. Если пользователь уже есть, но токен потерян — логин через
`/auth/login_flow` с `dev`/`devpass`. Пароль другой? Удали `dev/ha-config` и подними HA заново.

Переменные: `DEV_HA_URL` (default `http://127.0.0.1:8124`), `DEV_HA_USER`,
`DEV_HA_PASS`, `DEV_HA_WAIT`.

## Home Assistant конфиг

`dev/ha-config/configuration.yaml` — минимальный `default_config:` + logger/http +
тестовые устройства без железа:

| сущность | реализация | действия |
|---|---|---|
| `light.kitchen` | template light поверх `input_boolean.kitchen_light` | on/off |
| `switch.tv` | template switch поверх `input_boolean.tv_power` | on/off |
| `media_player.speaker` | template media_player поверх `input_boolean.speaker_power` + `input_number.speaker_volume` | on/off, volume_set |

Каталог `dev/ha-config/` — runtime state HA (`.storage`, БД recorder) и он
gitignored. После `rm -rf dev/ha-config` восстанови `configuration.yaml` (см.
примечание в отчёте T1: нужна правка корневого `.gitignore`, чтобы файл трекался).

## check.sh

```sh
dev/check.sh              # одна проверка
dev/check.sh --wait 180   # подождать HA до 180 с
```

Проверки: HA frontend/API (200), `GET /api/` без токена (401), REST с токеном +
тестовые сущности, Wyoming `describe` whisper (`asr`) и piper (`tts`), `/health`
аддона (если поднят, иначе SKIP), порт mock-satellite (если поднят, иначе SKIP).
Exit 0 — обязательные сервисы здоровы, exit 1 — есть FAIL. SKIP не валит проверку.

## Логи, перезапуск, сброс

```sh
docker compose ps
docker compose logs -f ha whisper piper
docker compose restart ha
docker compose down                    # остановить
docker compose down -v                 # + удалить скачанные модели whisper/piper
rm -rf dev/ha-config                   # полный сброс HA (onboarding заново)
docker compose --profile full up -d --force-recreate addon   # перечитать dev/.env с токеном
```

## Ограничения

- **Нет Supervisor**: аддон запущен отдельным контейнером, ingress и
  `SUPERVISOR_TOKEN`/`hassio_*` API не проверяются. В dev-режиме аддон получает
  `PULSAR_BRAIN_HA_URL=http://ha:8123` и `PULSAR_BRAIN_HA_TOKEN` из env; установка на
  HAOS проверяется отдельно (T12/I3).
- HA опубликован на 8124, внутри compose-сети доступен как `http://ha:8123`.
  Порт 8123 на хосте не трогаем — он занят socat.
- Мок-сателлит собирается из `tests/mock_satellite` (T2) и работает в plaintext-режиме
  ESPHome API; Noise/PSK реальной колонки стенд не воспроизводит.
- Токен HA — секрет: не коммитить, не логировать; файлы уже в `dev/.gitignore`.
