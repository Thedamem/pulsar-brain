/**
 * LLM tools for the scheduler: scheduler.add_once / scheduler.cancel / scheduler.list
 * plus scheduler.add_recurring for repeated actions (native HA automation or internal fallback).
 *
 * Argument JSON schemas are canonical: mock-LLM and the orchestrator emit exactly these shapes.
 */

import { z } from "zod";

import type {
  HaCallServiceRequest,
  HaClientLike,
  HaServiceTarget,
  JsonSchema,
  LoggerLike,
  SchedulerAction,
  Tool,
  ToolContext,
  ToolResult,
} from "../shared/types.js";
import type { HaAutomationConfigWriter, ParsedRecurring, RecurringSpec } from "../schedule/recurring.js";
import {
  createHaAutomation,
  describeRecurring,
  parseRecurringRu,
} from "../schedule/recurring.js";
import type { RecurringRunner } from "../schedule/recurring-runner.js";

// ─────────────────────────────────────────────────────────────── schemas ──

const idListSchema = z.union([z.string().min(1), z.array(z.string().min(1)).nonempty()]);

const haRequestInputSchema = z
  .object({
    domain: z.string().min(1),
    service: z.string().min(1),
    entity_id: idListSchema.optional(),
    area_id: idListSchema.optional(),
    device_id: idListSchema.optional(),
    data: z.record(z.unknown()).optional(),
  })
  .strict();

const actionInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ha.call_service"),
      request: haRequestInputSchema,
    })
    .strict(),
  z.object({ kind: z.literal("announce"), text: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("mcp.tool"),
      name: z.string().min(1),
      args: z.record(z.unknown()),
    })
    .strict(),
]);

type ActionInput = z.infer<typeof actionInputSchema>;

const addOnceArgsSchema = z
  .object({
    in_seconds: z.number().finite().positive().optional(),
    at: z.string().min(1).optional(),
    label: z.string().trim().min(1),
    action: actionInputSchema,
  })
  .strict()
  .refine((value) => (value.in_seconds === undefined) !== (value.at === undefined), {
    message: "укажи ровно одно из in_seconds/at",
  });

const cancelArgsSchema = z.object({ id: z.string().min(1) }).strict();

const listArgsSchema = z.object({}).strict();

const addRecurringArgsSchema = z
  .object({
    phrase: z.string().trim().min(1),
    action: actionInputSchema,
    label: z.string().trim().min(1).optional(),
  })
  .strict();

// ─────────────────────────────────────────────────────── JSON schemas (LLM) ──

const ACTION_PARAMETERS: JsonSchema = {
  type: "object",
  description:
    "Действие. Обязателен kind. Для ha.call_service обязателен request {domain, service, ...}.",
  properties: {
    kind: {
      type: "string",
      enum: ["ha.call_service", "announce", "mcp.tool"],
      description: "Вид действия",
    },
    request: {
      type: "object",
      description: "Для kind=ha.call_service: вызов сервиса Home Assistant",
      properties: {
        domain: { type: "string", description: "Домен, например light" },
        service: { type: "string", description: "Сервис, например turn_on" },
        entity_id: {
          type: "string",
          description: "entity_id или массив entity_id (для одной сущности — строка)",
        },
        area_id: { type: "string", description: "area_id или массив area_id, если цели по зоне" },
        device_id: { type: "string", description: "device_id или массив device_id" },
        data: {
          type: "object",
          additionalProperties: true,
          description: "Параметры сервиса, например {\"brightness_pct\": 40}",
        },
      },
      required: ["domain", "service"],
    },
    text: { type: "string", description: "Для kind=announce: что произнести" },
    name: { type: "string", description: "Для kind=mcp.tool: имя инструмента mcp.<server>.<tool>" },
    args: {
      type: "object",
      additionalProperties: true,
      description: "Для kind=mcp.tool: аргументы инструмента",
    },
  },
  required: ["kind"],
};

const ADD_ONCE_PARAMETERS: JsonSchema = {
  type: "object",
  properties: {
    in_seconds: {
      type: "number",
      description: "Через сколько секунд выполнить. Ровно одно из in_seconds/at.",
    },
    at: {
      type: "string",
      description:
        "Момент выполнения, ISO 8601 с часовым поясом, например 2026-11-16T22:00:00+03:00. Ровно одно из in_seconds/at.",
    },
    label: { type: "string", description: "Короткое описание действия для пользователя" },
    action: ACTION_PARAMETERS,
  },
  required: ["label", "action"],
  additionalProperties: false,
};

const CANCEL_PARAMETERS: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "id запланированной задачи или \"all\" — отменить все" },
  },
  required: ["id"],
  additionalProperties: false,
};

const LIST_PARAMETERS: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const ADD_RECURRING_PARAMETERS: JsonSchema = {
  type: "object",
  properties: {
    phrase: {
      type: "string",
      description:
        "Фраза с расписанием: «каждый день в 8:30», «по будням в 7», «каждую субботу в 10».",
    },
    action: ACTION_PARAMETERS,
    label: { type: "string", description: "Короткое описание действия для пользователя" },
  },
  required: ["phrase", "action"],
  additionalProperties: false,
};

// ─────────────────────────────────────────────────────────────── helpers ──

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTimeOfDay(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function speechForSchedule(at: number, nowMs: number): string {
  const date = new Date(at);
  const time = formatTimeOfDay(at);
  const nowDate = new Date(nowMs);
  if (date.toDateString() === nowDate.toDateString()) return `Выполню в ${time}`;
  const tomorrow = new Date(nowMs);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `Выполню завтра в ${time}`;
  return `Выполню ${date.getDate()}.${pad(date.getMonth() + 1)} в ${time}`;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function describeAction(action: SchedulerAction): string {
  switch (action.kind) {
    case "ha.call_service":
      return `${action.request.domain}.${action.request.service}`;
    case "announce":
      return `объявление «${action.text}»`;
    case "mcp.tool":
      return `инструмент ${action.name}`;
  }
}

function toSchedulerAction(input: ActionInput): SchedulerAction {
  switch (input.kind) {
    case "ha.call_service": {
      const source = input.request;
      const target: HaServiceTarget = {};
      if (source.entity_id !== undefined) target.entity_id = source.entity_id;
      if (source.area_id !== undefined) target.area_id = source.area_id;
      if (source.device_id !== undefined) target.device_id = source.device_id;
      const request: HaCallServiceRequest = {
        domain: source.domain,
        service: source.service,
      };
      if (Object.keys(target).length > 0) request.target = target;
      if (source.data !== undefined) request.data = source.data;
      return { kind: "ha.call_service", request };
    }
    case "announce":
      return { kind: "announce", text: input.text };
    case "mcp.tool":
      return { kind: "mcp.tool", name: input.name, args: input.args };
  }
}

async function ensureCapacity(ctx: ToolContext): Promise<ToolResult | null> {
  const config = ctx.config.tools.scheduler;
  if (!config.enabled) {
    return { ok: false, error: "планировщик выключен в настройках" };
  }
  if (!Number.isFinite(config.maxActive) || config.maxActive < 1) {
    return { ok: false, error: "лимит активных задач настроен неверно (tools.scheduler.maxActive)" };
  }
  const active = await ctx.scheduler.list();
  if (active.length >= config.maxActive) {
    return { ok: false, error: `слишком много активных задач (лимит ${config.maxActive})` };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────── tools ──

const addOnceTool: Tool = {
  name: "scheduler.add_once",
  description:
    "Запланировать разовое действие. Используй для «включи свет на N минут» (in_seconds) и «выключи свет в HH:MM» (at). " +
    "Для отложенного действия на сегодня/завтра at должен быть ISO 8601 с часовым поясом.",
  parameters: ADD_ONCE_PARAMETERS,
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = addOnceArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Неверные аргументы: ${formatIssues(parsed.error)}` };
    }
    const { in_seconds: inSeconds, at: atIso, label, action } = parsed.data;
    const nowMs = Date.now();
    let at: number;
    if (inSeconds !== undefined) {
      at = nowMs + Math.round(inSeconds * 1000);
    } else if (atIso !== undefined) {
      const parsedAt = Date.parse(atIso);
      if (Number.isNaN(parsedAt)) {
        return { ok: false, error: `Не понял время: ${atIso}` };
      }
      if (parsedAt <= nowMs) {
        return { ok: false, error: "Время уже прошло" };
      }
      at = parsedAt;
    } else {
      return { ok: false, error: "укажи ровно одно из in_seconds/at" };
    }

    let capacityProblem: ToolResult | null;
    try {
      capacityProblem = await ensureCapacity(ctx);
    } catch (error) {
      ctx.log.error("tool scheduler.add_once: capacity check failed", { error: errorMessage(error) });
      return { ok: false, error: errorMessage(error) };
    }
    if (capacityProblem !== null) return capacityProblem;

    const schedulerAction = toSchedulerAction(action);
    try {
      const created = await ctx.scheduler.addOnce({
        at,
        action: schedulerAction,
        label,
        runId: ctx.runId,
      });
      ctx.log.info("tool scheduler.add_once: scheduled", {
        id: created.id,
        at: new Date(created.at).toISOString(),
        label,
        action: describeAction(schedulerAction),
      });
      return {
        ok: true,
        data: { id: created.id, at: created.at, label },
        speech: speechForSchedule(created.at, nowMs),
      };
    } catch (error) {
      ctx.log.error("tool scheduler.add_once: failed", { error: errorMessage(error) });
      return { ok: false, error: errorMessage(error) };
    }
  },
};

const cancelTool: Tool = {
  name: "scheduler.cancel",
  description:
    "Отменить запланированное действие по id или все сразу (id=\"all\"). Используй, когда пользователь говорит «отмени».",
  parameters: CANCEL_PARAMETERS,
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = cancelArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Неверные аргументы: ${formatIssues(parsed.error)}` };
    }
    const { id } = parsed.data;
    try {
      const result = await ctx.scheduler.cancel(id);
      ctx.log.info("tool scheduler.cancel: done", { id, cancelled: result.cancelled });
      if (result.cancelled === 0) {
        return {
          ok: true,
          data: { cancelled: 0 },
          speech: id === "all" ? "Нет задач для отмены" : "Такой задачи нет",
        };
      }
      return {
        ok: true,
        data: { cancelled: result.cancelled },
        speech:
          id === "all"
            ? `Отменил ${result.cancelled} ${plural(result.cancelled, "задачу", "задачи", "задач")}`
            : "Отменил",
      };
    } catch (error) {
      ctx.log.error("tool scheduler.cancel: failed", { id, error: errorMessage(error) });
      return { ok: false, error: errorMessage(error) };
    }
  },
};

const listTool: Tool = {
  name: "scheduler.list",
  description: "Показать запланированные разовые действия.",
  parameters: LIST_PARAMETERS,
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parsed = listArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Неверные аргументы: ${formatIssues(parsed.error)}` };
    }
    try {
      const entries = await ctx.scheduler.list();
      const data = {
        count: entries.length,
        entries: entries.map((entry) => ({
          id: entry.id,
          at: entry.at,
          at_iso: new Date(entry.at).toISOString(),
          label: entry.label,
          action: entry.action.kind,
        })),
      };
      const first = entries[0];
      return {
        ok: true,
        data,
        speech:
          first === undefined
            ? "Нет запланированных задач"
            : `Запланировано задач: ${entries.length}. Ближайшая — ${first.label} в ${formatTimeOfDay(first.at)}`,
      };
    } catch (error) {
      ctx.log.error("tool scheduler.list: failed", { error: errorMessage(error) });
      return { ok: false, error: errorMessage(error) };
    }
  },
};

/** Canonical scheduler tools; registration order is not significant. */
export function createSchedulerTools(): Tool[] {
  return [addOnceTool, cancelTool, listTool];
}

// ────────────────────────────────────────────────────── recurring tool ──

export interface RecurringToolDeps {
  ha: HaClientLike;
  log: LoggerLike;
  recurring: RecurringRunner;
  /** Absent when the HA REST automation API is not wired; the internal fallback is used. */
  writer?: HaAutomationConfigWriter;
  now?: () => number;
}

function defaultRecurringLabel(spec: RecurringSpec, action: SchedulerAction): string {
  return `${describeRecurring(spec)}: ${describeAction(action)}`;
}

/**
 * scheduler.add_recurring: parse the schedule phrase, create a native HA automation, and only
 * fall back to the internal recurring runner when the native path is unavailable.
 * The result stays ok=false on fallback (the user request was not satisfied natively) and
 * data.method tells the caller which path is actually active.
 */
export function createRecurringTool(deps: RecurringToolDeps): Tool {
  const now = deps.now ?? Date.now;

  return {
    name: "scheduler.add_recurring",
    description:
      "Создать повторяющееся действие: «каждый день в 8:30 включи свет», «по будням в 7», «каждую субботу в 10». " +
      "phrase содержит только расписание, action — что делать.",
    parameters: ADD_RECURRING_PARAMETERS,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const parsed = addRecurringArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: `Неверные аргументы: ${formatIssues(parsed.error)}` };
      }
      if (!ctx.config.tools.scheduler.enabled) {
        return { ok: false, error: "планировщик выключен в настройках" };
      }

      const data = parsed.data;
      let spec: ParsedRecurring | null;
      try {
        spec = parseRecurringRu(data.phrase, new Date(now()));
      } catch (error) {
        deps.log.error("tool scheduler.add_recurring: parser failed", {
          error: errorMessage(error),
          phrase: data.phrase,
        });
        return { ok: false, error: errorMessage(error) };
      }
      if (spec === null) {
        return { ok: false, error: `не понял расписание: «${data.phrase}»` };
      }

      const schedulerAction = toSchedulerAction(data.action);
      const label = data.label ?? defaultRecurringLabel(spec, schedulerAction);

      const native = await createHaAutomation(deps.ha, spec, schedulerAction, label, {
        log: deps.log,
        ...(deps.writer !== undefined ? { writer: deps.writer } : {}),
      });
      if (native.ok) {
        deps.log.info("tool scheduler.add_recurring: native automation created", {
          automationId: native.automationId,
          spec,
        });
        return {
          ok: true,
          data: {
            method: "ha_automation",
            automation_id: native.automationId,
            spec,
          },
          speech: `Создал автоматизацию: ${describeRecurring(spec)}`,
        };
      }

      deps.log.warn("tool scheduler.add_recurring: native path failed, using internal fallback", {
        error: native.error,
        spec,
      });
      try {
        const rule = await deps.recurring.add({ label, spec, action: schedulerAction });
        return {
          ok: false,
          error: `Автоматизация в HA не создана: ${native.error}. Включён внутренний планировщик.`,
          data: {
            method: "internal_fallback",
            id: rule.id,
            spec: rule.spec,
            next_at: rule.nextAt,
            native_error: native.error,
          },
        };
      } catch (error) {
        deps.log.error("tool scheduler.add_recurring: internal fallback failed", {
          error: errorMessage(error),
          spec,
        });
        return {
          ok: false,
          error: `не удалось запланировать повторяющееся действие: ${errorMessage(error)}`,
        };
      }
    },
  };
}

/** Convenience: canonical tools plus the optional recurring tool. */
export function createAllSchedulerTools(deps: RecurringToolDeps): Tool[] {
  return [...createSchedulerTools(), createRecurringTool(deps)];
}
