# OpenClaw для модуля llm/openclaw.ts

Полная выжимка: [research-providers.md](research-providers.md) §1. Коротко:

- Gateway: `127.0.0.1:18789` по умолчанию (мультиплексирует WS+HTTP), bind loopback.
- OpenAI-совместимый endpoint **выключен по умолчанию**:
  `gateway.http.endpoints.chatCompletions.enabled: true`. После включения:
  `POST /v1/chat/completions`, `GET /v1/models`, `POST /v1/embeddings`.
- Auth: `Authorization: Bearer <gateway token|password>`. Это operator-доступ.
- `model` в запросе — **agent target**, не id модели: `openclaw/default`, `openclaw/<agentId>`,
  `agent:<agentId>`. Провайдерскую модель переопределяет заголовок `x-openclaw-model`.
- Сессия: OpenAI-поле `user` (`user: "pulsar:<runId>"`) или `x-openclaw-session-key`;
  agent id можно дублировать заголовком `x-openclaw-agent-id`.
- Tool calling: стандартный OpenAI subset, `finish_reason: "tool_calls"`, SSE `delta.tool_calls`.
- Лимиты: тело 20 MB, 60 с на чтение тела.

Реализация: используем общий OpenAI-совместимый клиент (`llm/openai.ts`) с:
`baseUrl` из конфига (например `http://<IP OpenClaw>:18789/v1`), `model` = `openclaw/default`
или `openclaw/<agentId>`, extraHeaders `x-openclaw-model` (если задан) и
`x-openclaw-agent-id` (если задан), `user: "pulsar:<runId>"`.
Проверить вживую нельзя: локальный инстанс OpenClaw (`<IP OpenClaw>`) сейчас недоступен, ключей нет.
В отчёте помечать как «по документации, не проверено».
