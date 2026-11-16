import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { useDocumentTitle, useLoader, useUnsavedChanges } from "../hooks";
import { formatHeaderLines, isValidHttpUrl, parseArgLines, parseHeaderLines } from "../parse";
import type { McpServerConfig, ProviderHealth } from "../../../src/shared/types";
import type {
  McpServersResponse,
  McpToolsResponse,
} from "../../../src/shared/protocol";
import {
  CheckboxField,
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  Notice,
  NumberField,
  PageHeader,
  Section,
  StatusText,
  TableScroll,
  useToast,
} from "../components/ui";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

interface McpData {
  servers: McpServersResponse;
  tools: McpToolsResponse;
}

interface McpForm {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpServerConfig["transport"];
  command: string;
  argsText: string;
  url: string;
  headersText: string;
  toolTimeoutSec: number;
}

function newMcpForm(): McpForm {
  return {
    id: "",
    name: "",
    enabled: true,
    transport: "stdio",
    command: "",
    argsText: "",
    url: "",
    headersText: "",
    toolTimeoutSec: 30,
  };
}

function formFromServer(server: McpServerConfig): McpForm {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command,
    argsText: server.args.join("\n"),
    url: server.url,
    headersText: formatHeaderLines(server.headers),
    toolTimeoutSec: server.toolTimeoutSec,
  };
}

function validate(form: McpForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!ID_PATTERN.test(form.id.trim())) {
    errors["id"] = "Строчные латинские буквы, цифры, дефис и подчёркивание; первый символ — буква или цифра.";
  }
  if (form.name.trim() === "") errors["name"] = "Укажите название сервера.";
  if (form.transport === "stdio") {
    if (form.command.trim() === "") errors["command"] = "Укажите команду запуска.";
  } else {
    if (form.url.trim() === "") {
      errors["url"] = "Укажите адрес сервера.";
    } else if (!isValidHttpUrl(form.url.trim())) {
      errors["url"] = "Адрес должен начинаться с http:// или https://.";
    }
  }
  if (form.headersText.trim() !== "") {
    const parsed = parseHeaderLines(form.headersText);
    if (parsed.error) errors["headers"] = parsed.error;
  }
  if (form.toolTimeoutSec < 1 || form.toolTimeoutSec > 600) {
    errors["timeout"] = "Таймаут от 1 до 600 секунд.";
  }
  return errors;
}

export function McpPage() {
  useDocumentTitle("MCP");
  const notify = useToast();
  const load = useCallback(async (signal: AbortSignal): Promise<McpData> => {
    const [servers, tools] = await Promise.all([api.mcpServers(signal), api.mcpTools(signal)]);
    return { servers, tools };
  }, []);
  const { data, loading, error, reload } = useLoader(load, []);

  const [form, setForm] = useState<McpForm | null>(null);
  const [baseline, setBaseline] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProviderHealth>>({});
  const nameInput = useRef<HTMLInputElement>(null);
  const formOpen = form !== null;

  useUnsavedChanges(formOpen && baseline !== "" && JSON.stringify(form) !== baseline);

  useEffect(() => {
    if (formOpen) nameInput.current?.focus();
  }, [formOpen]);

  const openNew = () => {
    const next = newMcpForm();
    setForm(next);
    setBaseline(JSON.stringify(next));
    setEditingId(null);
    setFormErrors({});
    setSaveError(null);
    setConfirmDelete(false);
    setDeleteError(null);
  };

  const openEdit = (server: McpServerConfig) => {
    const next = formFromServer(server);
    setForm(next);
    setBaseline(JSON.stringify(next));
    setEditingId(server.id);
    setFormErrors({});
    setSaveError(null);
    setConfirmDelete(false);
    setDeleteError(null);
  };

  const closeForm = () => {
    setForm(null);
    setBaseline("");
    setEditingId(null);
    setFormErrors({});
    setSaveError(null);
    setConfirmDelete(false);
    setDeleteError(null);
  };

  const update = (patch: Partial<McpForm>) => {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setFormErrors({});
    setSaveError(null);
  };

  const dirty = form !== null && JSON.stringify(form) !== baseline;

  const confirmDiscard = () =>
    !dirty || window.confirm("Закрыть форму и потерять несохранённые изменения?");

  const requestClose = () => {
    if (!confirmDiscard()) return;
    closeForm();
  };

  const requestEdit = (server: McpServerConfig) => {
    if (!confirmDiscard()) return;
    openEdit(server);
  };

  const save = async () => {
    if (!form) return;
    const validation = validate(form);
    if (Object.keys(validation).length > 0) {
      setFormErrors(validation);
      setSaveError("Проверьте выделенные поля.");
      return;
    }
    const headers = parseHeaderLines(form.headersText).headers;
    const payload: McpServerConfig = {
      id: form.id.trim(),
      name: form.name.trim(),
      enabled: form.enabled,
      transport: form.transport,
      command: form.transport === "stdio" ? form.command.trim() : "",
      args: form.transport === "stdio" ? parseArgLines(form.argsText) : [],
      url: form.transport === "stdio" ? "" : form.url.trim(),
      headers,
      toolTimeoutSec: form.toolTimeoutSec,
    };
    setSaving(true);
    setSaveError(null);
    try {
      if (editingId === null) {
        await api.createMcpServer(payload);
        notify("Сервер MCP добавлен.");
      } else {
        await api.updateMcpServer(editingId, payload);
        notify("Сервер MCP сохранён.");
      }
      closeForm();
      reload();
    } catch (caught) {
      setSaveError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (editingId === null) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteMcpServer(editingId);
      notify("Сервер MCP удалён.");
      closeForm();
      reload();
    } catch (caught) {
      setDeleteError(errorText(caught));
    } finally {
      setDeleting(false);
    }
  };

  const test = async (id: string) => {
    setTestingId(id);
    try {
      const result = await api.testMcpServer(id);
      setTestResults((current) => ({ ...current, [id]: result }));
    } catch (caught) {
      setTestResults((current) => ({
        ...current,
        [id]: { ok: false, detail: errorText(caught) },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const servers = data?.servers.servers ?? [];
  const tools = data?.tools.tools ?? [];

  return (
    <div className="page">
      <PageHeader
        title="MCP"
        description="Подключения к серверам Model Context Protocol и инструменты, которые они отдают модели."
        actions={
          <button type="button" className="btn btn--secondary" onClick={reload} disabled={loading}>
            {loading ? "Обновление…" : "Обновить"}
          </button>
        }
      />

      {!data && loading ? <LoadingBlock label="Загружаю серверы MCP…" /> : null}
      {!data && error ? <ErrorBlock message={error} onRetry={reload} /> : null}
      {data && error ? (
        <Notice kind="error">
          Не удалось обновить данные MCP: {error}{" "}
          <button type="button" className="btn btn--quiet" onClick={reload}>
            Повторить
          </button>
        </Notice>
      ) : null}

      {data ? (
        <>
          <Section
            id="servers"
            title="Серверы"
            actions={
              formOpen ? (
                <button type="button" className="btn btn--quiet" onClick={requestClose}>
                  Закрыть форму
                </button>
              ) : servers.length > 0 ? (
                <button type="button" className="btn btn--primary" onClick={openNew}>
                  Добавить сервер
                </button>
              ) : undefined
            }
          >
            {servers.length === 0 ? (
              <EmptyState
                action={
                  <button type="button" className="btn btn--primary" onClick={openNew}>
                    Добавить сервер
                  </button>
                }
              >
                Серверы MCP не подключены. Модель сможет пользоваться только инструментами Home
                Assistant и планировщика.
              </EmptyState>
            ) : (
              <TableScroll label="Серверы MCP">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Сервер</th>
                      <th scope="col" className="col-secondary">
                        Транспорт
                      </th>
                      <th scope="col">Состояние</th>
                      <th scope="col" className="col-secondary num">
                        Инструментов
                      </th>
                      <th scope="col">Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {servers.map((server) => {
                      const result = testResults[server.id];
                      const tone = !server.enabled
                        ? "neutral"
                        : server.connected
                          ? "ok"
                          : "error";
                      const statusLabel = !server.enabled
                        ? "Отключён"
                        : server.connected
                          ? "Подключён"
                          : "Нет связи";
                      return (
                        <tr key={server.id}>
                          <td>
                            <span className="cell-title">{server.name}</span>
                            <span className="cell-sub mono">{server.id}</span>
                          </td>
                          <td className="col-secondary mono">{server.transport}</td>
                          <td>
                            <StatusText tone={tone}>{statusLabel}</StatusText>
                            {server.error ? (
                              <span className="cell-note cell-note--error">{server.error}</span>
                            ) : null}
                          </td>
                          <td className="col-secondary num">{server.tools.length}</td>
                          <td>
                            <div className="row-actions">
                              <button
                                type="button"
                                className="btn btn--quiet"
                                onClick={() => requestEdit(server)}
                              >
                                Изменить
                              </button>
                              <button
                                type="button"
                                className="btn btn--quiet"
                                onClick={() => void test(server.id)}
                                disabled={testingId === server.id}
                              >
                                {testingId === server.id ? "Проверка…" : "Проверить"}
                              </button>
                            </div>
                            {result ? (
                              <span
                                className={`cell-note${result.ok ? "" : " cell-note--error"}`}
                              >
                                {result.ok ? "Проверка прошла" : `Проверка: ${result.detail}`}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Section>

          {form ? (
            <Section
              id="server-form"
              title={editingId === null ? "Новый сервер" : "Изменить сервер"}
              description={
                editingId === null
                  ? "Идентификатор используется в именах инструментов: mcp.<id>.<tool>."
                  : "Идентификатор нельзя изменить после создания."
              }
            >
              <div className="form">
                <div className="field-row">
                  <Field
                    id="mcp-id"
                    label="Идентификатор"
                    hint="Строчные латинские буквы, цифры, дефис и подчёркивание."
                    error={formErrors["id"]}
                  >
                    <input
                      id="mcp-id"
                      type="text"
                      spellCheck={false}
                      value={form.id}
                      disabled={editingId !== null}
                      onChange={(event) => update({ id: event.target.value })}
                      aria-invalid={formErrors["id"] !== undefined}
                    />
                  </Field>
                  <Field id="mcp-name" label="Название" error={formErrors["name"]}>
                    <input
                      id="mcp-name"
                      type="text"
                      ref={nameInput}
                      value={form.name}
                      onChange={(event) => update({ name: event.target.value })}
                      aria-invalid={formErrors["name"] !== undefined}
                    />
                  </Field>
                </div>

                <CheckboxField
                  id="mcp-enabled"
                  label="Сервер включён"
                  checked={form.enabled}
                  onChange={(checked) => update({ enabled: checked })}
                  hint="Отключённый сервер не подключается и не отдаёт инструменты."
                />

                <Field
                  id="mcp-transport"
                  label="Транспорт"
                  hint="stdio — локальный процесс. http или sse — сетевой сервер."
                >
                  <select
                    id="mcp-transport"
                    value={form.transport}
                    onChange={(event) =>
                      update({
                        transport:
                          event.target.value === "http"
                            ? "http"
                            : event.target.value === "sse"
                              ? "sse"
                              : "stdio",
                      })
                    }
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">http</option>
                    <option value="sse">sse</option>
                  </select>
                </Field>

                {form.transport === "stdio" ? (
                  <>
                    <Field
                      id="mcp-command"
                      label="Команда"
                      hint="Например, имя исполняемого файла сервера."
                      error={formErrors["command"]}
                    >
                      <input
                        id="mcp-command"
                        type="text"
                        spellCheck={false}
                        value={form.command}
                        onChange={(event) => update({ command: event.target.value })}
                        aria-invalid={formErrors["command"] !== undefined}
                      />
                    </Field>
                    <Field
                      id="mcp-args"
                      label="Аргументы"
                      hint="По одному аргументу на строку."
                    >
                      <textarea
                        id="mcp-args"
                        rows={4}
                        spellCheck={false}
                        value={form.argsText}
                        onChange={(event) => update({ argsText: event.target.value })}
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field
                      id="mcp-url"
                      label="Адрес"
                      hint="Полный URL сервера MCP."
                      error={formErrors["url"]}
                    >
                      <input
                        id="mcp-url"
                        type="url"
                        spellCheck={false}
                        value={form.url}
                        onChange={(event) => update({ url: event.target.value })}
                        aria-invalid={formErrors["url"] !== undefined}
                      />
                    </Field>
                    <Field
                      id="mcp-headers"
                      label="Заголовки"
                      hint="По одному на строку в формате «Имя: значение»."
                      error={formErrors["headers"]}
                    >
                      <textarea
                        id="mcp-headers"
                        rows={4}
                        spellCheck={false}
                        value={form.headersText}
                        onChange={(event) => update({ headersText: event.target.value })}
                        aria-invalid={formErrors["headers"] !== undefined}
                      />
                    </Field>
                  </>
                )}

                <NumberField
                  id="mcp-timeout"
                  label="Таймаут инструмента, с"
                  value={form.toolTimeoutSec}
                  min={1}
                  max={600}
                  step={1}
                  hint="Сколько ждать ответа инструмента до ошибки."
                  error={formErrors["timeout"]}
                  onChange={(value) => update({ toolTimeoutSec: value })}
                />
              </div>

              {saveError ? <Notice kind="error">{saveError}</Notice> : null}
              {deleteError ? <Notice kind="error">{deleteError}</Notice> : null}

              {confirmDelete ? (
                <div className="confirm-row" role="group" aria-label="Подтверждение удаления">
                  <span>Удалить сервер «{form.name || form.id}»?</span>
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => void remove()}
                    disabled={deleting}
                  >
                    {deleting ? "Удаление…" : "Удалить"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--quiet"
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                  >
                    Отмена
                  </button>
                </div>
              ) : null}

              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                  title={!dirty ? "Изменений нет" : undefined}
                >
                  {saving ? "Сохранение…" : editingId === null ? "Добавить" : "Сохранить"}
                </button>
                <button type="button" className="btn btn--secondary" onClick={requestClose}>
                  Отмена
                </button>
                {editingId !== null ? (
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => setConfirmDelete(true)}
                    disabled={confirmDelete}
                  >
                    Удалить
                  </button>
                ) : null}
                <span className="form-actions-state" aria-live="polite">
                  {dirty ? "Есть несохранённые изменения." : "Изменений нет."}
                </span>
              </div>
            </Section>
          ) : null}

          <Section id="tools" title="Инструменты">
            {tools.length === 0 ? (
              <EmptyState>
                Подключённые серверы не отдают инструменты. Проверьте подключение или добавьте
                сервер.
              </EmptyState>
            ) : (
              <TableScroll label="Инструменты MCP">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Инструмент</th>
                      <th scope="col">Сервер</th>
                      <th scope="col">Описание</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tools.map((tool) => (
                      <tr key={tool.name}>
                        <td className="mono">{tool.name}</td>
                        <td className="mono">{tool.serverId}</td>
                        <td className="cell-detail">{tool.description || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Section>
        </>
      ) : null}
    </div>
  );
}
