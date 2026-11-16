# Мок-сателлит ESPHome (эмулятор колонки с pulsar)

Эмулятор Яндекс Станции Лайт 2 с прошивкой [pulsar](https://github.com/Morvex885/pulsar)
для тестов Python-моста `custom_components/pulsar_brain` без реальной колонки.

Мок — это ESPHome-устройство: он поднимает **TCP-сервер ESPHome Native API в plaintext-режиме**
(без Noise, без PSK) и ведёт себя как сателлит pulsar 0.5.3. Настоящий мост подключается к нему
как к колонке. Home Assistant, аддон и реальное устройство для `--selftest` не нужны.

Проверено на `aioesphomeapi 46.30.0` (Python 3.13, `dev/.venv`); в Docker — Python 3.12.

## Быстрый старт

```sh
# Самопроверка: поднимает мок, подключает настоящий клиент aioesphomeapi,
# прогоняет run + follow-up + отмену + перехват слота. Ничего снаружи не нужно.
dev/.venv/bin/python tests/mock_satellite/run.py --selftest

# Поднять мок и ждать подключения моста (ESPHome API на 0.0.0.0:6053,
# HTTP-управление на 127.0.0.1:8099).
dev/.venv/bin/python tests/mock_satellite/run.py \
  --wav tests/mock_satellite/fixtures/wake-run.wav \
  --followup-wav tests/mock_satellite/fixtures/followup.wav \
  --out /tmp/pulsar-brain/tts.wav \
  --events-json /tmp/pulsar-brain/events.json

# В другом терминале: мост подключается к 127.0.0.1:6053 и подписывается на VA.
# Затем запуск реплики:
curl -X POST http://127.0.0.1:8099/start
```

Для мока в Docker:

```sh
docker build -t pulsar-brain-mock-satellite tests/mock_satellite
docker run --rm -p 6053:6053 -p 8099:8099 -v "$PWD/mock-data:/data" pulsar-brain-mock-satellite
```

В `dev/docker-compose.yml` это сервис `mock-satellite` (`build: ../tests/mock_satellite`);
добавьте ему `--auto-start` в `command`, если нужно, чтобы реплика пошла сразу после подписки моста.

## Требования к WAV

Только **16 кГц, моно, 16 бит, little-endian (s16le)** — как сырой PCM в ESPHome voice assistant.
Другой формат мок отвергает с понятной ошибкой (`bad_wav`), без неявного ресемплинга: иначе тесты
моста падали бы не на том, что сломано.

```sh
ffmpeg -i запись.m4a -ar 16000 -ac 1 -c:a pcm_s16le fixtures/фраза.wav
```

Синтетические фикстуры (тон + пауза, речь не нужна) создаёт `make_fixtures.py`:

```sh
dev/.venv/bin/python tests/mock_satellite/make_fixtures.py --force
```

`fixtures/wake-run.wav` (1 с, «Алиса, …»), `fixtures/followup.wav` (0.8 с, продолжение),
`fixtures/short.wav` (0.15 с, для теста отмены).

## Как работает голосовой цикл

Со стороны моста (ESPHome-клиент от Home Assistant):

1. TCP-подключение на `--port` (по умолчанию 6053), фреймы `0x00 + varint(длина) + varint(тип) +
   protobuf` — `HelloRequest/Response`, `DeviceInfoRequest/Response`,
   `ListEntitiesRequest → ListEntitiesDoneResponse` (сущностей нет), `SubscribeVoiceAssistantRequest`.
2. Слот voice assistant принадлежит **последнему подписчику** среди ещё подписанных; отписка или
   отключение возвращает слот предыдущему (как `voice_choice` в pulsar).
3. По `POST /start` мок отправляет `VoiceAssistantRequest(start=true, flags=0,
   wake_word_phrase="Алиса", audio_settings)` и стримит WAV как `VoiceAssistantAudio` чанками
   32 мс (1024 байта) с реальным пейсингом (ускоряется `--pace-factor`).
   `flags=0` — как у pulsar: wake word обрабатывает сама колонка, VAD — на стороне HA.
4. Мост/аддон присылает `VoiceAssistantEventResponse` (`run_start … tts_end … run_end`). Мок
   логирует все события в журнал и **не диктует их порядок**.
5. **TTS мок забирает по URL из `TTS_END`**, а не из потокового `VoiceAssistantAudio`: реальный
   pulsar игнорирует server→device аудио и проигрывает `TTS_END.url` через GStreamer/HTTP.
   Мок делает HTTP GET этого url, сохраняет ответ в `--out` и проверяет, что это RIFF/WAVE.
   Время «проигрывания» (длительность WAV, делённая на `--pace-factor`) выдерживается, чтобы
   продолжение диалога наступало в реалистичный момент.
   Если сервер всё же пришлёт потоковое `VoiceAssistantAudio`, мок его принимает, считает
   (`summary.streamedAudioBytes`) и пишет в `--out-streamed-wav` для отладки — но ответом это
   не считается.
6. Follow-up — **новый run**: если в `INTENT_END` было `continue_conversation=1` и задан
   `--followup-wav`, после проигрывания ответа мок отправляет новый
   `VoiceAssistantRequest(start=true, wake_word_phrase="")` и стримит вторую фразу. Это новый
   записи `runs[]` в журнале, то же TCP-соединение и тот же `conversation_id`.
7. Отмена/barge-in: `--cancel-after-ms` (или `POST /stop`) шлёт
   `VoiceAssistantRequest(start=false)` посреди реплики; клиент получает `handle_stop(abort=True)`.

После проигранного ответа мок, как pulsar, отправляет `VoiceAssistantAnnounceFinished(success=true)`:
HA/мост держит состояние «responding» до этого сообщения.

## CLI

| Аргумент | По умолчанию | Назначение |
|---|---|---|
| `--wav PATH` | `fixtures/wake-run.wav` | реплика, 16 кГц моно s16le |
| `--followup-wav PATH` | `fixtures/followup.wav` | вторая реплика; пустая строка отключает follow-up |
| `--out PATH` | `mock-satellite-tts.wav` | куда сохранить TTS-ответ, скачанный по url |
| `--out-streamed-wav PATH` | — | отладка: сохранить потоковое `VoiceAssistantAudio` (pulsar его игнорирует) |
| `--events-json PATH` | `mock-satellite-events.json` | журнал прогонов и протокольных событий |
| `--host`, `--port` | `0.0.0.0`, `6053` | ESPHome API (plaintext) |
| `--control-host`, `--control-port` | `127.0.0.1`, `8099` | HTTP-управление; отрицательный порт выключает |
| `--device-name` | `yandex-lite2-000001` | имя ESPHome-устройства |
| `--friendly-name`, `--mac` | Станция Лайт 2, `02:00:00:00:00:01` | поля `DeviceInfoResponse` |
| `--feature-flags` | `61` | `voice_assistant_feature_flags` как у pulsar |
| `--wake-word-phrase` | `Алиса` | `wake_word_phrase` первого запроса |
| `--flags` | `0` | flags первого запроса (у pulsar 0; `USE_WAKE_WORD=2` — только для экспериментов) |
| `--conversation-id` | генерируется | фиксированный `conversation_id` |
| `--chunk-ms` | `32` | размер чанка микрофона (32 мс = 1024 байта) |
| `--pace-factor` | `1.0` | >1 — ускорить стрим и проигрывание (тесты) |
| `--turn-timeout` | `30` | сколько ждать `run_end` на один turn |
| `--tts-timeout` | `15` | таймаут скачивания TTS url |
| `--tts-header "Name: value"` | — | доп. HTTP-заголовок для скачивания (например, `Authorization`); можно повторять |
| `--auto-start` | выкл. | запустить реплику сразу после подписки на VA |
| `--cancel-after-ms` | `0` | отменить каждый run через N мс (тест barge-in) |
| `--exit-after-run` | выкл. | завершить процесс после прогона (скрипты/CI) |
| `--selftest` | — | встроенная проверка, exit 0/1 |
| `-v/--verbose` | — | debug-логи |

## HTTP-управление

Слушает `--control-host:--control-port` (по умолчанию `127.0.0.1:8099`).

| Метод | Назначение |
|---|---|
| `GET /health` | `{"status":"ok","device":…,"state":"idle"\| "running"}` |
| `GET /status` | состояние, клиенты, владелец слота VA, текущий прогон, счётчики |
| `GET /events` | тот же журнал, что пишется в `--events-json`, в памяти |
| `POST /start` | запустить реплику; тело JSON необязательно |
| `POST /stop` | отправить `VoiceAssistantRequest(start=false)` |

```sh
curl -s -X POST http://127.0.0.1:8099/start \
  -H 'Content-Type: application/json' \
  -d '{"wav": "/tmp/фраза.wav", "followup_wav": "", "cancel_after_ms": 0}'

curl -s http://127.0.0.1:8099/status
curl -s http://127.0.0.1:8099/events | jq '.summary'
```

`POST /start` отвечает `409` с кодом `no_subscriber`, если мост ещё не подписался на VA, и `409`
`busy`, если прогон уже идёт. Ошибка формата WAV — `400 bad_wav`; `followup_wav: ""` отключает
продолжение для этого прогона.

## Совместный dev-стенд (`dev/docker-compose.yml`)

Сервис `mock-satellite` (profile `tools`) — долгоживущий контейнер: между прогонами он не
перезапускается, поэтому состояние (подключения, слот VA, журнал, счётчики) сохраняется.

* `POST /start` можно вызывать многократно; журнал и счётчики накапливаются, а `--out` нумерует
  файлы (`/data/tts.wav`, `/data/tts-2.wav`, …), ничего не затирая.
* Активный прогон отменяется `POST /stop`; это не сбрасывает подключения и слот voice assistant.
* Полностью чистый стейт (пустой слот, новый журнал, счётчики с нуля) — перезапуск контейнера:
  `docker compose --profile tools restart mock-satellite`. После перезапуска мост должен заново
  подписаться на voice assistant.
* Владелец слота виден в `GET /status` (`voiceOwner`) и в `connections` журнала: VA обслуживает
  **последний** подписчик, поэтому клиент, подключившийся позже, перехватит следующий прогон.
  e2e-тесту перед `POST /start` стоит проверить `voiceOwner`, а если там чужой клиент —
  дождаться его отписки или перезапустить мок.
* `GET /health` и TCP-проба 6053 (её использует `dev/check.sh`) состояние не меняют.
  `dev/check.sh` проверяет мок только по TCP, чтобы не трогать чужие прогоны.
* `/data/events.json` и `/data/tts*.wav` лежат в volume контейнера; при перезапуске процесса
  журнал перезаписывается заново, TTS-файлы нумеруются снова.

## Журнал `--events-json`

Один JSON-документ, перезаписывается атомарно после каждого прогона и при остановке:

```jsonc
{
  "mockSatellite": { "deviceName": "yandex-lite2-000001", "apiVersion": "1.15",
                     "tcpPort": 6053, "wav": "…", "chunkBytes": 1024, … },
  "connections": [ { "id": 1, "peer": "127.0.0.1:54321", "helloAt": "…",
                     "subscribedAt": "…", "voiceSubscriptionFlags": 4 } ],
  "runs": [
    {
      "index": 1,                 // сквозной номер device-run (start=true)
      "trigger": 1,               // номер POST /start
      "turn": 1,                  // 1 — реплика, 2 — follow-up
      "conversationId": "mock-…",
      "wav": "…/wake-run.wav",
      "wakeWordPhrase": "Алиса",  // у follow-up ""
      "flags": 0,
      "startedAt": "…", "endedAt": "…", "state": "ended", "endReason": "run_end",
      "audioBytesSent": 32000, "audioChunksSent": 32,
      "continueConversation": true,
      "tts": [ { "url": "http://…/tts.wav", "status": 200, "contentType": "audio/wav",
                 "bytes": 64844, "savedPath": "/tmp/…/tts.wav", "riffWave": true,
                 "durationMs": 2025, "simulatedPlaybackMs": 506 } ],
      "eventOrder": ["run_start","stt_start","stt_vad_start","stt_vad_end","stt_end",
                     "intent_start","intent_end","tts_start","tts_stream_start",
                     "tts_stream_end","tts_end","run_end"],
      "outbound": ["start_request_sent", "announce_finished_sent"]
    }
  ],
  "events": [
    { "ts": 1763290000.123, "tsIso": "…", "direction": "in", "run": 1,
      "type": "VoiceAssistantEventResponse", "event": "stt_end",
      "eventType": 4, "eventRaw": "VOICE_ASSISTANT_STT_END", "data": {"text": "включи свет"} }
  ],
  "summary": { "triggers": 1, "runs": 2, "events": 57, "ttsDownloads": 2, "ttsErrors": 0,
               "microphoneAudioBytes": 57600, "streamedAudioBytes": 0, "errors": [] }
}
```

`direction`: `in` — от моста к моку (события VA, ответы, аудио), `out` — от мока к мосту
(hello/device info/`VoiceAssistantRequest`/announce finished), `system` — подключения, подписки,
смена владельца слота, старт/финиш прогона, `tts` — скачивание ответа по url (и ошибки скачивания).
Потоковые чанки `VoiceAssistantAudio` в журнал поштучно не пишутся: в `runs[].audioBytesSent` /
`audioChunksSent` и `summary`.

TTS-файлы: первый скачанный ответ пишется в `--out`, дальше — `--out` с суффиксом
`-2`, `-3`, … (`/tmp/tts.wav`, `/tmp/tts-2.wav`), чтобы follow-up не затирал первый ответ.
Точный путь — в `runs[].tts[].savedPath`.

## `--selftest`

Поднимает мок на свободных портах, локальный HTTP-сервер с TTS-ответом и настоящий клиент
`aioesphomeapi` (тот же, что у моста), после чего проверяет:

* handshake, `DeviceInfo` (имя, friendly name, MAC, ESPHome 2026.9.0, flags 61), пустой список
  сущностей, `DeviceCapabilities`, список wake word «alisa»;
* подписку на VA и слот (последний подписчик владеет, отписка возвращает предыдущему);
* `POST /health|/status|/start|/stop`, ошибки `409 no_subscriber`, `400 bad_wav`;
* первый run: `VoiceAssistantRequest(start=true, wake_word_phrase="Алиса", flags=0,
  volume_multiplier=1.0)`, точные байты WAV чанками по 1024, пейсинг;
* порядок событий pulsar/HA и скачивание TTS по url: `--out` побайтно равен отданному WAV;
* follow-up: второй `start=true` с пустой фразой, тот же `conversation_id`, второй TTS-файл;
* отмену: `start=false` посреди стрима, `handle_stop(abort=True)`, частичный `audioBytesSent`;
* потоковое `VoiceAssistantAudio` (legacy) принимается и попадает в `--out-streamed-wav`.

Exit code 0 — все проверки прошли; 1 — есть падения, они печатаются списком, артефакты прогона
остаются в каталоге, путь печатается в конце.

## Ограничения

* Только plaintext: Noise/PSK не реализованы. Для тестов моста это то, что нужно; живая колонка
  требует PSK.
* Сущностей, состояний, логов и media_player нет — проверяется только голосовой транспорт.
* Мок не распознаёт речь и не синтезирует её: WAV — заранее заданные файлы, TTS — то, что отдал
  сервер по `TTS_END.url`. Реальный ответ «мозга» проверяется в e2e через аддон.
* Один прогон (trigger) за раз; повторный `POST /start` во время прогона — `409 busy`.
