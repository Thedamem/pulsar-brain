# AGENTS.md — правила репозитория pulsar-brain

Это контракт для агентов и людей. Архитектура — [docs/architecture.md](docs/architecture.md),
протоколы и интерфейсы — [docs/contracts.md](docs/contracts.md), установка —
[docs/install.md](docs/install.md). Если текст расходится с кодом,
источник истины — контракт; расхождение исправляется в том же коммите.

## Что это

- `addon/` — HA-аддон (Node.js 22 + TypeScript): «мозг» голосового ассистента. Вся бизнес-логика,
  провайдеры, STT/TTS, инструменты, MCP, планировщик, веб-админка.
- `custom_components/pulsar_brain/` — Python-интеграция HA: только мост к колонке (ESPHome VA).
- `dev/` — локальный стенд (HA Core, whisper, piper, аддон).
- `tests/` — мок-сателлит, unit и e2e тесты.

## Команды

```sh
cd addon && npm run check    # tsc --noEmit, обязателен перед сдачей
cd addon && npm test         # vitest run
cd addon && npm run build    # tsc → dist
dev/.venv/bin/pytest -q tests/bridge
dev/check.sh                 # поднятый стенд
tests/e2e/run.sh
```

## Правила работы

1. **Только свой write scope.** Файлы вне scope не редактируются. Нужен общий файл — сообщение
   Lead'у, правку делает владелец.
2. **`addon/src/shared/protocol.ts` и `addon/src/shared/types.ts` — зона Lead.** Модули импортируют
   типы оттуда и не импортируют файлы других модулей (связывание — в `addon/src/index.ts`, его
   пишет Lead). Если интерфейса не хватает — сообщение Lead'у, не правка shared.
3. **`addon/src/index.ts`, `addon/package.json`, `addon/package-lock.json`, `addon/tsconfig.json` —
   зона Lead.** Не запускать `npm install`; нужна зависимость — запрос Lead'у.
4. **Git — зона Lead.** Никаких commit/push/reset от исполнителей. `git status`/`git diff` можно.
5. **Без заглушек.** Никаких `TODO`, `throw new Error("not implemented")`, фейковых данных в UI,
   заглушек вместо логики. Не сделано — так и написано в отчёте.
6. **Типы и ошибки.** Никаких `any`, `@ts-ignore`, пустых `catch`, подавления ошибок. Ошибки
   логируются и возвращаются вызывающему. Все внешние входы валидируются zod/схемами.
7. **Секреты.** Ключи/токены только в `/data/config.json` и env; в логи, ответы API и git — никогда.
   В UI — маска.
8. **Язык.** Интерфейс и тексты для пользователя — русский. Код, имена, комментарии — английский.
   Комментарии только про неочевидные ограничения и инварианты.
9. **Проверка перед сдачей.** Свой модуль: `npm run check`, свои тесты `npx vitest run <файл>`,
   для UI — сборка и браузер на 360/768/1440. В отчёте — точные команды и результаты.
10. **Координация.** Статус — через team task (claim → работа → complete). Блокер — сообщение
    Lead'у с конкретикой. Работать до конца, не останавливаться на «план готов».
11. **Никаких внешних CDN и тяжёлых UI-библиотек.** UI собирается Vite в `addon/web/dist`.
12. **Совместимость.** Node >= 22 (в аддоне 22), Python >= 3.12 (в HA), HA >= 2025.x.

## Карта репозитория

```
addon/
  config.yaml, Dockerfile, package.json, tsconfig.json
  src/
    index.ts                  # composition root (Lead)
    shared/{types,protocol}.ts# контракты (Lead)
    config/, secrets/, log/   # addon-core
    server/                   # addon-core
    session/                  # addon-session
    audio/, asr/, tts/        # addon-audio
    llm/, brain/              # addon-llm
    tools/{registry,ha}.ts, ha/client.ts   # addon-tools-ha
    mcp/, tools/mcp.ts        # addon-tools-mcp
    scheduler/, schedule/, tools/scheduler.ts # addon-scheduler
  tests/                      # unit-тесты модулей + integration (qa)
  web/                        # SPA (addon-ui), собирается в web/dist
custom_components/pulsar_brain/   # bridge-python
dev/                          # dev-stack
tests/mock_satellite/         # mock-satellite
tests/e2e/                    # qa-e2e
scripts/                      # packaging-deploy
docs/                         # контракты, установка, исследования
```

## Приёмка

Задача сделана, когда: поведение работает; `npm run check` и относящиеся тесты зелёные; изменения
прочитаны владельцем; нет debug-логов, мёртвого кода и выхода за scope; отчёт содержит команды,
результаты и явно перечисленное непроверенное.
