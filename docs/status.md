# Статус проекта pulsar-brain

Обновлено: 2026-11-16, версия 0.1.0. Протоколы — [contracts.md](contracts.md), архитектура —
[architecture.md](architecture.md), установка — [install.md](install.md).

## Что реализовано

| Компонент | Статус | Где |
|---|---|---|
| Node-аддон (Fastify, конфиг, AES-секреты, логи/SSE, HTTP API, WS-мост) | готов | `addon/src/{config,secrets,log,server}` |
| Менеджер сессий (VAD→STT→brain→TTS, barge-in, follow-up, SQLite-история) | готов | `addon/src/session` |
| Аудио (PCM/WAV, ресемплер, VAD, Wyoming ASR/TTS, provider TTS) | готов | `addon/src/{audio,asr,tts}` |
| Провайдеры LLM: OpenAI-совместимый, OpenClaw, Gemini Live, mock | готов (кроме живых ключей) | `addon/src/llm` |
| Brain: системный промпт, tool-loop, история | готов | `addon/src/brain` |
| Инструменты HA (сервисы, состояния, медиа, announce) | готов | `addon/src/{ha,tools/ha}` |
| MCP-клиент (stdio/HTTP/SSE) и динамические инструменты | готов | `addon/src/{mcp,tools/mcp}` |
| Планировщик: one-shot SQLite + повторяющиеся → HA automation | готов | `addon/src/{scheduler,schedule,tools/scheduler}` |
| Веб-админка (10 экранов, ingress, русский) | готов | `addon/web` |
| Python-интеграция-мост (ESPHome VA, TTS URL через HA view, сущности, сервисы) | готов | `custom_components/pulsar_brain` |
| Локальный стенд (HA, whisper, piper, addon, мок-сателлит) | готов | `dev/`, `tests/mock_satellite` |
| E2E аддона без HA (10 сценариев) | готов, 10/10 | `tests/e2e` |
| E2E моста с мок-сателлитом | проверено вручную на стенде | этот документ, §2 |
| Документация (README, install, architecture, reviews) | готов | `README.md`, `docs/` |

## Что проверено и как

1. **Юнит/интеграционные тесты аддона**: `cd addon && npm run check && npm test` — tsc без ошибок,
   **300 тестов passed, 1 skipped** (live-piper под env).
2. **Тесты моста**: `dev/.venv/bin/python -m pytest -q tests/bridge` — **58 passed**;
   `python -m py_compile custom_components/pulsar_brain/*.py` — OK.
3. **E2E аддона без HA**: `dev/.venv/bin/python tests/e2e/run.py` — **10/10 passed**:
   свет, свет+ТВ, «на 10 минут», «в 22:00», follow-up-эллипсис, barge-in, тишина,
   `/api/test/text`, `/api/test/audio`, `/api/tts/preview`.
4. **E2E моста с настоящим ESPHome-протоколом (мок-сателлит) на локальном HA**:
   - интеграция установлена в HA Core, мост подключился к мок-устройству и владеет VA-слотом;
   - run «Алиса, включи свет»: STT Whisper → mock-LLM → `light.turn_on` в HA → свет включился →
     Piper TTS → мост опубликовал WAV по URL → мок скачал его **HTTP 200**;
   - follow-up «А теперь выключи» новым run: контекст сохранён, `light.turn_off` выполнен,
     TTS скачан 200; порядок событий `run_start…run_end` совпал с pulsar;
   - barge-in `cancel_after_ms`: run отменён, TTS не начинался, поздний `RUN_END` не отправлен;
   - повторная проверка после финальных правок моста: «Алиса, выключи свет» → follow-up
     «А теперь выключи», оба TTS скачаны 200, порядок событий совпадает, сущности
     `sensor.pulsar_brain_last_transcript/last_response` обновляются;
   - сервисы HA: `pulsar_brain.ask` вернул ответ, `switch.pulsar_brain_bridge_enabled`
     освобождает и возвращает VA-слот.
5. **Docker-образ аддона**: `docker build -t pulsar-brain-addon:local addon` — OK (multi-stage,
   SPA и backend собираются внутри).
6. **Полный прогон**: `scripts/check-all.sh` — **OK=8 FAIL=0 SKIP=0** (tsc+vitest, сборка SPA,
   py_compile, pytest моста, shell/YAML-синтаксис, docker build).
7. **Безопасность/протокол**: два независимых внутренних ревью (не публикуются в открытом репозитории). Исправлено по ходу: ingress-доверие только Supervisor/loopback,
   whitelist env для stdio-MCP (SUPERVISOR_TOKEN не утекает), запрет доменов
   `shell_command/python_script/hassio/homeassistant`, `SUPERVISOR_TOKEN` не уходит на чужой URL,
   `panel_admin: true`, транскрипты только в debug, отдельный fix двойной STT-сессии.

## Что не проверено (и почему)

| Пункт | Причина |
|---|---|
| Живая Яндекс Станция (Noise/PSK, реальный GStreamer-плейбек) | Нет PSK от боевого HA; стенд закрыт мок-сателлитом |
| Живые OpenAI/OpenClaw/Gemini Live | Нет ключей/эндпоинтов; модули по документации + локальные мок-серверы |
| HAOS/Supervisor: установка из репозитория, ingress, watchdog | Локальный HA Core без Supervisor; проверяется при установке на HAOS |
| `scripts/install-local.sh` end-to-end | На стенде уже стоит compose-аддон и настроенная интеграция; шаги проверены вручную |

## Известные ограничения

- **TTS буферизуется целиком** до воспроизведения (pulsar играет только по URL из `TTS_END`);
  для Gemini Live это задержка на длинных ответах.
- **Один VA-слот**: пока мост владеет устройством, штатный Assist ESPHome на этой колонке не
  работает; выключатель «Bridge enabled» освобождает слот.
- **Follow-up** — отдельный run; окно задаёт pulsar (`Follow-up duration` на устройстве), аддон
  лишь просит продолжение флагом `continue_conversation`.
- **Mock-провайдер** — тестовый; в проде выбрать реального провайдера и ключи в UI.
- Один Bearer-токен обслуживает мост и UI; при публикации стоит разделить и добавить ротацию.
- TTS-URL подписан HMAC без срока/одноразовости сверх TTL-хранилища; приемлемо для LAN.
- Транскрипты/ответы остаются в SQLite и в сенсорах HA (recorder/Nabu Casa), retention нет.

## Как запустить

```sh
# стенд
cd dev && docker compose up -d ha whisper piper
cd .. && dev/.venv/bin/python dev/bootstrap-ha.py && dev/check.sh

# аддон в контейнере + интеграция
docker compose --profile full --profile tools up -d --build
scripts/install-local.sh          # для чистой установки на стенд
```

HAOS: добавить репозиторий аддонов, установить «Pulsar Brain», взять bridge token в панели,
скопировать `custom_components/pulsar_brain` в `/config/custom_components`, перезапустить HA,
добавить интеграцию → выбрать аддон и ESPHome-устройство (PSK из существующей записи ESPHome).
Подробно — [install.md](install.md).

## Следующие шаги

1. Установить на целевой HA, указать PSK колонки.
2. Вписать реальные ключи провайдеров и прогнать живые health-проверки.
3. Проверить ingress/панель на HAOS.
4. Решить по always-on без wake word (сейчас не поддерживается прошивкой).
5. Добавить retention/приватность для истории и сенсоров.
