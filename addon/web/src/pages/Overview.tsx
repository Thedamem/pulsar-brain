import { useCallback, useEffect } from "react";
import { api } from "../api";
import { useDocumentTitle, useLoader, useNow } from "../hooks";
import { formatDateTime, formatDuration, formatRelative, formatUptime } from "../format";
import type { StatusResponse } from "../../../src/shared/protocol";
import type { ProviderHealth } from "../../../src/shared/types";
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Notice,
  PageHeader,
  Section,
  StatusText,
  TableScroll,
} from "../components/ui";

const POLL_INTERVAL_MS = 10_000;

interface HealthRow {
  key: string;
  label: string;
  tone: "ok" | "error" | "warning" | "neutral";
  status: string;
  detail: string;
}

function providerHealthRow(key: string, label: string, health: ProviderHealth): HealthRow {
  return {
    key,
    label,
    tone: health.ok ? "ok" : "error",
    status: health.ok ? "В порядке" : "Ошибка",
    detail: health.detail || "—",
  };
}

function mcpHealthRow(
  servers: StatusResponse["health"]["mcp"],
): HealthRow {
  if (servers.length === 0) {
    return {
      key: "mcp",
      label: "MCP",
      tone: "neutral",
      status: "Не настроен",
      detail: "Серверы MCP не добавлены.",
    };
  }
  const failed = servers.filter((server) => !server.connected);
  if (failed.length === 0) {
    return {
      key: "mcp",
      label: "MCP",
      tone: "ok",
      status: "Подключены",
      detail: `${servers.length} из ${servers.length} серверов на связи.`,
    };
  }
  return {
    key: "mcp",
    label: "MCP",
    tone: "error",
    status: "Ошибка",
    detail: failed.map((server) => `${server.id}: ${server.error || "нет связи"}`).join("; "),
  };
}

export function OverviewPage() {
  useDocumentTitle("Обзор");
  const load = useCallback((signal: AbortSignal) => api.status(signal), []);
  const { data, loading, error, reload, refresh } = useLoader(load, []);
  const now = useNow(5000);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const healthRows: HealthRow[] = data
    ? [
        providerHealthRow("stt", "Распознавание речи", data.health.stt),
        providerHealthRow("tts", "Синтез речи", data.health.tts),
        providerHealthRow("ha", "Home Assistant", data.health.ha),
        providerHealthRow("provider", "Провайдер модели", data.health.provider),
        mcpHealthRow(data.health.mcp),
      ]
    : [];

  const bridgeTone = data?.bridge.connected ? "ok" : "error";

  return (
    <div className="page">
      <PageHeader
        title="Обзор"
        description="Состояние аддона и моста к колонке."
        meta={
          data ? (
            <>
              Версия {data.version}, работает {formatUptime(data.uptimeSec)}
            </>
          ) : undefined
        }
        actions={
          <button type="button" className="btn btn--secondary" onClick={reload} disabled={loading}>
            {loading ? "Обновление…" : "Обновить"}
          </button>
        }
      />

      {!data && loading ? <LoadingBlock label="Загружаю состояние…" /> : null}
      {!data && error ? <ErrorBlock message={error} onRetry={reload} /> : null}

      {data ? (
        <>
          {error ? (
            <Notice kind="error">
              Не удалось обновить состояние: {error}{" "}
              <button type="button" className="btn btn--quiet" onClick={reload}>
                Повторить
              </button>
            </Notice>
          ) : null}

          <Section id="bridge" title="Мост">
            <dl className="dl">
              <dt>Состояние</dt>
              <dd>
                <StatusText tone={bridgeTone}>
                  {data.bridge.connected ? "Подключён" : "Нет подключения"}
                </StatusText>
              </dd>
              <dt>Последний сеанс</dt>
              <dd>
                {data.bridge.lastRunAt ? (
                  <>
                    {formatDateTime(data.bridge.lastRunAt)}{" "}
                    <span className="muted">({formatRelative(data.bridge.lastRunAt, now)})</span>
                  </>
                ) : (
                  "Сеансов ещё не было"
                )}
              </dd>
            </dl>
            {!data.bridge.connected ? (
              <p className="prose">
                Мост поднимает интеграция pulsar_brain в Home Assistant. Пока подключения нет,
                голосовые команды с колонки не обрабатываются.
              </p>
            ) : null}
          </Section>

          <Section id="runs" title="Активные сеансы">
            {data.activeRuns.length === 0 ? (
              <EmptyState>Сейчас нет активных сеансов.</EmptyState>
            ) : (
              <TableScroll label="Активные сеансы">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Сеанс</th>
                      <th scope="col">Начат</th>
                      <th scope="col" className="num">
                        Длительность
                      </th>
                      <th scope="col">Состояние</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.activeRuns.map((run) => (
                      <tr key={run.runId}>
                        <td className="mono">{run.runId}</td>
                        <td className="num">{formatDateTime(run.startedAt)}</td>
                        <td className="num">{formatDuration(now - run.startedAt)}</td>
                        <td className="mono">{run.state}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Section>

          <Section id="health" title="Здоровье">
            <TableScroll label="Состояние компонентов">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Компонент</th>
                    <th scope="col">Состояние</th>
                    <th scope="col">Детали</th>
                  </tr>
                </thead>
                <tbody>
                  {healthRows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row" className="row-head">
                        {row.label}
                      </th>
                      <td>
                        <StatusText tone={row.tone}>{row.status}</StatusText>
                      </td>
                      <td className="cell-detail">{row.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </Section>

          <Section id="scheduler" title="Планировщик">
            {data.scheduler.nextAt ? (
              <dl className="dl">
                <dt>Ближайшее действие</dt>
                <dd>
                  {formatDateTime(data.scheduler.nextAt)}{" "}
                  <span className="muted">
                    ({formatRelative(data.scheduler.nextAt, now)})
                  </span>
                </dd>
                <dt>Активных действий</dt>
                <dd className="num">{data.scheduler.active}</dd>
              </dl>
            ) : (
              <EmptyState>Нет запланированных действий.</EmptyState>
            )}
          </Section>

          {data.configWarnings.length > 0 ? (
            <Section id="warnings" title="Предупреждения конфигурации">
              <ul className="warning-list">
                {data.configWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
