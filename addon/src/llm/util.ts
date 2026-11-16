/**
 * Helpers shared by the LLM providers and the brain module (same addon module).
 * Kept inside addon/src/{llm,brain} so providers do not depend on addon-core utilities.
 */

// ───────────────────────────────────────────────────────────────────── time ──

/** IANA time zone used for spoken dates/times and scheduled one-shot actions. */
export const MOSCOW_TIME_ZONE = "Europe/Moscow";

export interface MoscowClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of `epochMs` in Europe/Moscow. */
export function moscowClock(epochMs: number): MoscowClock {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Epoch milliseconds for a Moscow wall-clock time (handles the fixed UTC+3 offset). */
function moscowEpoch(year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const wall = moscowClock(guess);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const offsetMs = wallAsUtc - guess;
  return guess - offsetMs;
}

/** Next occurrence of a Moscow wall-clock time; rolls to tomorrow when already past. */
export function nextMoscowClock(hour: number, minute: number, now: number): number {
  const today = moscowClock(now);
  const candidate = moscowEpoch(today.year, today.month, today.day, hour, minute);
  if (candidate > now) return candidate;
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return moscowEpoch(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute);
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

/** "11:36" in Moscow. */
export function formatMoscowTime(now: number): string {
  const clock = moscowClock(now);
  return `${twoDigits(clock.hour)}:${twoDigits(clock.minute)}`;
}

/** "16 ноября 2026" in Moscow. */
export function formatMoscowDate(now: number): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(new Date(now));
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("day")} ${read("month")} ${read("year")}`;
}

/** "понедельник" in Moscow. */
export function formatMoscowWeekday(now: number): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: MOSCOW_TIME_ZONE, weekday: "long" }).format(new Date(now));
}

/** "понедельник, 16 ноября 2026, 11:36" — used in the system prompt. */
export function formatMoscowDateTime(now: number): string {
  return `${formatMoscowWeekday(now)}, ${formatMoscowDate(now)}, ${formatMoscowTime(now)}`;
}

/** ISO 8601 with the Moscow offset, e.g. "2026-11-16T22:00:00+03:00". */
export function formatMoscowIso(epochMs: number): string {
  const clock = moscowClock(epochMs);
  const wallAsUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  const offsetMinutes = Math.round((wallAsUtc - epochMs) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return (
    `${clock.year.toString().padStart(4, "0")}-${twoDigits(clock.month)}-${twoDigits(clock.day)}` +
    `T${twoDigits(clock.hour)}:${twoDigits(clock.minute)}:${twoDigits(clock.second)}` +
    `${sign}${twoDigits(Math.floor(absolute / 60))}:${twoDigits(absolute % 60)}`
  );
}

/** "22:00" from separate hour/minute values. */
export function formatClock(hour: number, minute: number): string {
  return `${twoDigits(hour)}:${twoDigits(minute)}`;
}

// ─────────────────────────────────────────────────────────────────── errors ──

/** Human-readable error text without stack traces. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "unknown error";
}

/** Replaces every occurrence of a secret so API keys never reach logs or HTTP responses. */
export function redactSecret(text: string, secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length === 0) return text;
  return text.split(trimmed).join("***");
}

/** Collapses whitespace and truncates an external response body for error details. */
export function shortenDetail(text: string, limit = 300): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

/** Error used when a transport is aborted, mirroring fetch's AbortError. */
export function abortedError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Parses JSON, returning undefined for non-JSON input (tool output may be plain text). */
export function tryParseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: callers fall back to treating the content as plain text.
    return undefined;
  }
}

/** A plain object from arbitrary parsed JSON, or undefined. */
export function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────── abort ──

export interface AbortScope {
  signal: AbortSignal;
  /** True when this scope aborted the request because of its own timeout. */
  timedOut(): boolean;
  dispose(): void;
}

/**
 * Timeout-bounded abort signal linked to a parent signal. The timer is always cleared by
 * dispose(), so a pending request cannot keep the process alive after the turn ends.
 */
export function createAbortScope(timeoutMs: number, parent?: AbortSignal): AbortScope {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted === true) controller.abort(parent.reason);
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────── url ──

/** Joins a base URL and a path with exactly one slash. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  if (base.length === 0) return suffix;
  return `${base}/${suffix}`;
}

/** True when the string is an absolute http(s) URL (local providers require one). */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}
