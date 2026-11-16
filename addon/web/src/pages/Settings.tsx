import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { useDocumentTitle, useLoader, useUnsavedChanges } from "../hooks";
import { isValidHttpUrl } from "../parse";
import type { AppConfig, LogLevel } from "../../../src/shared/types";
import type { HaEntitiesResponse } from "../../../src/shared/protocol";
import {
  ErrorBlock,
  Field,
  FormActions,
  LoadingBlock,
  Notice,
  PageHeader,
  Section,
  TableScroll,
  useToast,
} from "../components/ui";

const LOG_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error"];
const MAX_ENTITY_OPTIONS = 100;

interface SettingsForm {
  logLevel: LogLevel;
  aliases: Record<string, string>;
  haUrl: string;
  haToken: string;
}

function formFromConfig(config: AppConfig): SettingsForm {
  return {
    logLevel: config.logLevel,
    aliases: { ...config.aliases },
    haUrl: config.tools.ha.url,
    haToken: "",
  };
}

export function SettingsPage() {
  useDocumentTitle("Настройки");
  const notify = useToast();
  const configLoad = useLoader(
    useCallback((signal: AbortSignal) => api.config(signal), []),
    [],
  );
  const entities = useLoader<HaEntitiesResponse>(
    useCallback((signal: AbortSignal) => api.haEntities(signal), []),
    [],
  );

  const [form, setForm] = useState<SettingsForm | null>(null);
  const [baseline, setBaseline] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [haUrlError, setHaUrlError] = useState<string | null>(null);

  const [aliasPhrase, setAliasPhrase] = useState("");
  const [entityQuery, setEntityQuery] = useState("");
  const [selectedEntity, setSelectedEntity] = useState("");
  const [aliasError, setAliasError] = useState<string | null>(null);

  const [showBridgeToken, setShowBridgeToken] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (!configLoad.data || form !== null) return;
    const next = formFromConfig(configLoad.data.config);
    setForm(next);
    setBaseline(JSON.stringify(next));
  }, [configLoad.data, form]);

  const dirty = form !== null && JSON.stringify(form) !== baseline;
  useUnsavedChanges(dirty);

  const allEntities = entities.data?.entities ?? [];
  const areas = entities.data?.areas ?? [];
  const entityNameById = useMemo(
    () => new Map(allEntities.map((entity) => [entity.entity_id, entity.name])),
    [allEntities],
  );
  const areaNameById = useMemo(
    () => new Map(areas.map((area) => [area.area_id, area.name])),
    [areas],
  );

  const query = entityQuery.trim().toLowerCase();
  const matchedEntities = useMemo(() => {
    if (query === "") return allEntities;
    return allEntities.filter(
      (entity) =>
        entity.name.toLowerCase().includes(query) ||
        entity.entity_id.toLowerCase().includes(query),
    );
  }, [allEntities, query]);

  const selected = allEntities.find((entity) => entity.entity_id === selectedEntity);
  const limited = matchedEntities.slice(0, MAX_ENTITY_OPTIONS);
  const selectOptions =
    selected && !limited.some((entity) => entity.entity_id === selected.entity_id)
      ? [selected, ...limited]
      : limited;

  const aliasRows = useMemo(() => {
    if (!form) return [];
    return Object.entries(form.aliases)
      .map(([phrase, entityId]) => ({ phrase, entityId }))
      .sort((left, right) => left.phrase.localeCompare(right.phrase, "ru"));
  }, [form]);

  const addAlias = () => {
    if (!form) return;
    const phrase = aliasPhrase.trim();
    if (phrase === "") {
      setAliasError("Введите фразу.");
      return;
    }
    if (selectedEntity === "") {
      setAliasError("Выберите сущность.");
      return;
    }
    if (Object.prototype.hasOwnProperty.call(form.aliases, phrase)) {
      setAliasError("Такая фраза уже есть в списке.");
      return;
    }
    setForm({
      ...form,
      aliases: { ...form.aliases, [phrase]: selectedEntity },
    });
    setAliasPhrase("");
    setSelectedEntity("");
    setAliasError(null);
    setSaveError(null);
  };

  const removeAlias = (phrase: string) => {
    if (!form) return;
    const next = { ...form.aliases };
    delete next[phrase];
    setForm({ ...form, aliases: next });
    setSaveError(null);
  };

  const save = async () => {
    if (!form || !configLoad.data) return;
    if (form.haUrl.trim() !== "" && !isValidHttpUrl(form.haUrl.trim())) {
      setHaUrlError("Адрес должен начинаться с http:// или https://.");
      return;
    }
    setHaUrlError(null);
    setSaving(true);
    setSaveError(null);
    try {
      const response = await api.saveConfig({
        logLevel: form.logLevel,
        aliases: form.aliases,
        tools: {
          ha: {
            enabled: configLoad.data.config.tools.ha.enabled,
            url: form.haUrl.trim(),
            ...(form.haToken.trim() !== "" ? { token: form.haToken.trim() } : {}),
          },
        },
      });
      const next = formFromConfig(response.config);
      setForm(next);
      setBaseline(JSON.stringify(next));
      setSavedAt(Date.now());
      configLoad.setData(response);
      notify("Настройки сохранены.");
    } catch (caught) {
      setSaveError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const copyBridgeToken = async () => {
    if (!configLoad.data) return;
    const value = configLoad.data.bridgeToken;
    if (!navigator.clipboard) {
      setCopyState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const config = configLoad.data;
  const bridgeToken = config?.bridgeToken ?? "";
  const maskedBridgeToken =
    bridgeToken.length > 8
      ? `${bridgeToken.slice(0, 4)}…${bridgeToken.slice(-4)}`
      : "••••••••";
  const haTokenPresent = (config?.config.tools.ha.token ?? "").length > 0;

  return (
    <div className="page">
      <PageHeader
        title="Настройки"
        description="Подключение к Home Assistant, алиасы команд, токен моста и уровень журнала."
      />

      {!configLoad.data && configLoad.loading ? (
        <LoadingBlock label="Загружаю настройки…" />
      ) : null}
      {!configLoad.data && configLoad.error ? (
        <ErrorBlock message={configLoad.error} onRetry={configLoad.reload} />
      ) : null}
      {configLoad.data && configLoad.error ? (
        <Notice kind="error">
          Не удалось обновить настройки: {configLoad.error}{" "}
          <button type="button" className="btn btn--quiet" onClick={configLoad.reload}>
            Повторить
          </button>
        </Notice>
      ) : null}

      {config && form ? (
        <>
          {config.warnings.length > 0 ? (
            <Notice kind="warning">{config.warnings.join(" ")}</Notice>
          ) : null}

          <Section
            id="ha"
            title="Home Assistant"
            description="Адрес и токен нужны вне Supervisor. В Supervisor адрес и токен подставляются автоматически."
          >
            <div className="form">
              <Field
                id="ha-url"
                label="Адрес API"
                hint="Полный адрес API Home Assistant. Пусто — адрес Supervisor по умолчанию."
                error={haUrlError ?? undefined}
              >
                <input
                  id="ha-url"
                  type="url"
                  spellCheck={false}
                  value={form.haUrl}
                  onChange={(event) => {
                    setForm({ ...form, haUrl: event.target.value });
                    setHaUrlError(null);
                    setSaveError(null);
                  }}
                  aria-invalid={haUrlError !== null}
                />
              </Field>
              <Field
                id="ha-token"
                label="Токен"
                hint={
                  form.haToken !== ""
                    ? "Новый токен будет сохранён после нажатия «Сохранить»."
                    : haTokenPresent
                      ? "Токен сохранён и не отображается. Пустое поле его не меняет."
                      : "Токен не задан. Введите значение или оставьте поле пустым."
                }
              >
                <input
                  id="ha-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={haTokenPresent ? "Сохранён" : "Не задан"}
                  value={form.haToken}
                  onChange={(event) => {
                    setForm({ ...form, haToken: event.target.value });
                    setSaveError(null);
                  }}
                />
              </Field>
            </div>
          </Section>

          <Section
            id="aliases"
            title="Алиасы команд"
            description="Фраза из голосовой команды заменяется на entity_id. Это помогает модели, когда название звучит не буквально."
          >
            <div className="alias-add">
              <Field id="alias-phrase" label="Фраза" hint="Как пользователь называет объект.">
                <input
                  id="alias-phrase"
                  type="text"
                  value={aliasPhrase}
                  onChange={(event) => {
                    setAliasPhrase(event.target.value);
                    setAliasError(null);
                  }}
                  placeholder="Свет на кухне"
                />
              </Field>

              {entities.data ? (
                <>
                  <Field id="alias-entity-search" label="Поиск сущности">
                    <input
                      id="alias-entity-search"
                      type="search"
                      value={entityQuery}
                      onChange={(event) => setEntityQuery(event.target.value)}
                      placeholder="Название или entity_id"
                    />
                  </Field>
                  <Field
                    id="alias-entity"
                    label="Сущность"
                    hint={
                      matchedEntities.length > MAX_ENTITY_OPTIONS
                        ? `Совпадений: ${matchedEntities.length}. Показаны первые ${MAX_ENTITY_OPTIONS}, уточните поиск.`
                        : `Доступно сущностей: ${allEntities.length}.`
                    }
                  >
                    <select
                      id="alias-entity"
                      value={selectedEntity}
                      onChange={(event) => {
                        setSelectedEntity(event.target.value);
                        setAliasError(null);
                      }}
                    >
                      <option value="">Выберите сущность</option>
                      {selectOptions.map((entity) => {
                        const areaName = entity.area_id ? areaNameById.get(entity.area_id) : undefined;
                        return (
                          <option key={entity.entity_id} value={entity.entity_id}>
                            {entity.name} — {entity.entity_id}
                            {areaName ? ` (${areaName})` : ""}
                          </option>
                        );
                      })}
                    </select>
                  </Field>
                </>
              ) : (
                <div className="alias-entity-state">
                  {entities.loading ? (
                    <p className="muted" role="status">
                      Загрузка сущностей…
                    </p>
                  ) : (
                    <Notice kind="error">
                      Сущности Home Assistant не получены: {entities.error}{" "}
                      <button
                        type="button"
                        className="btn btn--quiet"
                        onClick={entities.reload}
                      >
                        Повторить
                      </button>
                    </Notice>
                  )}
                </div>
              )}

              <div className="alias-add-action">
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={addAlias}
                  disabled={!entities.data}
                  title={!entities.data ? "Список сущностей ещё не загружен" : undefined}
                >
                  Добавить
                </button>
              </div>
            </div>
            {aliasError ? <Notice kind="error">{aliasError}</Notice> : null}

            {aliasRows.length === 0 ? (
              <p className="state-text">Алиасы не заданы. Добавьте фразу и сущность в форме выше.</p>
            ) : (
              <TableScroll label="Алиасы команд">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Фраза</th>
                      <th scope="col">Сущность</th>
                      <th scope="col">
                        <span className="sr-only">Действия</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {aliasRows.map((row) => (
                      <tr key={row.phrase}>
                        <td>{row.phrase}</td>
                        <td>
                          <span className="cell-title">
                            {entityNameById.get(row.entityId) ?? row.entityId}
                          </span>
                          <span className="cell-sub mono">{row.entityId}</span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn--quiet btn--quiet-danger"
                            onClick={() => removeAlias(row.phrase)}
                            aria-label={`Удалить алиас «${row.phrase}»`}
                          >
                            Удалить
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Section>

          <Section id="service" title="Служебное">
            <div className="form">
              <Field
                id="log-level"
                label="Уровень журнала"
                hint="Записи ниже выбранного уровня не попадут в журнал."
              >
                <select
                  id="log-level"
                  value={form.logLevel}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (
                      value === "trace" ||
                      value === "debug" ||
                      value === "info" ||
                      value === "warn" ||
                      value === "error"
                    ) {
                      setForm({ ...form, logLevel: value });
                      setSaveError(null);
                    }
                  }}
                >
                  {LOG_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="field">
                <span className="field-label" id="bridge-token-label">
                  Токен моста
                </span>
                <div className="token-row" role="group" aria-labelledby="bridge-token-label">
                  <code className="token-value">
                    {bridgeToken === ""
                      ? "Токен не получен"
                      : showBridgeToken
                        ? bridgeToken
                        : maskedBridgeToken}
                  </code>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => setShowBridgeToken((current) => !current)}
                    disabled={bridgeToken === ""}
                  >
                    {showBridgeToken ? "Скрыть" : "Показать"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => void copyBridgeToken()}
                    disabled={bridgeToken === ""}
                  >
                    Копировать
                  </button>
                </div>
                <p className="field-hint">
                  Этот токен интеграция pulsar_brain использует для подключения к аддону.
                </p>
                {copyState === "copied" ? (
                  <p className="field-hint" role="status">
                    Скопировано в буфер обмена.
                  </p>
                ) : null}
                {copyState === "failed" ? (
                  <p className="field-error" role="alert">
                    Не удалось скопировать. Покажите токен и скопируйте его вручную.
                  </p>
                ) : null}
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
