# Исследование: pulsar (ESPHome voice satellite)

Источник: репозиторий `Morvex885/pulsar`, HEAD `1a45067`, код и docs. Проверено 2026-11-16.

## Главное для нашего моста

1. **Захват конвейера = ESPHome-подписка.** `Hello` + `SubscribeVoiceAssistantRequest(subscribe=true)`.
   Побеждает последний подписавшийся (`voice_wanted`), максимум 4 клиента. Только владелец получает
   `VoiceAssistantRequest` и микрофонное аудио, и только его `VoiceAssistantEventResponse`/`Response`
   принимаются. Подписка нового клиента обрывает текущий диалог старого владельца. Отписка/обрыв —
   диалог завершается.
2. **Колонка не принимает потоковое TTS-аудио.** Входящий `VoiceAssistantAudio` (server→device)
   игнорируется; `SPEAKER` не рекламируется. Озвучка — только URL из `TTS_END.url` или
   `RUN_START.url`, играется GStreamer playbin в канале Announce. Завершение проигрывания pulsar
   сам сообщает `VoiceAssistantAnnounceFinished`.
3. **Микрофон:** 16 кГц моно S16LE, чанки в `VoiceAssistantAudio`; конец — `VoiceAssistantRequest(start=false)`.
   `VoiceAssistantResponse.port` только логируется, UDP нет: всегда API-аудио, клиент возвращает port=0.
4. **События (коды):** ERROR 0, RUN_START 1, RUN_END 2, STT_START 3, STT_END 4, INTENT_START 5,
   INTENT_END 6, TTS_START 7, TTS_END 8, WAKE_WORD_START/END 9/10, STT_VAD_START/END 11/12,
   TTS_STREAM_START/END 98/99, INTENT_PROGRESS 100. Данные — `repeated VoiceAssistantEventData`
   (ключ-значение строками).
5. **RUN_START обязателен**: до него события не привязываются к run (принимается только RUN_END как
   отказ HA). RUN_END не обязателен, если TTS доиграл.
6. **Watchdog:** 30 с Listening, 120 с Processing, перезаряжается любым принятым событием.
   Значит во время долгого LLM/TTS нужно периодически слать `INTENT_PROGRESS`.
7. **Follow-up:** `INTENT_END.continue_conversation="1"`; pulsar после проигрывания (успех,
   follow-up duration > 0, таймер не звенит, микрофон не замьючен) запускает новый run с пустой
   фразой. Окно армится по `STT_START` нового run и только если в прошлом run был `STT_VAD_START`.
   Тишина завершается `stt-no-text-recognized` тихо.
8. **Barge-in:** wake во время Speaking → локальное прерывание + новый run. При замене run клиент
   сначала шлёт RUN_END старого, потом RUN_START нового.
9. **Локальные команды** («стоп», «громче», «тише», «пауза», «продолжи», «дальше/назад») — стоковый
   командный спотер, работают без wake word в определённых условиях; список compile-time, через API
   не расширяется. Стоп-слова в тексте STT («стоп», «хватит», «пауза») pulsar обрабатывает сам.
10. **Порты:** 6053 TCP API, 8928 TCP Sendspin, 6638 TCP deCONZ, 6054 UDP арбитраж.
    `PULSAR_PORT_OFFSET` сдвигает все. Тестовый экземпляр — `tools/station.sh test-start` (нужна
    живая станция).
11. **Моки:** `api_selftest` — device-side ESPHome-сервер (собирается из Rust), `tools/esphome_check.py
    voice-fake` — HA-side клиент, гоняющий полный сценарий событий. Наш мок-сателлит должен
    воспроизводить поведение pulsar, а не ESPHome-прошивки.

## Выводы для контракта

- Мост: подписка на VA, RUN_START сразу после открытия run, пересылка PCM-аудио, VAD на стороне
  аддона, события STT_*/INTENT_*, публикация WAV ответа по HTTP и `TTS_END{url}`, RUN_END после.
- Пейсинг для TTS не нужен; для микрофона — обычный поток без пейсинга.
- Keepalive `INTENT_PROGRESS` каждые ~10 с во время обработки, чтобы не сработал watchdog 120 с.
- Полная генерация WAV до воспроизведения — как в штатном HA; для длинных ответов Gemini Live это
  задержка, отметить в ограничениях.
