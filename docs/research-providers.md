# Исследование: провайдеры, Wyoming, MCP (2026-11-16)

## OpenClaw (github.com/openclaw/openclaw, docs.openclaw.ai)

- Gateway по умолчанию `127.0.0.1:18789`, один порт мультиплексирует WS+HTTP.
- OpenAI-совместимый endpoint **есть, но выключен по умолчанию**
  (`gateway.http.endpoints.chatCompletions.enabled`): `POST /v1/chat/completions`,
  `GET /v1/models`, `POST /v1/embeddings`; `POST /v1/responses` включается отдельно.
- Auth: `Authorization: Bearer <gateway token|password>`. Токен = полный operator-доступ.
- `model` — agent target (`openclaw/default`, `openclaw/<agentId>`), не provider model id;
  переопределение модели — заголовок `x-openclaw-model`.
- Tool calling: subset OpenAI (tools/tool_choice/role:tool/tool_call_id), `finish_reason="tool_calls"`,
  SSE `delta.tool_calls`.
- WS API: первый фрейм `connect`, затем `{type:"req",id,method,params}` / `{type:"res"}` /
  `{type:"event"}`. Методы chat.send, chat.history, chat.abort, sessions.*, tools.invoke, models.list.
- HTTP `POST /tools/invoke` всегда включён: `{tool|name, action?, args, idempotencyKey?}`.
- MCP: OpenClaw — клиент MCP-серверов; и умеет быть MCP-сервером (`openclaw mcp serve`, stdio).

Для нашего модуля: использовать OpenAI-совместимый `/v1/chat/completions` + Bearer; в UI подписать
«OpenClaw: включите chatCompletions endpoint и используйте токен gateway». Agent id передавать как
`model: "openclaw/<agent>"` или заголовком `x-openclaw-model` (в конфиге предусмотреть поле agentId).

## Gemini Live

- Endpoint (API key): `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=API_KEY`
- Актуальные модели на 2026-11: `gemini-3.8-live`, `gemini-3.8-live-extended-thinking`,
  `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-preview-12-2025`.
  Старый id `gemini-live-2.5-flash-preview` больше не в каталоге.
- Setup: `model:"models/<id>"`, `responseModalities:["AUDIO"]`, systemInstruction, tools
  (functionDeclarations), generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName.
- Аудио: вход PCM 16-bit LE, нативно 16 кГц (`audio/pcm;rate=16000`); выход **всегда 24 кГц**
  (`audio/pcm;rate=24000`).
- Сообщения: `setup`, `realtimeInput{audio|text|video}`, `clientContent{turns,turnComplete}`,
  `toolResponse{functionResponses}`, входящие `serverContent{modelTurn.parts[].inlineData,
  inputTranscription, outputTranscription, turnComplete, interrupted}`, `toolCall`, `goAway`,
  `sessionResumptionUpdate`.
- Прерывание: `serverContent.interrupted=true` → остановить воспроизведение и очистить очередь.
- Лимиты: аудиосессия 15 мин, соединение ~10 мин, resumption token 2 ч; нужен reconnect.

## Wyoming

- Протокол: TCP, JSONL-заголовок `{type,data,data_length,payload_length}\n` + бинарный PCM payload.
  Без auth/шифрования (только доверенная сеть).
- Python: `wyoming` 1.11.0 (github.com/OHF-voice/wyoming), event-API:
  ASR `Describe → Transcribe(language) → AudioStart(rate,width,channels) → AudioChunk → AudioStop → Transcript`;
  TTS `Synthesize(text,voice) → AudioStart/AudioChunk/AudioStop`.
- Порты: faster-whisper 10300, piper 10200.
- **Готовой production Node.js реализации нет** (`wyoming` 0.1.0 WIP, `wyoming-js` alpha) —
  пишем собственный минимальный JSONL-клиент (это и запланировано в addon/src/asr, tts).

## MCP

- Установлен `@modelcontextprotocol/sdk` 1.32.2 (v1.x): `Client` из
  `@modelcontextprotocol/sdk/client/index.js`, транспорты
  `client/streamableHttp.js`, `client/sse.js`, `client/stdio.js`. Методы
  `listTools/callTool/listResources/readResource/listPrompts/getPrompt`.
- v2 (spec 2026-07-28) разделил пакеты (`@modelcontextprotocol/server`/`client`); миграция позже,
  сейчас v1 стабильна и поддерживается минимум 6 месяцев.
- HA MCP Server (официальная интеграция core): Streamable HTTP, `http://<ha>:8123/api/mcp`,
  OAuth, admin. Тулзы = Assist API; можно подключать как внешний MCP-сервер.

## OpenAI-совместимые TTS/STT

- OpenAI: `POST /v1/audio/speech` (`response_format` mp3|opus|aac|flac|wav|pcm; input ≤ 4096 симв.;
  `pcm` = 24 кГц 16-bit mono LE). tts-1/tts-1-hd/gpt-4o-mini-tts deprecated (shutdown 2027-01-06) —
  предусмотреть конфигурируемую модель.
- Ollama `/v1`: `api_key` обязателен синтаксически, игнорируется; TTS default **wav**, есть pcm.
  STT `/v1/audio/transcriptions` (json|text|...).
- LM Studio `/v1`: audio endpoints в доках нет.
- OpenRouter: `https://openrouter.ai/api/v1`, Bearer + опциональные заголовки, модели namespaced.

## Риски

- OpenClaw OpenAI-совместимость выключена по умолчанию и токен даёт полный доступ.
- Gemini Live preview-модели и жёсткий output 24 кГц; лимит сессии — нужен reconnect/resumption.
- Wyoming без auth — не выставлять наружу.
- TTS провайдера нужно просить в wav/pcm; mp3 требует декодера (не тянем).
