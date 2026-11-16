/**
 * In-process logger with a bounded ring buffer for the UI, SSE subscriptions and
 * one JSON line per entry on stdout (as HA addon logs expect).
 *
 * Secrets are never written: data fields whose key looks sensitive are masked
 * recursively, empty strings stay empty.
 */

import type { LogEntry, LoggerLike, LogLevel } from "../shared/types.js";
import { SECRET_MASK, maskSecret } from "../secrets/crypto.js";

const DEFAULT_CAPACITY = 2000;
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};
const LOG_LEVELS: ReadonlySet<string> = new Set(["trace", "debug", "info", "warn", "error"]);
const SENSITIVE_KEY_RE = /(pass(word|phrase)?|secret|token|api[-_]?key|authorization|cookie|credential)/i;
const MAX_REDACT_DEPTH = 6;

export interface Logger extends LoggerLike {
  level(): LogLevel;
  setLevel(level: LogLevel): void;
}

export interface LoggerOptions {
  /** Initial level; PULSAR_BRAIN_LOG_LEVEL wins when set. Defaults to "info". */
  level?: LogLevel;
  /** Ring buffer size. Defaults to 2000 entries. */
  capacity?: number;
  /** Sink for JSON lines; defaults to process.stdout. */
  write?: (line: string) => void;
  /** Environment source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

interface LoggerCore {
  entries: LogEntry[];
  capacity: number;
  level: LogLevel;
  seq: number;
  listeners: Set<(entry: LogEntry) => void>;
  write: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const core: LoggerCore = {
    entries: [],
    capacity: Math.max(1, options.capacity ?? DEFAULT_CAPACITY),
    level: resolveLevel(env.PULSAR_BRAIN_LOG_LEVEL) ?? options.level ?? "info",
    seq: 0,
    listeners: new Set(),
    write,
  };
  return createScopedLogger(core, "");
}

function resolveLevel(value: string | undefined): LogLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized && LOG_LEVELS.has(normalized)) return normalized as LogLevel;
  return undefined;
}

function createScopedLogger(core: LoggerCore, scope: string): Logger {
  const log = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[core.level]) return;
    core.seq += 1;
    const entry: LogEntry = {
      seq: core.seq,
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
    };
    if (data !== undefined) entry.data = redact(data) as Record<string, unknown>;
    core.entries.push(entry);
    if (core.entries.length > core.capacity) core.entries.shift();

    try {
      core.write(`${JSON.stringify(entry)}\n`);
    } catch (err) {
      // A broken stdout must not break request handling; report on stderr instead.
      process.stderr.write(
        `${JSON.stringify({ level: "error", scope: "logger", msg: "stdout write failed", data: { error: String(err) } })}\n`,
      );
    }
    notify(core, entry);
  };

  const logger: Logger = {
    trace: (msg, data) => log("trace", msg, data),
    debug: (msg, data) => log("debug", msg, data),
    info: (msg, data) => log("info", msg, data),
    warn: (msg, data) => log("warn", msg, data),
    error: (msg, data) => log("error", msg, data),
    child(childScope: string): Logger {
      return createScopedLogger(core, scope.length === 0 ? childScope : `${scope}.${childScope}`);
    },
    since(afterSeq: number, limit?: number): LogEntry[] {
      const first = Math.max(0, Math.floor(afterSeq));
      const max = limit === undefined ? core.capacity : Math.max(0, Math.floor(limit));
      const matched: LogEntry[] = [];
      for (const entry of core.entries) {
        if (entry.seq > first) matched.push(entry);
        if (matched.length >= max) break;
      }
      return matched;
    },
    subscribe(listener: (entry: LogEntry) => void): () => void {
      core.listeners.add(listener);
      return () => {
        core.listeners.delete(listener);
      };
    },
    level(): LogLevel {
      return core.level;
    },
    setLevel(level: LogLevel): void {
      core.level = level;
    },
  };
  return logger;
}

function notify(core: LoggerCore, entry: LogEntry): void {
  for (const listener of core.listeners) {
    try {
      listener(entry);
    } catch (err) {
      // Never let one subscriber (e.g. a dead SSE socket) break logging for the rest.
      process.stderr.write(
        `${JSON.stringify({ level: "error", scope: "logger", msg: "log subscriber failed", data: { error: String(err) } })}\n`,
      );
    }
  }
}

/** Recursively masks values under sensitive keys and caps traversal depth. */
function redact(value: unknown, depth = 0): unknown {
  if (depth >= MAX_REDACT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        const masked = typeof item === "string" ? maskSecret(item) : SECRET_MASK;
        redacted[key] = masked;
      } else {
        redacted[key] = redact(item, depth + 1);
      }
    }
    return redacted;
  }
  return value;
}
