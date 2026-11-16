/**
 * Recurring scheduling: parse Russian phrases ("каждый день в 8:30", "по будням в 7",
 * "каждую субботу в 10") and apply them either as a native HA automation or through the
 * internal SQLite fallback (schedule/recurring-runner.ts).
 *
 * Native path: HA core exposes POST /api/config/automation/config/<config_key> (admin only,
 * see homeassistant/components/config/automation.py). It validates the automation dict,
 * writes it to automations.yaml and reloads automations itself. HaClientLike cannot issue
 * raw REST calls, so index.ts injects a narrow HaAutomationConfigWriter; when it is absent
 * or the call fails, the caller must fall back to the internal scheduler.
 */

import { randomUUID } from "node:crypto";

import type {
  HaClientLike,
  LoggerLike,
  SchedulerAction,
} from "../shared/types.js";

export type RecurringKind = "daily" | "weekdays" | "weekly";

export interface RecurringSpec {
  kind: RecurringKind;
  /** Local wall-clock time "HH:MM". */
  time: string;
  /** ISO weekdays 1=Monday..7=Sunday; set for "weekdays" and "weekly". */
  weekdays?: number[];
}

export interface ParsedRecurring extends RecurringSpec {
  /** Fragment of the source phrase that was recognized. */
  matched: string;
}

const WEEKDAY_NAMES_RU: Readonly<Record<number, string>> = {
  1: "понедельник",
  2: "вторник",
  3: "среду",
  4: "четверг",
  5: "пятницу",
  6: "субботу",
  7: "воскресенье",
};

const HA_WEEKDAYS: Readonly<Record<number, string>> = {
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
  7: "sun",
};

const WEEKDAY_WORD_TO_ISO: Readonly<Record<string, number>> = {
  понедельник: 1,
  понедельникам: 1,
  вторник: 2,
  вторникам: 2,
  среда: 3,
  среду: 3,
  средам: 3,
  четверг: 4,
  четвергам: 4,
  пятница: 5,
  пятницу: 5,
  пятницам: 5,
  суббота: 6,
  субботу: 6,
  субботам: 6,
  воскресенье: 7,
  воскресеньям: 7,
};

const ALL_WORKDAYS: readonly number[] = [1, 2, 3, 4, 5];

const WORKDAYS_RE = /(?<!\p{L})(?:по\s+будням|в\s+будни|по\s+рабочим\s+дням)(?!\p{L})/u;
const WEEKLY_RE = /(?<!\p{L})кажд(?:ый|ую)\s+(\p{L}+)(?!\p{L})/u;
const WEEKLY_PLURAL_RE = /(?<!\p{L})по\s+(\p{L}+)(?!\p{L})/u;
const DAILY_RE =
  /(?<!\p{L})(кажд(?:ый|ое|ую)\s+(?:день|утро|вечер|ночь)|ежедневно)(?!\p{L})/u;
const EVENING_RE = /(?<!\p{L})(?:вечер|вечера|вечером)(?!\p{L})/u;
const AFTERNOON_RE = /(?<!\p{L})(?:дня|днем|после обеда)(?!\p{L})/u;

interface TimeMatch {
  time: string;
  start: number;
  end: number;
}

interface RecurrenceMatch {
  kind: RecurringKind;
  weekdays?: number[];
  /** Used when the phrase names only a part of the day ("каждый вечер"). */
  defaultTime: string | null;
  start: number;
  end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTime(hours: number, minutes: number): string {
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function splitTime(time: string): { hours: number; minutes: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(time);
  if (match === null) throw new Error(`invalid recurring time "${time}" (expected HH:MM)`);
  const hours = match[1];
  const minutes = match[2];
  if (hours === undefined || minutes === undefined) {
    throw new Error(`invalid recurring time "${time}" (expected HH:MM)`);
  }
  return { hours: Number(hours), minutes: Number(minutes) };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/gu, "е");
}

/** Adjust a bare hour with a part-of-day word: "в 8 вечера" -> 20:00. */
function applyDayPart(hours: number, text: string): number {
  if (hours >= 12) return hours;
  if (EVENING_RE.test(text)) return hours + 12;
  if (AFTERNOON_RE.test(text) && hours >= 1 && hours <= 6) return hours + 12;
  return hours;
}

const TIME_PATTERNS: ReadonlyArray<{
  re: RegExp;
  minutesGroup: 0 | 2;
}> = [
  // "в 8:30", "в 8.30"
  { re: /(?<!\p{L})(?:в|к)\s+(\d{1,2})[:.](\d{2})(?!\d)/u, minutesGroup: 2 },
  // "в 8 30"
  { re: /(?<!\p{L})(?:в|к)\s+(\d{1,2})\s+(\d{2})(?!\d)/u, minutesGroup: 2 },
  // "в 8 часов 30 минут", "в 8 часов"
  {
    re: /(?<!\p{L})(?:в|к)\s+(\d{1,2})\s+час(?:а|ов)?(?:\s+(\d{1,2})\s+минут(?:ы)?)?(?!\p{L})/u,
    minutesGroup: 2,
  },
  // "в 8"
  { re: /(?<!\p{L})(?:в|к)\s+(\d{1,2})(?!\d)/u, minutesGroup: 0 },
];

function findTime(text: string): TimeMatch | null {
  for (const pattern of TIME_PATTERNS) {
    const match = pattern.re.exec(text);
    if (match === null) continue;
    const hoursRaw = match[1];
    if (hoursRaw === undefined) continue;
    const minutesRaw = pattern.minutesGroup === 2 ? match[2] : undefined;
    const hours = applyDayPart(Number(hoursRaw), text);
    const minutes = minutesRaw === undefined ? 0 : Number(minutesRaw);
    if (!Number.isInteger(hours) || hours < 0 || hours > 23) return null;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
    return {
      time: formatTime(hours, minutes),
      start: match.index,
      end: match.index + match[0].length,
    };
  }
  return null;
}

function parseWeekdayWord(word: string): number | null {
  const iso = WEEKDAY_WORD_TO_ISO[word];
  return iso === undefined ? null : iso;
}

function detectRecurrence(text: string): RecurrenceMatch | null {
  const workdays = WORKDAYS_RE.exec(text);
  if (workdays !== null) {
    return {
      kind: "weekdays",
      weekdays: [...ALL_WORKDAYS],
      defaultTime: null,
      start: workdays.index,
      end: workdays.index + workdays[0].length,
    };
  }

  const weekly = WEEKLY_RE.exec(text);
  if (weekly !== null) {
    const word = weekly[1];
    if (word !== undefined) {
      const iso = parseWeekdayWord(word);
      if (iso !== null) {
        return {
          kind: "weekly",
          weekdays: [iso],
          defaultTime: null,
          start: weekly.index,
          end: weekly.index + weekly[0].length,
        };
      }
    }
  }

  const weeklyPlural = WEEKLY_PLURAL_RE.exec(text);
  if (weeklyPlural !== null) {
    const word = weeklyPlural[1];
    if (word !== undefined) {
      const iso = parseWeekdayWord(word);
      if (iso !== null) {
        return {
          kind: "weekly",
          weekdays: [iso],
          defaultTime: null,
          start: weeklyPlural.index,
          end: weeklyPlural.index + weeklyPlural[0].length,
        };
      }
    }
  }

  const daily = DAILY_RE.exec(text);
  if (daily !== null) {
    const phrase = daily[1] ?? "";
    let defaultTime: string | null = null;
    if (phrase.includes("утро")) defaultTime = "08:00";
    else if (phrase.includes("вечер")) defaultTime = "20:00";
    else if (phrase.includes("ночь")) defaultTime = "23:00";
    return {
      kind: "daily",
      defaultTime,
      start: daily.index,
      end: daily.index + daily[0].length,
    };
  }

  return null;
}

/**
 * Parse a recurring phrase. Returns null when no recurrence pattern or usable time is found.
 * `now` is validated so callers get a clear error instead of an invalid schedule.
 */
export function parseRecurringRu(text: string, now: Date): ParsedRecurring | null {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("parseRecurringRu: now must be a valid Date");
  }
  const normalized = normalize(text);
  const recurrence = detectRecurrence(normalized);
  if (recurrence === null) return null;

  const timeMatch = findTime(normalized);
  const time = timeMatch === null ? recurrence.defaultTime : timeMatch.time;
  if (time === null) return null;

  const start = Math.min(recurrence.start, timeMatch?.start ?? recurrence.start);
  const end = Math.max(recurrence.end, timeMatch?.end ?? recurrence.end);
  const matched = text.slice(start, end).trim();

  const parsed: ParsedRecurring = { kind: recurrence.kind, time, matched };
  if (recurrence.weekdays !== undefined) parsed.weekdays = [...recurrence.weekdays];
  return parsed;
}

// ─────────────────────────────────────────────────────────────── spec I/O ──

function readSpecTime(value: unknown): string {
  if (typeof value !== "string") throw new Error("recurring spec: time must be a string");
  splitTime(value);
  return value;
}

function readSpecWeekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("recurring spec: weekdays must be a non-empty array");
  }
  const days: number[] = [];
  for (const raw of value) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 7) {
      throw new Error("recurring spec: weekdays must be ISO numbers 1..7");
    }
    if (!days.includes(raw)) days.push(raw);
  }
  return days.sort((left, right) => left - right);
}

/** Validate a spec read back from SQLite or another untrusted boundary. */
export function parseRecurringSpec(value: unknown): RecurringSpec {
  if (!isRecord(value)) throw new Error("recurring spec must be an object");
  const kind = value.kind;
  if (kind !== "daily" && kind !== "weekdays" && kind !== "weekly") {
    throw new Error(`recurring spec: unknown kind "${String(kind)}"`);
  }
  const time = readSpecTime(value.time);
  if (kind === "daily") {
    if (value.weekdays !== undefined) {
      throw new Error("recurring spec: daily rule must not have weekdays");
    }
    return { kind, time };
  }
  const weekdays = readSpecWeekdays(value.weekdays);
  if (kind === "weekdays" && weekdays.some((day) => day > 5)) {
    throw new Error("recurring spec: weekdays rule must stay within Monday..Friday");
  }
  return { kind, time, weekdays };
}

export function parseRecurringSpecJson(raw: string, owner: string): RecurringSpec {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${owner}: invalid spec JSON: ${errorMessage(error)}`);
  }
  try {
    return parseRecurringSpec(value);
  } catch (error) {
    throw new Error(`${owner}: ${errorMessage(error)}`);
  }
}

/** Next timestamp strictly after `afterMs` that matches the spec (local wall clock). */
export function nextOccurrence(spec: RecurringSpec, afterMs: number): number {
  const { hours, minutes } = splitTime(spec.time);
  const base = new Date(afterMs);
  if (Number.isNaN(base.getTime())) {
    throw new Error("nextOccurrence: afterMs is not a valid timestamp");
  }
  let weekdays: readonly number[] | null = null;
  if (spec.kind !== "daily") {
    const days = spec.weekdays;
    if (days === undefined || days.length === 0) {
      throw new Error(`nextOccurrence: recurring ${spec.kind} rule has no weekdays`);
    }
    weekdays = days;
  }
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(base.getTime());
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() <= afterMs) continue;
    if (weekdays === null) return candidate.getTime();
    const isoDay = candidate.getDay() === 0 ? 7 : candidate.getDay();
    if (weekdays.includes(isoDay)) return candidate.getTime();
  }
  throw new Error(`nextOccurrence: no matching day within a week for kind "${spec.kind}"`);
}

/** Russian description for speech/logs. */
export function describeRecurring(spec: RecurringSpec): string {
  if (spec.kind === "daily") return `каждый день в ${spec.time}`;
  if (spec.kind === "weekdays") return `по будням в ${spec.time}`;
  const days = (spec.weekdays ?? [])
    .map((day) => WEEKDAY_NAMES_RU[day] ?? String(day))
    .join(" и ");
  return `каждый ${days} в ${spec.time}`;
}

// ─────────────────────────────────────────────────── native HA automation ──

export interface HaAutomationConfigWriter {
  /** Create or update an automation config. HA reloads automations after the write. */
  writeAutomationConfig(configKey: string, config: Record<string, unknown>): Promise<void>;
}

export interface HaRestWriterOptions {
  /** HA Core REST API root, e.g. "http://supervisor/core/api". */
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** Injection point for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * REST writer for /api/config/automation/config/<key>. The endpoint requires an admin token
 * and returns {"result":"ok"}; it rejects invalid automation dicts with HTTP 400.
 */
export function createHaRestAutomationWriter(
  options: HaRestWriterOptions,
): HaAutomationConfigWriter {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
  if (baseUrl.length === 0) {
    throw new Error("createHaRestAutomationWriter: baseUrl is empty");
  }
  const token = options.token.trim();
  if (token.length === 0) {
    throw new Error("createHaRestAutomationWriter: token is empty");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async writeAutomationConfig(
      configKey: string,
      config: Record<string, unknown>,
    ): Promise<void> {
      const url = `${baseUrl}/config/automation/config/${encodeURIComponent(configKey)}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(config),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return;
      const body = await response.text();
      const snippet = body.replace(/\s+/gu, " ").trim().slice(0, 200);
      throw new Error(
        `HA automation config API responded ${response.status}${snippet.length > 0 ? `: ${snippet}` : ""}`,
      );
    },
  };
}

export type AutomationBuildResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; reason: string };

function timeCondition(spec: RecurringSpec): Record<string, unknown> | null {
  if (spec.kind === "daily") return null;
  const mapped = (spec.weekdays ?? [])
    .map((day) => HA_WEEKDAYS[day])
    .filter((day): day is string => day !== undefined);
  if (mapped.length === 0) {
    throw new Error(`buildAutomationConfig: recurring ${spec.kind} rule has no weekdays`);
  }
  return { condition: "time", weekday: mapped };
}

/** Build the automation dict accepted by /api/config/automation/config/<key>. */
export function buildAutomationConfig(
  spec: RecurringSpec,
  action: SchedulerAction,
  label: string,
): AutomationBuildResult {
  if (action.kind !== "ha.call_service") {
    return {
      ok: false,
      reason: "нативную HA automation можно создать только для действия ha.call_service",
    };
  }
  const request = action.request;
  const haAction: Record<string, unknown> = {
    action: `${request.domain}.${request.service}`,
  };
  if (request.target !== undefined) haAction.target = request.target;
  if (request.data !== undefined) haAction.data = request.data;
  const condition = timeCondition(spec);
  const conditions: Record<string, unknown>[] = [];
  if (condition !== null) conditions.push(condition);
  return {
    ok: true,
    config: {
      alias: label.length > 0 ? label : `pulsar-brain: ${describeRecurring(spec)}`,
      description: "Created by pulsar-brain scheduler",
      triggers: [{ trigger: "time", at: `${spec.time}:00` }],
      ...(conditions.length > 0 ? { conditions } : {}),
      actions: [haAction],
      mode: "single",
    },
  };
}

export type CreateHaAutomationResult =
  | { ok: true; automationId: string }
  | { ok: false; error: string };

export interface CreateHaAutomationDeps {
  log: LoggerLike;
  /** Absent when HA REST automation API is not wired; native creation then fails. */
  writer?: HaAutomationConfigWriter;
}

/**
 * Try the native HA path. Callers must fall back to the internal recurring runner on failure;
 * this function never reports success unless HA accepted the config.
 */
export async function createHaAutomation(
  ha: HaClientLike,
  spec: RecurringSpec,
  action: SchedulerAction,
  label: string,
  deps: CreateHaAutomationDeps,
): Promise<CreateHaAutomationResult> {
  const built = buildAutomationConfig(spec, action, label);
  if (!built.ok) {
    deps.log.warn("recurring: native HA automation is not expressible", { reason: built.reason });
    return { ok: false, error: built.reason };
  }
  if (deps.writer === undefined) {
    const error = "REST /api/config/automation/config недоступен: writer не подключён";
    deps.log.warn("recurring: HA automation config writer is not wired", { error });
    return { ok: false, error };
  }

  const automationId = `pulsar_brain_${randomUUID().replace(/-/gu, "")}`;
  try {
    await deps.writer.writeAutomationConfig(automationId, built.config);
  } catch (error) {
    const message = errorMessage(error);
    deps.log.warn("recurring: HA automation config write failed", {
      automationId,
      error: message,
    });
    return { ok: false, error: message };
  }

  try {
    await ha.callService({ domain: "automation", service: "reload" });
  } catch (error) {
    // The config view reloads automations itself; a failed explicit reload is not fatal.
    deps.log.warn("recurring: automation.reload failed after config write", {
      automationId,
      error: errorMessage(error),
    });
  }

  deps.log.info("recurring: native HA automation created", {
    automationId,
    label,
    kind: spec.kind,
    time: spec.time,
  });
  return { ok: true, automationId };
}
