import { useCallback, useState } from "react";
import { api, errorText } from "../api";
import { useDocumentTitle, useLoader, useNow } from "../hooks";
import { formatDateTime, formatRelative } from "../format";
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Notice,
  PageHeader,
  Section,
  StatusText,
  TableScroll,
  useToast,
} from "../components/ui";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function targetText(value: unknown): string {
  if (!isRecord(value)) return "";
  const entity = value["entity_id"];
  if (typeof entity === "string") return entity;
  if (Array.isArray(entity)) {
    const ids = entity.filter((item): item is string => typeof item === "string");
    if (ids.length > 0) return ids.join(", ");
  }
  const area = value["area_id"];
  if (typeof area === "string") return `зона ${area}`;
  return "";
}

function actionSummary(action: Record<string, unknown>): string {
  const kind = action["kind"];
  if (kind === "ha.call_service") {
    const request = action["request"];
    if (isRecord(request)) {
      const domain = typeof request["domain"] === "string" ? request["domain"] : "?";
      const service = typeof request["service"] === "string" ? request["service"] : "?";
      const target = targetText(request["target"]);
      return `Home Assistant: ${domain}.${service}${target ? ` → ${target}` : ""}`;
    }
    return "Home Assistant: вызов сервиса";
  }
  if (kind === "announce") {
    const text = action["text"];
    return typeof text === "string" ? `Объявить: «${text}»` : "Объявить текст";
  }
  if (kind === "mcp.tool") {
    const name = action["name"];
    return typeof name === "string" ? `MCP: ${name}` : "MCP: вызов инструмента";
  }
  return "Действие без описания";
}

type PendingAction = { id: string; kind: "run" | "cancel" };

export function SchedulerPage() {
  useDocumentTitle("Планировщик");
  const notify = useToast();
  const load = useCallback((signal: AbortSignal) => api.schedules(signal), []);
  const { data, loading, error, reload } = useLoader(load, []);
  const now = useNow(15_000);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const runNow = async (id: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      const result = await api.runSchedule(id);
      if (result?.ok === false) {
        throw new Error(result.error ?? "Планировщик не выполнил задачу.");
      }
      notify("Действие запущено.");
      setPending(null);
      reload();
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (id: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      await api.cancelSchedule(id);
      notify("Действие отменено.");
      setPending(null);
      reload();
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Планировщик"
        description="Разовые таймеры и отложенные действия. Записи создаются из голосовых команд."
        meta={
          data && data.nextAt
            ? `Ближайшее действие: ${formatDateTime(data.nextAt)} (${formatRelative(data.nextAt, now)})`
            : undefined
        }
        actions={
          <button type="button" className="btn btn--secondary" onClick={reload} disabled={loading}>
            {loading ? "Обновление…" : "Обновить"}
          </button>
        }
      />

      {!data && loading ? <LoadingBlock label="Загружаю планировщик…" /> : null}
      {!data && error ? <ErrorBlock message={error} onRetry={reload} /> : null}
      {data && error ? (
        <Notice kind="error">
          Не удалось обновить планировщик: {error}{" "}
          <button type="button" className="btn btn--quiet" onClick={reload}>
            Повторить
          </button>
        </Notice>
      ) : null}
      {actionError ? <Notice kind="error">{actionError}</Notice> : null}

      {data ? (
        <Section id="schedules" title="Запланированные действия">
          {data.entries.length === 0 ? (
            <EmptyState>
              Запланированных действий нет. Скажите колонке, например: «Алиса, выключи свет
              через 10 минут».
            </EmptyState>
          ) : (
            <TableScroll label="Запланированные действия">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Время</th>
                    <th scope="col">Метка</th>
                    <th scope="col">Действие</th>
                    <th scope="col">Статус</th>
                    <th scope="col">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((entry) => {
                    const overdue = entry.at <= now;
                    const rowPending = pending?.id === entry.id;
                    const busy = busyId === entry.id;
                    return (
                      <tr key={entry.id}>
                        <td>
                          <time className="num" dateTime={new Date(entry.at).toISOString()}>
                            {formatDateTime(entry.at)}
                          </time>
                          <span className="cell-sub">{formatRelative(entry.at, now)}</span>
                        </td>
                        <td>{entry.label}</td>
                        <td className="cell-detail">{actionSummary(entry.action)}</td>
                        <td>
                          <StatusText tone={overdue ? "warning" : "neutral"}>
                            {overdue ? "Просрочено" : "Ожидает"}
                          </StatusText>
                        </td>
                        <td>
                          {rowPending ? (
                            <div className="row-actions">
                              <button
                                type="button"
                                className={
                                  pending.kind === "cancel" ? "btn btn--danger" : "btn btn--primary"
                                }
                                onClick={() =>
                                  pending.kind === "cancel"
                                    ? void cancel(entry.id)
                                    : void runNow(entry.id)
                                }
                                disabled={busy}
                              >
                                {busy
                                  ? "Выполняю…"
                                  : pending.kind === "cancel"
                                    ? "Отменить"
                                    : "Выполнить"}
                              </button>
                              <button
                                type="button"
                                className="btn btn--quiet"
                                onClick={() => setPending(null)}
                                disabled={busy}
                              >
                                Нет
                              </button>
                            </div>
                          ) : (
                            <div className="row-actions">
                              <button
                                type="button"
                                className="btn btn--quiet"
                                onClick={() => setPending({ id: entry.id, kind: "run" })}
                              >
                                Выполнить
                              </button>
                              <button
                                type="button"
                                className="btn btn--quiet"
                                onClick={() => setPending({ id: entry.id, kind: "cancel" })}
                              >
                                Отменить
                              </button>
                            </div>
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
      ) : null}
    </div>
  );
}
