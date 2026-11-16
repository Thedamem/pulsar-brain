import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { useDocumentTitle, useLoader, useUnsavedChanges } from "../hooks";
import { formatHeaderLines, parseHeaderLines } from "../parse";
import type {
  AppConfig,
  MockProviderConfig,
  ProviderHealth,
  ProviderId,
} from "../../../src/shared/types";
import type {
  ConfigResponse,
  ProviderInfoResponse,
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

const PROVIDER_IDS: ProviderId[] = ["openai", "openclaw", "gemini-live", "mock"];

const FALLBACK_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI-совместимый",
  openclaw: "OpenClaw",
  "gemini-live": "Gemini Live",
  mock: "Mock",
};

interface OpenAiForm {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  extraHeadersText: string;
}

interface OpenClawForm {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  model: string;
}

interface GeminiForm {
  apiKey: string;
  model: string;
  voice: string;
  responseModality: "AUDIO" | "TEXT";
}

interface MockForm {
  mode: MockProviderConfig["mode"];
  scriptFile: string;
}

interface ProviderForm {
  id: ProviderId;
  openai: OpenAiForm;
  openclaw: OpenClawForm;
  geminiLive: GeminiForm;
  mock: MockForm;
}

interface ProviderData {
  config: ConfigResponse;
  providers: ProviderInfoResponse;
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value);
}

function formFromConfig(config: AppConfig): ProviderForm {
  return {
    id: config.provider.id,
    openai: {
      baseUrl: config.provider.openai.baseUrl,
      apiKey: "",
      model: config.provider.openai.model,
      temperature: config.provider.openai.temperature,
      maxTokens: config.provider.openai.maxTokens,
      extraHeadersText: formatHeaderLines(config.provider.openai.extraHeaders),
    },
    openclaw: {
      baseUrl: config.provider.openclaw.baseUrl,
      apiKey: "",
      agentId: config.provider.openclaw.agentId,
      model: config.provider.openclaw.model,
    },
    geminiLive: {
      apiKey: "",
      model: config.provider.geminiLive.model,
      voice: config.provider.geminiLive.voice,
      responseModality: config.provider.geminiLive.responseModality,
    },
    mock: {
      mode: config.provider.mock.mode,
      scriptFile: config.provider.mock.scriptFile,
    },
  };
}

function capabilitiesText(info: ProviderInfoResponse["providers"][number] | undefined): string {
  if (!info) return "Возможности провайдера не получены.";
  const parts: string[] = [];
  if (info.capabilities.streaming) parts.push("потоковая передача");
  if (info.capabilities.tools) parts.push("инструменты");
  if (info.capabilities.nativeAudio) parts.push("собственный звук");
  if (info.capabilities.tts) parts.push("своя озвучка");
  if (info.capabilities.models) parts.push("список моделей");
  return parts.length > 0
    ? `Поддерживает: ${parts.join(", ")}.`
    : "Без дополнительных возможностей.";
}

function secretHint(saved: string | undefined): string {
  return saved && saved.length > 0
    ? "Ключ сохранён и не отображается. Пустое поле его не меняет."
    : "Ключ не задан. Введите значение, чтобы сохранить его.";
}

function secretPlaceholder(saved: string | undefined): string {
  return saved && saved.length > 0 ? "Сохранён, не отображается" : "Не задан";
}

export function ProvidersPage() {
  useDocumentTitle("Провайдеры");
  const notify = useToast();
  const load = useCallback(async (signal: AbortSignal): Promise<ProviderData> => {
    const [config, providers] = await Promise.all([api.config(signal), api.providers(signal)]);
    return { config, providers };
  }, []);
  const { data, loading, error, reload, setData } = useLoader(load, []);

  const [form, setForm] = useState<ProviderForm | null>(null);
  const [baseline, setBaseline] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderHealth | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    if (!data || form !== null) return;
    const next = formFromConfig(data.config.config);
    setForm(next);
    setBaseline(JSON.stringify(next));
  }, [data, form]);

  const dirty = form !== null && JSON.stringify(form) !== baseline;
  useUnsavedChanges(dirty);

  const resetFeedback = () => {
    setTestResult(null);
    setModels(null);
    setModelsError(null);
    setErrors({});
    setSaveError(null);
  };

  const updateOpenAi = (patch: Partial<OpenAiForm>) => {
    setForm((current) =>
      current ? { ...current, openai: { ...current.openai, ...patch } } : current,
    );
    setErrors({});
  };
  const updateOpenClaw = (patch: Partial<OpenClawForm>) => {
    setForm((current) =>
      current ? { ...current, openclaw: { ...current.openclaw, ...patch } } : current,
    );
    setErrors({});
  };
  const updateGemini = (patch: Partial<GeminiForm>) => {
    setForm((current) =>
      current ? { ...current, geminiLive: { ...current.geminiLive, ...patch } } : current,
    );
    setErrors({});
  };
  const updateMock = (patch: Partial<MockForm>) => {
    setForm((current) => (current ? { ...current, mock: { ...current.mock, ...patch } } : current));
    setErrors({});
  };

  const providerInfo =
    form && data
      ? data.providers.providers.find((provider) => provider.id === form.id)
      : undefined;

  const validate = (value: ProviderForm): Record<string, string> => {
    const next: Record<string, string> = {};
    if (value.id === "openai") {
      if (value.openai.baseUrl.trim() === "") next["baseUrl"] = "Укажите базовый адрес API.";
      if (value.openai.model.trim() === "") next["model"] = "Укажите модель.";
    }
    if (value.id === "openclaw") {
      if (value.openclaw.baseUrl.trim() === "") next["baseUrl"] = "Укажите базовый адрес API.";
      if (value.openclaw.model.trim() === "") next["model"] = "Укажите модель.";
    }
    if (value.id === "gemini-live") {
      if (value.geminiLive.model.trim() === "") next["model"] = "Укажите модель.";
      if (value.geminiLive.voice.trim() === "") next["voice"] = "Укажите голос.";
    }
    if (value.id === "mock" && value.mock.mode === "scripted" && value.mock.scriptFile.trim() === "") {
      next["scriptFile"] = "Укажите файл со сценарием.";
    }
    const headers = parseHeaderLines(value.openai.extraHeadersText);
    if (headers.error) next["headers"] = headers.error;
    return next;
  };

  const save = async () => {
    if (!form || !data) return;
    const validation = validate(form);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      setSaveError("Проверьте выделенные поля.");
      return;
    }
    const headers = parseHeaderLines(form.openai.extraHeadersText).headers;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await api.saveConfig({
        provider: {
          id: form.id,
          openai: {
            baseUrl: form.openai.baseUrl.trim(),
            model: form.openai.model.trim(),
            temperature: form.openai.temperature,
            maxTokens: form.openai.maxTokens,
            extraHeaders: headers,
            ...(form.openai.apiKey.trim() !== ""
              ? { apiKey: form.openai.apiKey.trim() }
              : {}),
          },
          openclaw: {
            baseUrl: form.openclaw.baseUrl.trim(),
            agentId: form.openclaw.agentId.trim(),
            model: form.openclaw.model.trim(),
            ...(form.openclaw.apiKey.trim() !== ""
              ? { apiKey: form.openclaw.apiKey.trim() }
              : {}),
          },
          geminiLive: {
            model: form.geminiLive.model.trim(),
            voice: form.geminiLive.voice.trim(),
            responseModality: form.geminiLive.responseModality,
            ...(form.geminiLive.apiKey.trim() !== ""
              ? { apiKey: form.geminiLive.apiKey.trim() }
              : {}),
          },
          mock: {
            mode: form.mock.mode,
            scriptFile: form.mock.scriptFile.trim(),
          },
        },
      });
      const next = formFromConfig(response.config);
      setForm(next);
      setBaseline(JSON.stringify(next));
      setSavedAt(Date.now());
      setData({ config: response, providers: data.providers });
      resetFeedback();
      notify("Провайдер сохранён.");
    } catch (caught) {
      setSaveError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!form) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testProvider(form.id);
      setTestResult(result);
    } catch (caught) {
      setTestResult({ ok: false, detail: errorText(caught) });
    } finally {
      setTesting(false);
    }
  };

  const loadModels = async () => {
    if (!form) return;
    setModelsLoading(true);
    setModelsError(null);
    setModels(null);
    try {
      const response = await api.models(form.id);
      setModels(response.models);
      if (response.models.length === 0) {
        setModelsError("Провайдер вернул пустой список моделей.");
      }
    } catch (caught) {
      setModelsError(errorText(caught));
    } finally {
      setModelsLoading(false);
    }
  };

  const config = data?.config.config;

  return (
    <div className="page">
      <PageHeader
        title="Провайдеры"
        description="Модель, адрес и ключи. Проверка соединения и список моделей используют сохранённую конфигурацию."
      />

      {!data && loading ? <LoadingBlock label="Загружаю настройки провайдеров…" /> : null}
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
            id="provider"
            title="Подключение"
            description={capabilitiesText(providerInfo)}
          >
            <div className="form">
              <Field
                id="provider-id"
                label="Провайдер"
                hint="Активный провайдер отвечает на голосовые запросы."
              >
                <select
                  id="provider-id"
                  value={form.id}
                  onChange={(event) => {
                    if (!isProviderId(event.target.value)) return;
                    setForm((current) =>
                      current ? { ...current, id: event.target.value as ProviderId } : current,
                    );
                    resetFeedback();
                  }}
                >
                  {PROVIDER_IDS.map((id) => {
                    const label =
                      data.providers.providers.find((provider) => provider.id === id)?.label ??
                      FALLBACK_LABELS[id];
                    return (
                      <option key={id} value={id}>
                        {label.toLowerCase() === id ? label : `${label} (${id})`}
                      </option>
                    );
                  })}
                </select>
              </Field>

              {form.id === "openai" ? (
                <>
                  <Field
                    id="openai-base-url"
                    label="Базовый адрес API"
                    hint="Полный базовый адрес, включая версию, без завершающего слэша."
                    error={errors["baseUrl"]}
                  >
                    <input
                      id="openai-base-url"
                      type="url"
                      spellCheck={false}
                      value={form.openai.baseUrl}
                      onChange={(event) => updateOpenAi({ baseUrl: event.target.value })}
                      aria-invalid={errors["baseUrl"] !== undefined}
                    />
                  </Field>

                  <Field
                    id="openai-api-key"
                    label="Ключ API"
                    hint={
                      form.openai.apiKey === ""
                        ? secretHint(config?.provider.openai.apiKey)
                        : "Новый ключ будет сохранён после нажатия «Сохранить»."
                    }
                  >
                    <input
                      id="openai-api-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={secretPlaceholder(config?.provider.openai.apiKey)}
                      value={form.openai.apiKey}
                      onChange={(event) => updateOpenAi({ apiKey: event.target.value })}
                    />
                  </Field>

                  <Field
                    id="openai-model"
                    label="Модель"
                    hint="Идентификатор модели у провайдера."
                    error={errors["model"]}
                  >
                    <input
                      id="openai-model"
                      type="text"
                      spellCheck={false}
                      value={form.openai.model}
                      onChange={(event) => updateOpenAi({ model: event.target.value })}
                      aria-invalid={errors["model"] !== undefined}
                    />
                  </Field>
                  {models && models.length > 0 ? (
                    <Field id="openai-model-list" label="Доступные модели">
                      <select
                        id="openai-model-list"
                        value={models.includes(form.openai.model) ? form.openai.model : ""}
                        onChange={(event) => updateOpenAi({ model: event.target.value })}
                      >
                        <option value="">Выберите модель</option>
                        {models.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : null}

                  <div className="field-row">
                    <NumberField
                      id="openai-temperature"
                      label="Температура"
                      value={form.openai.temperature}
                      min={0}
                      max={2}
                      step={0.1}
                      hint="0–2. Ниже — стабильнее, выше — разнообразнее."
                      onChange={(value) => updateOpenAi({ temperature: value })}
                    />
                    <NumberField
                      id="openai-max-tokens"
                      label="Максимум токенов"
                      value={form.openai.maxTokens}
                      min={1}
                      max={1_000_000}
                      step={1}
                      hint="Предел длины ответа модели."
                      onChange={(value) => updateOpenAi({ maxTokens: value })}
                    />
                  </div>

                  <Field
                    id="openai-headers"
                    label="Дополнительные заголовки"
                    hint="По одному на строку в формате «Имя: значение». Пустое поле — без заголовков."
                    error={errors["headers"]}
                  >
                    <textarea
                      id="openai-headers"
                      rows={3}
                      spellCheck={false}
                      value={form.openai.extraHeadersText}
                      onChange={(event) => updateOpenAi({ extraHeadersText: event.target.value })}
                      aria-invalid={errors["headers"] !== undefined}
                    />
                  </Field>
                </>
              ) : null}

              {form.id === "openclaw" ? (
                <>
                  <Field
                    id="openclaw-base-url"
                    label="Базовый адрес API"
                    hint="Адрес OpenClaw без завершающего слэша."
                    error={errors["baseUrl"]}
                  >
                    <input
                      id="openclaw-base-url"
                      type="url"
                      spellCheck={false}
                      value={form.openclaw.baseUrl}
                      onChange={(event) => updateOpenClaw({ baseUrl: event.target.value })}
                      aria-invalid={errors["baseUrl"] !== undefined}
                    />
                  </Field>
                  <Field
                    id="openclaw-api-key"
                    label="Ключ API"
                    hint={
                      form.openclaw.apiKey === ""
                        ? secretHint(config?.provider.openclaw.apiKey)
                        : "Новый ключ будет сохранён после нажатия «Сохранить»."
                    }
                  >
                    <input
                      id="openclaw-api-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={secretPlaceholder(config?.provider.openclaw.apiKey)}
                      value={form.openclaw.apiKey}
                      onChange={(event) => updateOpenClaw({ apiKey: event.target.value })}
                    />
                  </Field>
                  <Field
                    id="openclaw-agent-id"
                    label="Идентификатор агента"
                    hint="Необязательный идентификатор агента или сессии OpenClaw."
                  >
                    <input
                      id="openclaw-agent-id"
                      type="text"
                      spellCheck={false}
                      value={form.openclaw.agentId}
                      onChange={(event) => updateOpenClaw({ agentId: event.target.value })}
                    />
                  </Field>
                  <Field id="openclaw-model" label="Модель" error={errors["model"]}>
                    <input
                      id="openclaw-model"
                      type="text"
                      spellCheck={false}
                      value={form.openclaw.model}
                      onChange={(event) => updateOpenClaw({ model: event.target.value })}
                      aria-invalid={errors["model"] !== undefined}
                    />
                  </Field>
                </>
              ) : null}

              {form.id === "gemini-live" ? (
                <>
                  <Field
                    id="gemini-api-key"
                    label="Ключ API"
                    hint={
                      form.geminiLive.apiKey === ""
                        ? secretHint(config?.provider.geminiLive.apiKey)
                        : "Новый ключ будет сохранён после нажатия «Сохранить»."
                    }
                  >
                    <input
                      id="gemini-api-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={secretPlaceholder(config?.provider.geminiLive.apiKey)}
                      value={form.geminiLive.apiKey}
                      onChange={(event) => updateGemini({ apiKey: event.target.value })}
                    />
                  </Field>
                  <Field id="gemini-model" label="Модель" error={errors["model"]}>
                    <input
                      id="gemini-model"
                      type="text"
                      spellCheck={false}
                      value={form.geminiLive.model}
                      onChange={(event) => updateGemini({ model: event.target.value })}
                      aria-invalid={errors["model"] !== undefined}
                    />
                  </Field>
                  <Field
                    id="gemini-voice"
                    label="Голос"
                    hint="Имя голоса из документации Gemini Live."
                    error={errors["voice"]}
                  >
                    <input
                      id="gemini-voice"
                      type="text"
                      spellCheck={false}
                      value={form.geminiLive.voice}
                      onChange={(event) => updateGemini({ voice: event.target.value })}
                      aria-invalid={errors["voice"] !== undefined}
                    />
                  </Field>
                  <Field
                    id="gemini-modality"
                    label="Модальность ответа"
                    hint="Звук — провайдер синтезирует речь сам. Текст — ответ озвучивает TTS аддона."
                  >
                    <select
                      id="gemini-modality"
                      value={form.geminiLive.responseModality}
                      onChange={(event) =>
                        updateGemini({
                          responseModality: event.target.value === "TEXT" ? "TEXT" : "AUDIO",
                        })
                      }
                    >
                      <option value="AUDIO">Звук (speech-to-speech)</option>
                      <option value="TEXT">Текст</option>
                    </select>
                  </Field>
                </>
              ) : null}

              {form.id === "mock" ? (
                <>
                  <Field
                    id="mock-mode"
                    label="Режим"
                    hint="Умный сценарий разбирает русские команды. Эхо повторяет вход. Скрипт читает шаги из файла."
                  >
                    <select
                      id="mock-mode"
                      value={form.mock.mode}
                      onChange={(event) =>
                        updateMock({
                          mode:
                            event.target.value === "echo"
                              ? "echo"
                              : event.target.value === "scripted"
                                ? "scripted"
                                : "smart",
                        })
                      }
                    >
                      <option value="smart">Умный сценарий</option>
                      <option value="echo">Эхо</option>
                      <option value="scripted">Скрипт</option>
                    </select>
                  </Field>
                  <Field
                    id="mock-script-file"
                    label="Файл сценария"
                    hint="Имя файла в каталоге данных аддона. Используется в режиме «Скрипт»."
                    error={errors["scriptFile"]}
                  >
                    <input
                      id="mock-script-file"
                      type="text"
                      spellCheck={false}
                      value={form.mock.scriptFile}
                      onChange={(event) => updateMock({ scriptFile: event.target.value })}
                      aria-invalid={errors["scriptFile"] !== undefined}
                    />
                  </Field>
                </>
              ) : null}
            </div>

            <div className="inline-actions">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void runTest()}
                disabled={testing}
              >
                {testing ? "Проверка…" : "Проверить"}
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void loadModels()}
                disabled={
                  modelsLoading || (providerInfo !== undefined && !providerInfo.capabilities.models)
                }
                title={
                  providerInfo && !providerInfo.capabilities.models
                    ? "Провайдер не умеет отдавать список моделей"
                    : undefined
                }
              >
                {modelsLoading ? "Загрузка моделей…" : "Модели"}
              </button>
            </div>

            {testResult ? (
              <Notice kind={testResult.ok ? "success" : "error"}>
                {testResult.ok ? "Соединение работает." : "Проверка не прошла."}{" "}
                {testResult.detail}
              </Notice>
            ) : null}
            {modelsError ? <Notice kind="error">{modelsError}</Notice> : null}
            {saveError ? <Notice kind="error">{saveError}</Notice> : null}
          </Section>

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
