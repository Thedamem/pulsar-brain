import { useCallback, useEffect, useState } from "react";
import { api, errorText, parsePromptDefaults } from "../api";
import { useDocumentTitle, useLoader, useUnsavedChanges } from "../hooks";
import type {
  AppConfig,
  ConversationConfig,
  EndpointingConfig,
  TtsConfig,
} from "../../../src/shared/types";
import type {
  ConfigResponse,
  PromptResponse,
  VoicesResponse,
} from "../../../src/shared/protocol";
import {
  ErrorBlock,
  Field,
  FormActions,
  LoadingBlock,
  Notice,
  NumberField,
  PageHeader,
  Section,
  useToast,
} from "../components/ui";

interface AssistantData {
  config: ConfigResponse;
  prompt: PromptResponse;
}

interface AssistantForm {
  system: string;
  language: string;
  ttsMode: TtsConfig["mode"];
  voice: string;
  endpointing: EndpointingConfig;
  conversation: Omit<ConversationConfig, "bargeIn">;
}

function formFromConfig(config: AppConfig, system: string, language: string): AssistantForm {
  return {
    system,
    language,
    ttsMode: config.tts.mode,
    voice: config.tts.piper.voice,
    endpointing: { ...config.stt.endpointing },
    conversation: {
      maxHistoryTurns: config.conversation.maxHistoryTurns,
      followUpTimeoutMs: config.conversation.followUpTimeoutMs,
      llmMaxToolIterations: config.conversation.llmMaxToolIterations,
      requestTimeoutMs: config.conversation.requestTimeoutMs,
    },
  };
}

function ttsModeHint(mode: TtsConfig["mode"]): string {
  if (mode === "piper") return "Локальный Piper. Ответ читает выбранный голос.";
  if (mode === "provider") {
    return "Голос провайдера. Работает, только если провайдер умеет синтез речи.";
  }
  return "Провайдер, если умеет синтезировать речь, иначе Piper.";
}

export function AssistantPage() {
  useDocumentTitle("Ассистент");
  const notify = useToast();
  const load = useCallback(async (signal: AbortSignal): Promise<AssistantData> => {
    const [config, prompt] = await Promise.all([api.config(signal), api.prompt(signal)]);
    return { config, prompt };
  }, []);
  const { data, loading, error, reload, setData } = useLoader(load, []);
  const voices = useLoader<VoicesResponse>(
    useCallback((signal: AbortSignal) => api.voices(signal), []),
    [],
  );

  const [form, setForm] = useState<AssistantForm | null>(null);
  const [baseline, setBaseline] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState("Проверка голоса");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!data || form !== null) return;
    const next = formFromConfig(data.config.config, data.prompt.system, data.prompt.language);
    setForm(next);
    setBaseline(JSON.stringify(next));
  }, [data, form]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const dirty = form !== null && JSON.stringify(form) !== baseline;
  useUnsavedChanges(dirty);

  const update = (patch: Partial<AssistantForm>) => {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setSaveError(null);
  };

  const updateEndpointing = (patch: Partial<EndpointingConfig>) => {
    setForm((current) =>
      current ? { ...current, endpointing: { ...current.endpointing, ...patch } } : current,
    );
    setSaveError(null);
  };

  const updateConversation = (patch: Partial<AssistantForm["conversation"]>) => {
    setForm((current) =>
      current ? { ...current, conversation: { ...current.conversation, ...patch } } : current,
    );
    setSaveError(null);
  };

  const applyDefaults = async () => {
    setResetting(true);
    setResetError(null);
    try {
      const payload = await api.promptDefaults();
      const parsed = parsePromptDefaults(payload);
      if (!parsed) {
        setResetError("Сервер не вернул промпт по умолчанию.");
        return;
      }
      setForm((current) =>
        current ? { ...current, system: parsed.system, language: parsed.language } : current,
      );
      setConfirmReset(false);
    } catch (caught) {
      setResetError(errorText(caught));
    } finally {
      setResetting(false);
    }
  };

  const save = async () => {
    if (!form || !data) return;
    const current = data.config.config;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await api.saveConfig({
        prompt: {
          system: form.system,
          language: form.language.trim(),
        },
        tts: {
          ...current.tts,
          mode: form.ttsMode,
          piper: { ...current.tts.piper, voice: form.voice },
        },
        stt: {
          endpointing: { ...form.endpointing },
        },
        conversation: {
          ...current.conversation,
          ...form.conversation,
        },
      });
      const next = formFromConfig(
        response.config,
        response.config.prompt.system,
        response.config.prompt.language,
      );
      setForm(next);
      setBaseline(JSON.stringify(next));
      setSavedAt(Date.now());
      setData({ config: response, prompt: data.prompt });
      notify("Настройки ассистента сохранены.");
    } catch (caught) {
      setSaveError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const runPreview = async () => {
    if (!form) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const blob = await api.ttsPreview(previewText, form.voice);
      if (!blob.type.startsWith("audio/")) {
        const text = await blob.text();
        throw new Error(text.trim() || "Сервер вернул не аудио.");
      }
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
    } catch (caught) {
      setPreviewError(errorText(caught));
    } finally {
      setPreviewLoading(false);
    }
  };

  const voiceList = voices.data?.voices ?? [];
  const voiceInList = voiceList.some((voice) => voice.id === form?.voice);
  const selectedVoice = voiceList.find((voice) => voice.id === form?.voice);

  return (
    <div className="page">
      <PageHeader
        title="Ассистент"
        description="Промпт, озвучка, пороги распознавания речи и параметры диалога."
      />

      {!data && loading ? <LoadingBlock label="Загружаю настройки ассистента…" /> : null}
      {!data && error ? <ErrorBlock message={error} onRetry={reload} /> : null}
      {data && error ? (
        <Notice kind="error">
          Не удалось загрузить настройки: {error}{" "}
          <button type="button" className="btn btn--quiet" onClick={reload}>
            Повторить
          </button>
        </Notice>
      ) : null}

      {form && data ? (
        <>
          <Section
            id="prompt"
            title="Промпт"
            description="Правила поведения ассистента. Язык ответа задаётся отдельно."
            actions={
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => setConfirmReset(true)}
                disabled={resetting}
              >
                Вернуть по умолчанию
              </button>
            }
          >
            <div className="form">
              <Field
                id="prompt-system"
                label="Системный промпт"
                hint="Передаётся модели первым сообщением в каждом диалоге."
              >
                <textarea
                  id="prompt-system"
                  rows={12}
                  spellCheck={false}
                  value={form.system}
                  onChange={(event) => update({ system: event.target.value })}
                />
              </Field>
              <Field id="prompt-language" label="Язык" hint="Код языка, например ru или en.">
                <input
                  id="prompt-language"
                  type="text"
                  spellCheck={false}
                  value={form.language}
                  onChange={(event) => update({ language: event.target.value })}
                />
              </Field>
            </div>

            {confirmReset ? (
              <div className="confirm-row" role="group" aria-label="Подтверждение сброса промпта">
                <span>Заменить промпт и язык значениями по умолчанию?</span>
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => void applyDefaults()}
                  disabled={resetting}
                >
                  {resetting ? "Загрузка…" : "Вернуть"}
                </button>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => setConfirmReset(false)}
                  disabled={resetting}
                >
                  Отмена
                </button>
              </div>
            ) : null}
            {resetError ? <Notice kind="error">{resetError}</Notice> : null}
          </Section>

          <Section id="speech" title="Озвучка">
            <div className="form">
              <Field id="tts-mode" label="Режим" hint={ttsModeHint(form.ttsMode)}>
                <select
                  id="tts-mode"
                  value={form.ttsMode}
                  onChange={(event) =>
                    update({
                      ttsMode:
                        event.target.value === "provider"
                          ? "provider"
                          : event.target.value === "auto"
                            ? "auto"
                            : "piper",
                    })
                  }
                >
                  <option value="piper">Piper</option>
                  <option value="provider">Провайдер</option>
                  <option value="auto">Авто</option>
                </select>
              </Field>

              <Field
                id="tts-voice"
                label="Голос Piper"
                hint={
                  selectedVoice
                    ? `${selectedVoice.name}, ${selectedVoice.language}`
                    : "Голос из Wyoming Piper."
                }
              >
                {voices.loading && voiceList.length === 0 ? (
                  <select id="tts-voice" value={form.voice} disabled>
                    <option value={form.voice}>Загрузка голосов…</option>
                  </select>
                ) : voiceList.length > 0 ? (
                  <select
                    id="tts-voice"
                    value={form.voice}
                    onChange={(event) => update({ voice: event.target.value })}
                  >
                    {!voiceInList && form.voice !== "" ? (
                      <option value={form.voice}>{form.voice} (текущий)</option>
                    ) : null}
                    {voiceList.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.name} ({voice.language})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="tts-voice"
                    type="text"
                    spellCheck={false}
                    value={form.voice}
                    onChange={(event) => update({ voice: event.target.value })}
                    placeholder="Идентификатор голоса"
                  />
                )}
              </Field>

              <div className="voice-status" aria-live="polite">
                {!voices.loading && voices.error ? (
                  <Notice kind="error">
                    Список голосов не получен: {voices.error}{" "}
                    <button type="button" className="btn btn--quiet" onClick={voices.reload}>
                      Повторить
                    </button>
                  </Notice>
                ) : null}
                {!voices.loading && !voices.error && voiceList.length === 0 ? (
                  <Notice kind="warning">
                    Сервер Piper не вернул голоса. Проверьте, что wyoming-piper запущен, или
                    введите идентификатор голоса вручную.
                  </Notice>
                ) : null}
              </div>

              <div className="field">
                <label className="field-label" htmlFor="preview-text">
                  Текст для проверки
                </label>
                <div className="input-action">
                  <input
                    id="preview-text"
                    type="text"
                    value={previewText}
                    onChange={(event) => setPreviewText(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => void runPreview()}
                    disabled={previewLoading || previewText.trim() === "" || form.voice === ""}
                  >
                    {previewLoading ? "Синтез…" : "Прослушать"}
                  </button>
                </div>
                <p className="field-hint">Синтез не меняет сохранённые настройки.</p>
              </div>

              {previewError ? <Notice kind="error">{previewError}</Notice> : null}
              {previewUrl ? (
                <div className="preview-audio">
                  <audio controls src={previewUrl} aria-label="Предпросмотр озвучки">
                    Ваш браузер не поддерживает воспроизведение аудио.
                  </audio>
                </div>
              ) : null}
            </div>
          </Section>

          <Section
            id="vad"
            title="Распознавание речи"
            description="Пороги определения начала и конца фразы."
          >
            <div className="form">
              <div className="field-row">
                <NumberField
                  id="vad-threshold"
                  label="Порог тишины, дБFS"
                  value={form.endpointing.silenceThresholdDb}
                  min={-90}
                  max={0}
                  step={1}
                  hint="Ниже этого уровня звук считается тишиной. −40 дБ — тихая комната, −30 дБ — шумная."
                  onChange={(value) => updateEndpointing({ silenceThresholdDb: value })}
                />
                <NumberField
                  id="vad-sentence-silence"
                  label="Тишина до конца фразы, мс"
                  value={form.endpointing.sentenceSilenceMs}
                  min={100}
                  max={5000}
                  step={50}
                  hint="Пауза после речи, после которой фраза считается законченной."
                  onChange={(value) => updateEndpointing({ sentenceSilenceMs: value })}
                />
              </div>
              <div className="field-row">
                <NumberField
                  id="vad-min-speech"
                  label="Минимальная речь, мс"
                  value={form.endpointing.minSpeechMs}
                  min={0}
                  max={5000}
                  step={50}
                  hint="Более короткие фрагменты игнорируются."
                  onChange={(value) => updateEndpointing({ minSpeechMs: value })}
                />
                <NumberField
                  id="vad-max-utterance"
                  label="Максимум фразы, мс"
                  value={form.endpointing.maxUtteranceMs}
                  min={1000}
                  max={60_000}
                  step={500}
                  hint="Жёсткий предел длительности одной фразы."
                  onChange={(value) => updateEndpointing({ maxUtteranceMs: value })}
                />
              </div>
              <NumberField
                id="vad-pre-roll"
                label="Предзапись, мс"
                value={form.endpointing.preRollMs}
                min={0}
                max={2000}
                step={50}
                hint="Сколько звука до начала речи сохраняется, чтобы не обрезать первое слово."
                onChange={(value) => updateEndpointing({ preRollMs: value })}
              />
            </div>
          </Section>

          <Section id="conversation" title="Диалог">
            <div className="form">
              <div className="field-row">
                <NumberField
                  id="conversation-history"
                  label="Реплик в истории"
                  value={form.conversation.maxHistoryTurns}
                  min={0}
                  max={100}
                  step={1}
                  hint="Сколько реплик диалога держать в контексте модели."
                  onChange={(value) => updateConversation({ maxHistoryTurns: value })}
                />
                <NumberField
                  id="conversation-follow-up"
                  label="Окно продолжения, мс"
                  value={form.conversation.followUpTimeoutMs}
                  min={0}
                  max={120_000}
                  step={500}
                  hint="Сколько ждать продолжения без повторного «Алиса»."
                  onChange={(value) => updateConversation({ followUpTimeoutMs: value })}
                />
              </div>
              <div className="field-row">
                <NumberField
                  id="conversation-tool-iterations"
                  label="Шагов с инструментами"
                  value={form.conversation.llmMaxToolIterations}
                  min={1}
                  max={20}
                  step={1}
                  hint="Сколько кругов вызова инструментов разрешено на один ответ."
                  onChange={(value) => updateConversation({ llmMaxToolIterations: value })}
                />
                <NumberField
                  id="conversation-request-timeout"
                  label="Таймаут запроса, мс"
                  value={form.conversation.requestTimeoutMs}
                  min={1000}
                  max={120_000}
                  step={1000}
                  hint="Предельное время ожидания ответа провайдера."
                  onChange={(value) => updateConversation({ requestTimeoutMs: value })}
                />
              </div>
            </div>
          </Section>

          {saveError ? <Notice kind="error">{saveError}</Notice> : null}
          <FormActions
            dirty={dirty}
            saving={saving}
            savedAt={savedAt}
            onSave={() => void save()}
          />
        </>
      ) : null}
    </div>
  );
}
