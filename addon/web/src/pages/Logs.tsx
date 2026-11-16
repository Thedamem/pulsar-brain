import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, openLogStream } from "../api";
import type { LogStreamState } from "../api";
import { useDocumentTitle, useLoader } from "../hooks";
import { formatLogTime, formatNumber } from "../format";
import type { LogEntry, LogLevel } from "../../../src/shared/types";
import {
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  Notice,
  PageHeader,
  StatusText,
} from "../components/ui";

const MAX_ENTRIES = 1500;
const MAX_RENDER = 800;
const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error"];

type LevelFilter = "all" | LogLevel;

function mergeEntries(previous: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  if (incoming.length === 0) return previous;
  const bySeq = new Map<number, LogEntry>();
  for (const entry of previous) bySeq.set(entry.seq, entry);
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  const merged = Array.from(bySeq.values()).sort((left, right) => left.seq - right.seq);
  return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged;
}

function streamLabel(state: LogStreamState): string {
  if (state === "open") return "Поток открыт";
  if (state === "connecting") return "Подключение к потоку";
  if (state === "retrying") return "Переподключение";
  return "Поток остановлен";
}

function streamTone(state: LogStreamState): "ok" | "warning" | "error" {
  if (state === "open") return "ok";
  if (state === "error") return "error";
  return "warning";
}

export function LogsPage() {
  useDocumentTitle("Логи");
  const initial = useLoader(
    useCallback((signal: AbortSignal) => api.logs(0, signal), []),
    [],
  );
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [streamState, setStreamState] = useState<LogStreamState>("connecting");
  const [streamError, setStreamError] = useState("");
  const [streamKey, setStreamKey] = useState(0);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!initial.data) return;
    setEntries((previous) => mergeEntries(previous, initial.data?.entries ?? []));
  }, [initial.data]);

  useEffect(() => {
    setStreamState("connecting");
    setStreamError("");
    const stop = openLogStream(
      (batch) => setEntries((previous) => mergeEntries(previous, batch)),
      (state, message) => {
        setStreamState(state);
        setStreamError(message ?? "");
      },
    );
    return stop;
  }, [streamKey]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (level !== "all" && entry.level !== level) return false;
      if (needle === "") return true;
      if (entry.msg.toLowerCase().includes(needle)) return true;
      if (entry.scope.toLowerCase().includes(needle)) return true;
      if (entry.data) {
        try {
          return JSON.stringify(entry.data).toLowerCase().includes(needle);
        } catch {
          return false;
        }
      }
      return false;
    });
  }, [entries, level, query]);

  const visible = filtered.length > MAX_RENDER ? filtered.slice(filtered.length - MAX_RENDER) : filtered;

  useEffect(() => {
    if (!follow) return;
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [follow, visible.length, entries.length, level, query]);

  const resetFilters = () => {
    setQuery("");
    setLevel("all");
  };

  const streamMessage = (
    <span className="stream-state" aria-live="polite">
      <StatusText tone={streamTone(streamState)}>{streamLabel(streamState)}</StatusText>
      {streamError ? <span className="muted"> {streamError}</span> : null}
      {streamState !== "open" ? (
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => setStreamKey((current) => current + 1)}
        >
          Переподключить
        </button>
      ) : null}
    </span>
  );

  return (
    <div className="page">
      <PageHeader
        title="Логи"
        description="Журнал аддона в реальном времени. Автопрокрутка останавливается, когда вы прокручиваете список вверх."
        actions={
          <button
            type="button"
            className="btn btn--secondary"
            onClick={initial.reload}
            disabled={initial.loading}
          >
            {initial.loading ? "Обновление…" : "Обновить"}
          </button>
        }
      />

      <div className="log-toolbar">
        <div className="log-toolbar-field log-toolbar-field--search">
          <label className="field-label" htmlFor="log-search">
            Поиск
          </label>
          <input
            id="log-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Текст, область или данные"
          />
        </div>
        <div className="log-toolbar-field">
          <label className="field-label" htmlFor="log-level">
            Уровень
          </label>
          <select
            id="log-level"
            value={level}
            onChange={(event) => {
              const value = event.target.value;
              setLevel(
                value === "trace" ||
                  value === "debug" ||
                  value === "info" ||
                  value === "warn" ||
                  value === "error"
                  ? value
                  : "all",
              );
            }}
          >
            <option value="all">Все уровни</option>
            {LEVELS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div className="log-toolbar-actions">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              if (follow) {
                setFollow(false);
                return;
              }
              setFollow(true);
              const element = listRef.current;
              if (element) element.scrollTop = element.scrollHeight;
            }}
          >
            {follow ? "Пауза" : "Следовать"}
          </button>
        </div>
      </div>

      <div className="log-status">
        {streamMessage}
        <span className="log-count">
          {formatNumber(filtered.length)} записей
          {filtered.length > visible.length
            ? `. Показаны последние ${formatNumber(visible.length)}.`
            : ""}
        </span>
      </div>

      {!initial.data && initial.loading && entries.length === 0 ? (
        <LoadingBlock label="Загружаю журнал…" />
      ) : null}
      {initial.error && !initial.data ? (
        <ErrorBlock message={initial.error} onRetry={initial.reload} />
      ) : null}
      {initial.error && initial.data ? (
        <Notice kind="error">
          Не удалось загрузить прежние записи: {initial.error}{" "}
          <button type="button" className="btn btn--quiet" onClick={initial.reload}>
            Повторить
          </button>
        </Notice>
      ) : null}

      {filtered.length === 0 && !initial.loading ? (
        entries.length === 0 ? (
          <EmptyState>Журнал пуст. Новые записи появятся здесь по мере работы аддона.</EmptyState>
        ) : (
          <EmptyState
            action={
              <button type="button" className="btn btn--secondary" onClick={resetFilters}>
                Сбросить фильтр
              </button>
            }
          >
            Нет записей по фильтру.
          </EmptyState>
        )
      ) : (
        <div
          className="log-view"
          ref={listRef}
          onScroll={() => {
            const element = listRef.current;
            if (!element) return;
            const atBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight < 24;
            setFollow(atBottom);
          }}
          role="log"
          aria-label="Журнал аддона"
          aria-live="off"
          tabIndex={0}
        >
          {visible.map((entry) => (
            <LogRow key={entry.seq} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function LogRow(props: { entry: LogEntry }) {
  const { entry } = props;
  return (
    <div className={`log-row log-row--${entry.level}`}>
      <span className="log-time">{formatLogTime(entry.ts)}</span>
      <span className={`log-level log-level--${entry.level}`}>{entry.level}</span>
      <span className="log-scope">{entry.scope}</span>
      <div className="log-msg">
        <span className="log-text">{entry.msg}</span>
        {entry.data ? (
          <details className="log-data">
            <summary>Данные</summary>
            <pre>{JSON.stringify(entry.data, null, 2)}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
