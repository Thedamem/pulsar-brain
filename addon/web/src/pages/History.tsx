import { useCallback, useState } from "react";
import { api } from "../api";
import { useDocumentTitle, useLoader, useNow } from "../hooks";
import { formatDateTime, formatDuration, formatRelative, formatTimestamp } from "../format";
import type { RunEndReason, SessionRecord } from "../../../src/shared/types";
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
import { Drawer } from "../components/Drawer";

const SESSION_LIMIT = 50;

const STATE_LABELS: Record<SessionRecord["state"], string> = {
  running: "Идёт",
  finished: "Завершён",
  failed: "Ошибка",
  cancelled: "Отменён",
};

const STATE_TONES: Record<SessionRecord["state"], "accent" | "neutral" | "error" | "warning"> = {
  running: "accent",
  finished: "neutral",
  failed: "error",
  cancelled: "warning",
};

const END_REASON_LABELS: Record<RunEndReason, string> = {
  done: "Завершён",
  cancelled: "Отменён",
  barge_in: "Прерывание",
  timeout: "Таймаут",
  error: "Ошибка",
  no_speech: "Нет речи",
  device_stop: "Остановлен устройством",
};

function sessionDuration(session: SessionRecord, now: number): number | null {
  if (session.endedAt) return session.endedAt - session.startedAt;
  if (session.state === "running") return now - session.startedAt;
  return session.timings.totalMs ?? null;
}

function formatToolArgs(raw: string): string {
  if (raw === "") return "—";
  try {
    const parsed: unknown = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2) ?? raw;
  } catch {
    return raw;
  }
}

export function HistoryPage() {
  useDocumentTitle("История");
  const load = useCallback(
    (signal: AbortSignal) => api.sessions(SESSION_LIMIT, signal),
    [],
  );
  const { data, loading, error, reload } = useLoader(load, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const now = useNow(15_000);

  const detailLoad = useCallback(
    (signal: AbortSignal) =>
      selectedId === null ? Promise.resolve(null) : api.session(selectedId, signal),
    [selectedId],
  );
  const detail = useLoader<SessionRecord | null>(detailLoad, [selectedId]);

  const closeDrawer = useCallback(() => setSelectedId(null), []);
  const selectedSummary = data?.sessions.find((session) => session.id === selectedId);

  return (
    <div className="page">
      <PageHeader
        title="История"
        description={`Последние ${SESSION_LIMIT} сеансов с колонкой. Подробности открываются без перезагрузки страницы.`}
        meta={
          data && data.sessions.length > 0
            ? `Загружено сеансов: ${data.sessions.length}`
            : undefined
        }
        actions={
          data && data.sessions.length > 0 ? (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={reload}
              disabled={loading}
            >
              {loading ? "Обновление…" : "Обновить"}
            </button>
          ) : undefined
        }
      />

      {!data && loading ? <LoadingBlock label="Загружаю сеансы…" /> : null}
      {!data && error ? <ErrorBlock message={error} onRetry={reload} /> : null}
      {data && error ? (
        <Notice kind="error">
          Не удалось обновить историю: {error}{" "}
          <button type="button" className="btn btn--quiet" onClick={reload}>
            Повторить
          </button>
        </Notice>
      ) : null}

      {data ? (
        <Section id="sessions" title="Сеансы">
          {data.sessions.length === 0 ? (
            <EmptyState
              action={
                <button type="button" className="btn btn--secondary" onClick={reload}>
                  Обновить
                </button>
              }
            >
              Сеансов пока нет. История появится, когда колонка обработает первую команду.
            </EmptyState>
          ) : (
            <TableScroll label="Сеансы">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Время</th>
                    <th scope="col">Транскрипт</th>
                    <th scope="col" className="col-secondary">
                      Ответ
                    </th>
                    <th scope="col" className="col-secondary num">
                      Инструменты
                    </th>
                    <th scope="col" className="col-secondary num">
                      Длительность
                    </th>
                    <th scope="col">Состояние</th>
                    <th scope="col">
                      <span className="sr-only">Подробности</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((session) => (
                    <tr key={session.id}>
                      <td>
                        <span className="num">{formatDateTime(session.startedAt)}</span>
                        <span className="cell-sub">{formatRelative(session.startedAt, now)}</span>
                      </td>
                      <td>
                        <span className="cell-clamp">{session.transcript || "—"}</span>
                      </td>
                      <td className="col-secondary">
                        <span className="cell-clamp">{session.response || "—"}</span>
                      </td>
                      <td className="col-secondary num">{session.toolCalls.length}</td>
                      <td className="col-secondary num">
                        {formatDuration(sessionDuration(session, now))}
                      </td>
                      <td>
                        <StatusText tone={STATE_TONES[session.state]}>
                          {STATE_LABELS[session.state]}
                        </StatusText>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--quiet"
                          onClick={() => setSelectedId(session.id)}
                        >
                          Открыть
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </Section>
      ) : null}

      <Drawer
        open={selectedId !== null}
        title="Сеанс"
        description={
          selectedSummary
            ? `${formatTimestamp(selectedSummary.startedAt)}, ${selectedSummary.device.name}`
            : undefined
        }
        onClose={closeDrawer}
      >
        {detail.loading && !detail.data ? <LoadingBlock label="Загружаю сеанс…" /> : null}
        {detail.error && !detail.data ? (
          <ErrorBlock message={detail.error} onRetry={detail.reload} />
        ) : null}
        {detail.data ? (
          <SessionDetail session={detail.data} now={now} />
        ) : null}
      </Drawer>
    </div>
  );
}

function SessionDetail(props: { session: SessionRecord; now: number }) {
  const { session, now } = props;
  const timings = session.timings;
  return (
    <div className="drawer-sections">
      <section className="drawer-section" aria-labelledby="session-facts">
        <h3 id="session-facts">Параметры</h3>
        <dl className="dl dl--compact">
          <dt>Идентификатор</dt>
          <dd className="mono">{session.id}</dd>
          <dt>Устройство</dt>
          <dd>
            {session.device.name}
            <span className="cell-sub">
              {session.device.mac}, прошивка {session.device.firmware || "—"}
            </span>
          </dd>
          <dt>Начат</dt>
          <dd>{formatTimestamp(session.startedAt)}</dd>
          <dt>Завершён</dt>
          <dd>{session.endedAt ? formatTimestamp(session.endedAt) : "—"}</dd>
          <dt>Длительность</dt>
          <dd className="num">{formatDuration(sessionDuration(session, now))}</dd>
          <dt>Состояние</dt>
          <dd>
            <StatusText tone={STATE_TONES[session.state]}>
              {STATE_LABELS[session.state]}
            </StatusText>
            {session.endReason && !(session.state === "finished" && session.endReason === "done") ? (
              <span className="muted">, {END_REASON_LABELS[session.endReason]}</span>
            ) : null}
          </dd>
        </dl>
      </section>

      <section className="drawer-section" aria-labelledby="session-transcript">
        <h3 id="session-transcript">Транскрипт</h3>
        {session.transcript ? (
          <p className="prose">{session.transcript}</p>
        ) : (
          <p className="muted">Речь не распознана.</p>
        )}
      </section>

      <section className="drawer-section" aria-labelledby="session-response">
        <h3 id="session-response">Ответ</h3>
        {session.response ? (
          <p className="prose">{session.response}</p>
        ) : (
          <p className="muted">Ответа нет.</p>
        )}
      </section>

      <section className="drawer-section" aria-labelledby="session-tools">
        <h3 id="session-tools">Инструменты</h3>
        {session.toolCalls.length === 0 ? (
          <p className="muted">Инструменты не вызывались.</p>
        ) : (
          <ol className="tool-list">
            {session.toolCalls.map((call, index) => (
              <li key={`${call.name}-${index}`}>
                <div className="tool-head">
                  <span className="mono">{call.name}</span>
                  <StatusText tone={call.ok ? "ok" : "error"}>
                    {call.ok ? "Успешно" : "Ошибка"}
                  </StatusText>
                </div>
                <pre className="tool-args">{formatToolArgs(call.args)}</pre>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="drawer-section" aria-labelledby="session-timings">
        <h3 id="session-timings">Тайминги</h3>
        <dl className="dl dl--compact">
          <dt>Распознавание</dt>
          <dd className="num">{formatDuration(timings.sttMs)}</dd>
          <dt>Модель</dt>
          <dd className="num">{formatDuration(timings.llmMs)}</dd>
          <dt>Синтез</dt>
          <dd className="num">{formatDuration(timings.ttsMs)}</dd>
          <dt>Всего</dt>
          <dd className="num">{formatDuration(timings.totalMs)}</dd>
        </dl>
      </section>
    </div>
  );
}
