import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { api, errorText } from "../api";
import { formatDateTime } from "../format";
import { useDocumentTitle, useLoader } from "../hooks";
import type { StationEntryDto } from "../../../src/shared/protocol";
import {
  EmptyState,
  ErrorBlock,
  Field,
  LoadingBlock,
  Notice,
  PageHeader,
  Section,
  StatusText,
  TableScroll,
  useToast,
} from "../components/ui";

interface ManualFieldErrors {
  name?: string;
  host?: string;
  port?: string;
}

const DEFAULT_PORT = "6053";

function validateManual(name: string, host: string, portText: string): ManualFieldErrors {
  const errors: ManualFieldErrors = {};
  if (name === "") errors.name = "Введите имя станции.";

  if (host === "") {
    errors.host = "Введите адрес станции.";
  } else if (/\s/.test(host)) {
    errors.host = "Уберите пробелы из адреса.";
  } else if (host.includes("://") || host.includes("/")) {
    errors.host = "Укажите только имя или IP, без схемы и пути.";
  } else if ((host.match(/:/g) ?? []).length === 1) {
    errors.host = "Укажите только адрес: порт вводится отдельно.";
  }

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = "Порт — целое число от 1 до 65535.";
  }
  return errors;
}

export function StationPage() {
  useDocumentTitle("Станция");
  const notify = useToast();
  const load = useCallback((signal: AbortSignal) => api.stations(signal), []);
  const { data, loading, error, reload, refresh } = useLoader(load, []);

  const [bindingEntryId, setBindingEntryId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState(DEFAULT_PORT);
  const [manualPsk, setManualPsk] = useState("");
  const [manualBinding, setManualBinding] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ManualFieldErrors>({});

  const bindDiscovered = async (entry: StationEntryDto) => {
    setBindingEntryId(entry.entry_id);
    setActionError(null);
    try {
      await api.bindStation({ entry_id: entry.entry_id });
      await refresh();
      notify(`Станция «${entry.name}» привязана.`);
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      setBindingEntryId(null);
    }
  };

  const clearBinding = async () => {
    setClearing(true);
    setActionError(null);
    try {
      await api.clearStation();
      await refresh();
      setConfirmClear(false);
      notify("Станция отвязана.");
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      setClearing(false);
    }
  };

  const submitManual = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = manualName.trim();
    const host = manualHost.trim();
    const errors = validateManual(name, host, manualPort.trim());
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setManualBinding(true);
    setManualError(null);
    try {
      await api.bindStation({
        name,
        host,
        port: Number(manualPort),
        ...(manualPsk.trim() !== "" ? { noise_psk: manualPsk.trim() } : {}),
      });
      await refresh();
      notify(`Станция «${name}» привязана.`);
      setManualName("");
      setManualHost("");
      setManualPort(DEFAULT_PORT);
      setManualPsk("");
      setManualOpen(false);
    } catch (caught) {
      setManualError(errorText(caught));
    } finally {
      setManualBinding(false);
    }
  };

  const clearFieldError = (key: keyof ManualFieldErrors) => {
    setFieldErrors((previous) => ({ ...previous, [key]: undefined }));
  };

  const binding = data?.binding ?? null;
  const stations = data?.stations ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Станция"
        description="Колонка, к которой аддон отправляет голосовые команды. Привязка связывает аддон с устройством ESPHome в Home Assistant."
        actions={
          <button type="button" className="btn btn--secondary" onClick={reload} disabled={loading}>
            {loading ? "Обновление…" : "Обновить"}
          </button>
        }
      />

      {!data && loading ? <LoadingBlock label="Загружаю станции…" /> : null}
      {!data && error ? <ErrorBlock message={error} onRetry={reload} /> : null}
      {data && error ? (
        <Notice kind="error">
          Не удалось обновить данные станции: {error}{" "}
          <button type="button" className="btn btn--quiet" onClick={reload}>
            Повторить
          </button>
        </Notice>
      ) : null}
      {actionError ? <Notice kind="error">{actionError}</Notice> : null}

      {data ? (
        <>
          <Section
            id="current"
            title="Текущая станция"
            actions={
              binding && !confirmClear ? (
                <button
                  type="button"
                  className="btn btn--quiet btn--quiet-danger"
                  onClick={() => setConfirmClear(true)}
                >
                  Отвязать
                </button>
              ) : undefined
            }
          >
            {binding ? (
              <>
                <dl className="dl">
                  <dt>Имя</dt>
                  <dd>{binding.name}</dd>
                  <dt>Режим</dt>
                  <dd>
                    {binding.mode === "discovered"
                      ? "Из списка Home Assistant"
                      : "Указана вручную"}
                  </dd>
                  <dt>Адрес</dt>
                  <dd className="mono station-endpoint">
                    {binding.host}:{binding.port}
                  </dd>
                  <dt>Шифрование</dt>
                  <dd>{binding.has_psk ? "PSK сохранён" : "Без PSK"}</dd>
                  <dt>Привязана</dt>
                  <dd className="num">
                    <time dateTime={new Date(binding.bound_at).toISOString()}>
                      {formatDateTime(binding.bound_at)}
                    </time>
                  </dd>
                </dl>
                {confirmClear ? (
                  <div
                    className="confirm-row"
                    role="group"
                    aria-label="Подтверждение отвязки станции"
                  >
                    <span>
                      Отвязать станцию «{binding.name}»? Колонка перестанет получать команды от
                      аддона.
                    </span>
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={() => void clearBinding()}
                      disabled={clearing}
                    >
                      {clearing ? "Отвязываю…" : "Отвязать"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--quiet"
                      onClick={() => setConfirmClear(false)}
                      disabled={clearing}
                    >
                      Отмена
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyState>Выберите станцию из списка ниже или укажите адрес вручную.</EmptyState>
            )}
          </Section>

          <Section
            id="devices"
            title="Устройства ESPHome из Home Assistant"
            description="Список присылает интеграция Pulsar Brain. PSK в списке не передаётся — аддон получает его при привязке."
          >
            {stations.length > 0 && !data.integration_connected ? (
              <p className="station-freshness">
                <StatusText tone="warning">Интеграция не на связи</StatusText>
                <span>Список мог устареть. Проверьте интеграцию и нажмите «Обновить».</span>
              </p>
            ) : null}
            {stations.length === 0 ? (
              <EmptyState
                action={
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={reload}
                    disabled={loading}
                  >
                    {loading ? "Обновление…" : "Обновить"}
                  </button>
                }
              >
                {data.integration_connected ? (
                  <>
                    В Home Assistant нет добавленных устройств ESPHome. Добавьте колонку через
                    интеграцию ESPHome или привяжите её вручную ниже.
                  </>
                ) : (
                  <>
                    Интеграция Pulsar Brain ещё не прислала список устройств. Проверьте, что
                    интеграция установлена и запущена, затем нажмите «Обновить».
                  </>
                )}
              </EmptyState>
            ) : (
              <TableScroll label="Устройства ESPHome">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Устройство</th>
                      <th scope="col">Адрес</th>
                      <th scope="col" className="col-secondary">
                        MAC
                      </th>
                      <th scope="col">
                        <span className="sr-only">Действие</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stations.map((entry) => {
                      const current =
                        binding?.mode === "discovered" && binding.entry_id === entry.entry_id;
                      const busy = bindingEntryId === entry.entry_id;
                      return (
                        <tr key={entry.entry_id}>
                          <td className="row-head">{entry.name}</td>
                          <td className="mono station-endpoint">
                            {entry.host}:{entry.port}
                          </td>
                          <td className="mono station-mac col-secondary">{entry.mac || "—"}</td>
                          <td>
                            {current ? (
                              <StatusText tone="accent">Текущая</StatusText>
                            ) : (
                              <button
                                type="button"
                                className="btn btn--quiet"
                                onClick={() => void bindDiscovered(entry)}
                                disabled={bindingEntryId !== null}
                                title={
                                  bindingEntryId !== null && !busy
                                    ? "Дождитесь завершения привязки"
                                    : undefined
                                }
                                aria-label={`Привязать станцию «${entry.name}»`}
                              >
                                {busy ? "Привязка…" : "Привязать"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Section>

          <Section
            id="manual"
            title="Другой адрес"
            description="Для колонки, которой нет в списке Home Assistant. Адрес, порт и PSK можно посмотреть в записи ESPHome."
          >
            <details
              className="station-manual"
              open={manualOpen}
              onToggle={(event) => setManualOpen(event.currentTarget.open)}
            >
              <summary>Указать адрес вручную</summary>
              <form className="form" onSubmit={(event) => void submitManual(event)} noValidate>
                <Field
                  id="station-name"
                  label="Имя"
                  hint="Как станция будет называться в аддоне."
                  error={fieldErrors.name}
                >
                  <input
                    id="station-name"
                    type="text"
                    spellCheck={false}
                    value={manualName}
                    onChange={(event) => {
                      setManualName(event.target.value);
                      clearFieldError("name");
                    }}
                    aria-invalid={fieldErrors.name !== undefined}
                    aria-describedby={
                      fieldErrors.name
                        ? "station-name-hint station-name-error"
                        : "station-name-hint"
                    }
                  />
                </Field>

                <div className="field-row station-address-row">
                  <Field
                    id="station-host"
                    label="Адрес"
                    hint="Имя хоста или IP из записи ESPHome."
                    error={fieldErrors.host}
                  >
                    <input
                      id="station-host"
                      type="text"
                      spellCheck={false}
                      autoCapitalize="none"
                      value={manualHost}
                      onChange={(event) => {
                        setManualHost(event.target.value);
                        clearFieldError("host");
                      }}
                      aria-invalid={fieldErrors.host !== undefined}
                      aria-describedby={
                        fieldErrors.host
                          ? "station-host-hint station-host-error"
                          : "station-host-hint"
                      }
                    />
                  </Field>
                  <Field
                    id="station-port"
                    label="Порт"
                    hint="По умолчанию 6053."
                    error={fieldErrors.port}
                  >
                    <input
                      id="station-port"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={65535}
                      value={manualPort}
                      onChange={(event) => {
                        setManualPort(event.target.value);
                        clearFieldError("port");
                      }}
                      aria-invalid={fieldErrors.port !== undefined}
                      aria-describedby={
                        fieldErrors.port
                          ? "station-port-hint station-port-error"
                          : "station-port-hint"
                      }
                    />
                  </Field>
                </div>

                <Field
                  id="station-psk"
                  label="PSK"
                  hint="Ключ шифрования из записи ESPHome. Необязателен; на сервере хранится в зашифрованном виде."
                >
                  <input
                    id="station-psk"
                    type="password"
                    autoComplete="new-password"
                    value={manualPsk}
                    onChange={(event) => setManualPsk(event.target.value)}
                  />
                </Field>

                {manualError ? <Notice kind="error">{manualError}</Notice> : null}

                <div className="inline-actions">
                  <button type="submit" className="btn btn--primary" disabled={manualBinding}>
                    {manualBinding ? "Привязка…" : "Привязать вручную"}
                  </button>
                </div>
              </form>
            </details>
          </Section>
        </>
      ) : null}
    </div>
  );
}
