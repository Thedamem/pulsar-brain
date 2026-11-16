# Контракты модулей pulsar-brain

Версия протокола: **1**. Любое изменение контракта — правка этого файла + обеих сторон (Python мост
и Node-аддон) в одном коммите.

## 1. Общая схема

```
Яндекс Станция Лайт 2 (pulsar v0.5.3)
  ESPHome Native API :6053 (Noise) ──▶ Python-интеграция pulsar_brain (мост)
                                           │  WebSocket, run-на-соединение
                                           ▼
                                    Node-аддон pulsar_brain (мозг) :8097
                                    ├─ ASR  → wyoming-whisper  :10300
                                    ├─ TTS  → wyoming-piper    :10200
                                    ├─ LLM  → openai-compatible | openclaw | gemini-live | mock
                                    ├─ Tools → HA Core API, MCP, планировщик (SQLite)
                                    └─ Web UI → ingress / :8097
```

Мост не содержит бизнес-логики: не решает, что ответить, не вызывает HA-сервисы, не хранит
историю. Всё это делает аддон.

## 2. Аутентификация

- Мост → аддон: `Authorization: Bearer <bridge_token>` (HTTP и WS upgrade). Токен генерируется
  аддоном при первом старте, хранится в `/data/config.json` и показывается в UI. В dev-режиме
  значение можно задать переменной окружения `PULSAR_BRAIN_BRIDGE_TOKEN`.
- UI: за ingress HA аутентификация Supervisor; при прямом доступе — тот же `ui_token`
  (`PULSAR_BRAIN_UI_TOKEN`), передаётся как Bearer. `/health` всегда открыт.
- HA Core API из аддона: `http://supervisor/core/api`, `Authorization: Bearer
  ${SUPERVISOR_TOKEN}` (`homeassistant_api: true` в `config.yaml`). В dev-режиме —
  `PULSAR_BRAIN_HA_URL` + `PULSAR_BRAIN_HA_TOKEN`.

## 3. WS-протокол моста (run-на-соединение)

Один голосовой цикл = одно WS-соединение `GET /api/bridge/ws` (upgrade). Бинарные фреймы всегда
принадлежат текущему run; повторных подключений внутри run нет. Закрытие соединения = отмена run.

### 3.1. Мост → аддон

| type | поля | когда |
|---|---|---|
| `run.start` | `protocol:1`, `runId`, `device:{name,mac,firmware}`, `wakeWord:"alisa"`, `wakeWordPhrase` (пустая строка = кнопка/продолжение), `flags:{useWakeWord:boolean}` | сразу после upgrade |
| `text.input` | `text` | текстовый run (сервис `ask`, тест-консоль) |
| `vad.start` | `runId` | VAD моста увидел начало речи (мост только сообщает уровень/энергию, решение об endpoint у аддона) |
| `vad.end` | `runId`, `reason:"silence"` | мост увидел тишину после речи (не финальный endpoint, подсказка) |
| `speech.final` | `runId`, `text` | (опционально) мост не делает STT — не используется, оставлено для отладки |
| `run.cancel` | `runId`, `reason:"barge_in"|"device_stop"|"timeout"|"client"` | устройство прислало `handle_stop(abort=True)` или закрылся сокет |
| `run.end` | `runId`, `reason` | мост завершил run со стороны устройства |

Бинарные фреймы мост → аддон: **сырой PCM capture** `s16le`, 16 кГц, моно (как отдаёт pulsar),
чанки любого размера (pulsar присылает ~32 мс).

### 3.2. Аддон → мост

| type | поля | когда |
|---|---|---|
| `device.event` | `event`: одно из `run_start`, `stt_start`, `stt_vad_start`, `stt_end`, `intent_start`, `intent_end`, `intent_progress`, `tts_start`, `tts_stream_start`, `tts_stream_end`, `tts_end`, `run_end`, `error`; `data: Record<string,string>` | мост немедленно пересылает в ESPHome `send_voice_assistant_event`. Порядок событий задаёт аддон |
| `run.accepted` | `runId` | аддон принял run (мост не обязан ничего отправлять) |
| `error` | `code`, `message`, `fatal:boolean` | ошибка; `fatal` → мост завершает run |
| `tts.start` | `text`, `format:"wav"` | начинается передача озвучки ответа; далее идут бинарные фреймы |
| `tts.audio` | — (бинарный фрейм) | ТОЛЬКО между `tts.start` и `tts.end`: целый WAV-файл ответа (16 кГц, моно, 16 бит), может быть разбит на части |
| `tts.end` | `reason:"done"|"cancelled"|"error"` | конец передачи WAV текущего ответа |
| `run.end` | `reason` | аддон завершил run: мост шлёт `run_end` (если ещё не) и закрывает WS |

**Важно: pulsar не принимает потоковое TTS-аудио от сервера.** Он играет ответ по URL из
`TTS_END.url` (или `RUN_START.url`) через GStreamer. Поэтому мост:
1. принимает бинарные фреймы WAV между `tts.start` и `tts.end`, сохраняет во временное хранилище;
2. публикует файл по HTTP на своём HA-view (например,
   `GET /api/pulsar_brain/tts/<runId>/<hmac>.wav`, `Content-Type: audio/wav`) на адресе,
   достижимом с колонки (`internal_url` HA или override в настройках интеграции);
3. шлёт `device.event tts_start {text}`, затем `device.event tts_end {url:"<полный URL>"}`
   и сразу `device.event run_end {}`.

Pulsar сам скачивает и проигрывает WAV, сам присылает `VoiceAssistantAnnounceFinished` после
окончания проигрывания. Никакого пейсинга со стороны моста не требуется.

Правила порядка для одного turn'а: `device.event(run_start)` → `device.event(stt_start)` →
`(stt_vad_start)` → `(stt_vad_end)` → `device.event(stt_end,{text})` →
`device.event(intent_start)` → `device.event(intent_progress)` (опционально) →
`device.event(intent_end,{speech,continue_conversation})` → `tts.start` → бинарные `tts.audio` →
`tts.end` → `device.event(tts_start,{text})` → `device.event(tts_end,{url})` →
`device.event(run_end)`.

Follow-up в pulsar — это **новый run**: после окончания проигрывания ответа, если
`INTENT_END.continue_conversation=="1"` и пользователь заговорил, колонка запускает новый
`VoiceAssistantRequest(start=true)` с пустой `wake_word_phrase`. Мост открывает новое WS-run
соединение. Pulsar армит окно follow-up только если в прошлом run был `STT_VAD_START` и
`followup_duration_s>0`, поэтому мост обязан присылать STT_VAD_START/END; без VAD наш
no-speech таймер (10 с) закрывает диалог раньше watchdog. История диалога живёт в аддоне и не
сбрасывается между такими run'ами; новый wake word с непустой фразой начинает новый диалог
(см. `brain.newConversation()`).

Barge-in: pulsar прерывает воспроизведение локально и присылает `handle_stop(abort=True)`, а при
новом обращении сразу шлёт **новый** `VoiceAssistantRequest(start=true)` — поэтому на один
отменённый run мост НЕ отправляет `RUN_END` (поздний RUN_END после RUN_START нового run закрыл бы
новый диалог). Мост шлёт `run.cancel{reason}` в аддон, закрывает WS и не эхо-ответствует событиями.
Аддон обязан остановить LLM/TTS по `run.cancel`.

## 4. HTTP API аддона

Все `/api/*` требуют Bearer. JSON, ошибки: `{"error":{"code","message"}}` + HTTP-код.

| Метод и путь | Назначение |
|---|---|
| `GET /health` | `{status:"ok",version,uptimeSec}` |
| `GET /api/status` | состояние сервиса, активные run, здоровье whisper/piper/HA/провайдера, счётчики планировщика |
| `GET /api/config` | конфиг с замаскированными секретами |
| `PUT /api/config` | частичное обновление (zod-валидация); возвращает новый конфиг |
| `GET /api/providers` | реестр провайдеров и их возможности |
| `POST /api/providers/:id/test` | проверка соединения/модели |
| `GET /api/providers/:id/models` | список моделей (если провайдер умеет) |
| `GET /api/prompt` / `PUT /api/prompt` | системный промпт и доп. правила |
| `GET /api/prompt/defaults` | дефолтный промпт |
| `GET /api/tts/voices` | голоса Piper (Wyoming describe) + голоса провайдера |
| `POST /api/tts/preview` | `{text,voice}` → `audio/wav` |
| `POST /api/test/text` | прогон текста через мозг без устройства → `{text, toolCalls, timing}` |
| `POST /api/test/audio` | multipart WAV → `{transcript, text, toolCalls, timing}` |
| `GET /api/sessions` | последние run (in-memory ring + SQLite), фильтр `?limit=` |
| `GET /api/sessions/:id` | детали: transcript, intent, tool calls, ответ, тайминги |
| `GET /api/logs?after=<seq>` | журнал (ring buffer), записи `{seq,ts,level,scope,msg,data}` |
| `GET /api/logs/stream` | SSE поток лога |
| `GET/POST/PUT/DELETE /api/mcp/servers` | MCP-серверы CRUD; `POST /api/mcp/servers/:id/test` |
| `GET/POST/PUT/DELETE /api/schedules` | планировщик CRUD; `POST /api/schedules/:id/cancel|run-now` |
| `GET /api/ha/entities?domain=&q=` | список сущностей HA для алиасов/UI |
| `GET /api/ha/areas` | зоны HA |
| `WS /api/bridge/ws` | голосовой run (см. §3) |

## 5. Модули Node-аддона

```
addon/src/
  index.ts                 # composition root: config → modules → HTTP/WS → UI static
  shared/protocol.ts       # типы WS-протокола и HTTP DTO (единственный источник истины)
  shared/types.ts          # Tool, ToolContext, Provider, ProviderReply, AudioChunk, Session...
  config/schema.ts         # zod-схема конфига, defaults
  config/store.ts          # load/save /data/config.json, миграции
  secrets/crypto.ts        # AES-256-GCM master.key, маскирование
  log/logger.ts            # ring buffer + SSE + stdout
  server/http.ts           # Fastify: роуты /api
  server/bridge.ts         # WS /api/bridge/ws: приём аудио, отдача событий/аудио
  session/manager.ts       # жизненный цикл run/turn, barge-in, follow-up, таймауты
  session/history.ts       # история диалога (в памяти + SQLite)
  audio/pcm.ts             # PCM16 утилиты: resample, chunk, WAV parse/encode, RMS/VAD
  audio/vad.ts             # endpointing: начало речи, конец по тишине, max utterance
  asr/wyoming.ts           # Wyoming ASR клиент (whisper)
  tts/wyoming.ts           # Wyoming TTS клиент (piper)
  tts/provider.ts          # TTS провайдера (OpenAI /v1/audio/speech), decode → PCM16 16k
  tts/resample.ts          # ресемплинг в 16 кГц моно
  llm/registry.ts          # реестр провайдеров: id → Provider
  llm/mock.ts              # детерминированный mock: сценарии утилит/tool calls
  llm/openai.ts            # OpenAI-совместимый Chat Completions + stream + tools
  llm/openclaw.ts          # OpenClaw API
  llm/gemini-live.ts       # Gemini Live WebSocket (speech-to-speech + tools)
  brain/orchestrator.ts    # turn: prompt+history+tools → provider → tool loop → ответ
  brain/prompt.ts          # сборка системного промпта, язык, правила, few-shot
  tools/registry.ts        # регистрация/поиск инструментов, JSON-схемы
  tools/ha.ts              # ha.call_service, ha.get_state, ha.list_entities, media.*
  tools/scheduler.ts       # add_once/cancel/list для планировщика
  tools/mcp.ts             # mcp.<server>.<tool> адаптеры
  mcp/client.ts            # MCP клиент (stdio/HTTP/SSE) через @modelcontextprotocol/sdk
  scheduler/store.ts       # SQLite: one-shot таймеры, восстановление после рестарта
  scheduler/runner.ts      # срабатывание → действие (HA service/announce/mcp) + повтор
  schedule/recurring.ts    # повторяющиеся → нативная automation HA
  ha/client.ts             # HA Core API клиент (supervisor или env)
  static/ui.ts             # раздача собранного UI
addon/web/                 # SPA (Vite + React + TS), собирается в addon/web/dist
```

### 5.1. Provider (LLM)

```ts
export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  nativeAudio: boolean;   // speech-to-speech (Gemini Live)
  tts: boolean;           // умеет собственный TTS
  models: boolean;        // умеет список моделей
}
export interface ProviderContext {
  systemPrompt: string;
  history: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onDelta?(text: string): void;              // потоковый текст для UI/логов
  onSpeechAudio?(chunk: Int16Array): void;   // nativeAudio: PCM 16k моно
}
export interface ProviderReply {
  text: string;                    // финальный текст ответа
  toolCalls: ToolCall[];           // инструменты, которые надо выполнить
  speech?: string;                 // что произносить (если отличается от text)
  audio?: Int16Array[];            // nativeAudio: готовое аудио
  finish: "stop" | "tool_calls" | "length" | "error";
  usage?: { inputTokens?: number; outputTokens?: number };
}
export interface Provider {
  id: string;
  label: string;
  capabilities: ProviderCapabilities;
  health(cfg): Promise<{ok:boolean; detail?:string}>;
  listModels?(cfg): Promise<string[]>;
  generate(ctx: ProviderContext, cfg): Promise<ProviderReply>;
}
```

`brain/orchestrator` вызывает `generate`, выполняет `toolCalls` через `tools/registry`, добавляет
результаты в историю и повторяет до `finish==="stop"` или лимита итераций (по умолчанию 6).

### 5.2. Tool

```ts
export interface ToolSpec { name: string; description: string; parameters: JSONSchema }
export interface ToolContext {
  runId: string;
  ha: HaClient;
  scheduler: SchedulerApi;
  mcp: McpToolProxy;
  log: Logger;
  config: AppConfig;
}
export interface ToolResult { ok: boolean; data?: unknown; error?: string; speech?: string }
export interface Tool extends ToolSpec { execute(args: unknown, ctx: ToolContext): Promise<ToolResult> }
```

Имена: `ha.call_service`, `ha.get_state`, `ha.list_entities`, `media.play`, `media.pause`,
`media.volume`, `announce.say`, `scheduler.add_once`, `scheduler.cancel`, `scheduler.list`,
`mcp.<server>.<tool>`. MCP-инструменты регистрируются динамически из подключённых серверов.

### 5.3. Mock-провайдер (обязателен для тестов без ключей)

- Детерминированные сценарии по регулярным выражениям русского текста: включить/выключить свет,
  несколько действий, «на N минут», «в HH:MM», повторить, вопросы.
- Умеет отдавать `toolCalls` как реальный LLM, чтобы e2e проверял весь путь инструментов.
- Режим `echo` (ответ = вход) и `scripted` (список шагов из конфига) для тестов UI.
- Никаких «фейковых данных в UI»: mock помечен в интерфейсе как mock.

## 6. Python-мост (`custom_components/pulsar_brain`)

```
custom_components/pulsar_brain/
  manifest.json       # domain pulsar_brain, deps: ["esphome","http","websocket_api"], iot_class local_push
  __init__.py         # setup/unload config entry, runtime_data: BridgeClient
  config_flow.py      # host/port аддона, bridge_token, выбор ESPHome-устройства (из config entries)
  const.py
  bridge.py           # WS-клиент аддона: run.start/аудио/события/приём TTS, пейсинг
  esphome_client.py   # aioesphomeapi: подключение, subscribe_voice_assistant, события
  light.py?           # нет: только sensor/binary_sensor/button/select (диагностика)
  sensor.py, binary_sensor.py, button.py, select.py
  services.py         # pulsar_brain.ask (текстовая команда), pulsar_brain.announce
  strings.json, translations/ru.json, translations/en.json
```

- Мост при старте: находит ESPHome-устройство (host/port/noise_psk из config entry интеграции
  esphome, с fallback на ручной ввод), подключается отдельным `APIClient`, подписывается на VA.
- На `handle_start` открывает WS-run, шлёт `run.start`, пересылает аудио, события и WAV ответа.
- TTS: принимает WAV от аддона, публикует через `HomeAssistantView`
  (`/api/pulsar_brain/tts/<runId>/<hmac>.wav`), отправляет `TTS_START{text}` и
  `TTS_END{url}`. Никакого пейсинга и `send_voice_assistant_audio` для TTS.
- `handle_stop(abort=True)` → `run.cancel`; reconnect с backoff; при выключенном switch —
  отписка от VA и освобождение слота.
- Сущности: `binary_sensor.connection`, `sensor.last_transcript`, `sensor.last_response`,
  `select.provider` (пробрасывает выбор в аддон), `switch.enabled`, `button.restart_bridge`.
- Сервисы: `pulsar_brain.ask` (text → {response}), `pulsar_brain.announce`.

## 7. Локальный стенд (`dev/`)

- `docker compose up` поднимает: `ha` (homeassistant:stable, 8124, конфиг `dev/ha-config`),
  `whisper` (wyoming-whisper, ru), `piper` (wyoming-piper, ru_RU-irina-medium), `addon`
  (сборка `addon/Dockerfile`, 8097) и `mock-satellite` (`tests/mock_satellite`).
- `dev/bootstrap-ha.py` — создаёт пользователя/токен HA через onboarding API, ставит интеграцию
  `pulsar_brain` с аддоном, создаёт тестовые сущности (свет, телевизор, сцена) через
  `configuration.yaml` (перезапуск) или REST.
- `dev/check.sh` — health всех сервисов.
- `tests/e2e/` — сценарии: WAV «Алиса, включи свет» и т. п. → mock-satellite → мост → аддон →
  mock LLM → Piper → проверка событий и записанного TTS.

## 8. Запреты

- Нет `any`, `@ts-ignore`, пустых catch, TODO/заглушек в финальном коде.
- Секреты не в логи, не в git; в UI — маска.
- Мост не вызывает HA-сервисы и не ходит в LLM.
- Аддон не подключается к ESPHome напрямую.
- Никаких внешних CDN в UI.
