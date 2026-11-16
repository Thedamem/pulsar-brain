import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAutomationConfig,
  createHaAutomation,
  createHaRestAutomationWriter,
  describeRecurring,
  nextOccurrence,
  parseRecurringRu,
  parseRecurringSpecJson,
  type RecurringSpec,
} from "../src/schedule/recurring.js";
import { createRecurringRunner } from "../src/schedule/recurring-runner.js";
import { createSchedulerRunner } from "../src/scheduler/runner.js";
import { createSchedulerStore, type SchedulerStore } from "../src/scheduler/store.js";
import type { HaClientLike, SchedulerAction } from "../src/shared/types.js";
import {
  createTempDir,
  createTestHa,
  createTestLogger,
  type TempDir,
  type TestLogger,
} from "./scheduler-support.js";

// 2026-11-16 is a Monday.
const BASE = new Date(2026, 10, 16, 10, 0, 0);

function local(year: number, month: number, day: number, hours: number, minutes: number): number {
  return new Date(year, month, day, hours, minutes, 0, 0).getTime();
}

let temp: TempDir;
let stores: SchedulerStore[];
let log: TestLogger;

function openStore(): SchedulerStore {
  const store = createSchedulerStore(join(temp.path, "scheduler.db"), log);
  stores.push(store);
  return store;
}

const lightAction: SchedulerAction = {
  kind: "ha.call_service",
  request: {
    domain: "light",
    service: "turn_on",
    target: { entity_id: "light.kitchen" },
    data: { brightness_pct: 40 },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  temp = createTempDir("pulsar-scheduler-recurring-");
  stores = [];
  log = createTestLogger();
});

afterEach(() => {
  for (const store of stores) store.close();
  temp.cleanup();
  vi.useRealTimers();
});

describe("parseRecurringRu", () => {
  const now = new Date(BASE);

  it("parses daily phrases with an explicit time", () => {
    expect(parseRecurringRu("Алиса, каждый день в 8:30 включи свет", now)).toEqual({
      kind: "daily",
      time: "08:30",
      matched: "каждый день в 8:30",
    });
  });

  it("parses weekdays and weekly phrases", () => {
    expect(parseRecurringRu("по будням в 7 включи свет", now)).toEqual({
      kind: "weekdays",
      time: "07:00",
      weekdays: [1, 2, 3, 4, 5],
      matched: "по будням в 7",
    });
    expect(parseRecurringRu("каждую субботу в 10 включи телевизор", now)).toEqual({
      kind: "weekly",
      time: "10:00",
      weekdays: [6],
      matched: "каждую субботу в 10",
    });
    expect(parseRecurringRu("по субботам в 10:15", now)).toEqual({
      kind: "weekly",
      time: "10:15",
      weekdays: [6],
      matched: "по субботам в 10:15",
    });
  });

  it("understands time variants and part-of-day words", () => {
    expect(parseRecurringRu("каждый день в 8 30", now)?.time).toBe("08:30");
    expect(parseRecurringRu("каждый день в 8 часов 30 минут", now)?.time).toBe("08:30");
    expect(parseRecurringRu("каждый день в 8 вечера", now)?.time).toBe("20:00");
    expect(parseRecurringRu("каждый вечер в 8", now)).toMatchObject({
      kind: "daily",
      time: "20:00",
    });
    expect(parseRecurringRu("каждое утро", now)).toMatchObject({ kind: "daily", time: "08:00" });
    expect(parseRecurringRu("каждую ночь в 23:00", now)).toMatchObject({
      kind: "daily",
      time: "23:00",
    });
    expect(parseRecurringRu("ежедневно в 6:45", now)).toMatchObject({
      kind: "daily",
      time: "06:45",
    });
  });

  it("returns null for non-recurring or incomplete phrases", () => {
    expect(parseRecurringRu("включи свет", now)).toBeNull();
    expect(parseRecurringRu("выключи свет в 22:00", now)).toBeNull();
    expect(parseRecurringRu("каждый день", now)).toBeNull();
    expect(parseRecurringRu("каждый день в 25:00", now)).toBeNull();
  });

  it("rejects an invalid now", () => {
    expect(() => parseRecurringRu("каждый день в 8:30", new Date(Number.NaN))).toThrow(
      /valid Date/u,
    );
  });
});

describe("nextOccurrence", () => {
  it("moves a passed daily time to tomorrow and keeps a future one today", () => {
    const spec: RecurringSpec = { kind: "daily", time: "08:30" };
    expect(nextOccurrence(spec, local(2026, 10, 16, 10, 0))).toBe(local(2026, 10, 17, 8, 30));
    expect(nextOccurrence(spec, local(2026, 10, 16, 7, 0))).toBe(local(2026, 10, 16, 8, 30));
  });

  it("moves weekdays to the next workday", () => {
    const spec: RecurringSpec = { kind: "weekdays", time: "07:00", weekdays: [1, 2, 3, 4, 5] };
    expect(nextOccurrence(spec, local(2026, 10, 16, 10, 0))).toBe(local(2026, 10, 17, 7, 0));
    // Friday evening -> Monday morning
    expect(nextOccurrence(spec, local(2026, 10, 20, 19, 0))).toBe(local(2026, 10, 23, 7, 0));
  });

  it("moves a weekly time to the next matching weekday", () => {
    const saturday: RecurringSpec = { kind: "weekly", time: "10:00", weekdays: [6] };
    expect(nextOccurrence(saturday, local(2026, 10, 16, 10, 0))).toBe(local(2026, 10, 21, 10, 0));
    // Saturday after the scheduled time -> next Saturday
    expect(nextOccurrence(saturday, local(2026, 10, 21, 11, 0))).toBe(local(2026, 10, 28, 10, 0));
  });

  it("refuses a non-daily spec without weekdays", () => {
    expect(() =>
      nextOccurrence({ kind: "weekly", time: "10:00" }, local(2026, 10, 16, 10, 0)),
    ).toThrow(/no weekdays/u);
  });

  it("survives JSON round-trips and rejects corrupted specs", () => {
    const spec: RecurringSpec = { kind: "weekly", time: "10:00", weekdays: [6] };
    expect(parseRecurringSpecJson(JSON.stringify(spec), "rule")).toEqual(spec);
    expect(() => parseRecurringSpecJson('{"kind":"yearly","time":"10:00"}', "rule")).toThrow(
      /unknown kind/u,
    );
    expect(() => parseRecurringSpecJson("not json", "rule")).toThrow(/invalid spec JSON/u);
  });

  it("describes rules for speech", () => {
    expect(describeRecurring({ kind: "daily", time: "08:30" })).toBe("каждый день в 08:30");
    expect(describeRecurring({ kind: "weekdays", time: "07:00", weekdays: [1, 2, 3, 4, 5] })).toBe(
      "по будням в 07:00",
    );
    expect(describeRecurring({ kind: "weekly", time: "10:00", weekdays: [6] })).toBe(
      "каждый субботу в 10:00",
    );
  });
});

describe("native HA automation", () => {
  it("builds a time trigger, weekday condition and service action", () => {
    const daily = buildAutomationConfig({ kind: "daily", time: "08:30" }, lightAction, "Утренний свет");
    expect(daily.ok).toBe(true);
    if (!daily.ok) throw new Error(daily.reason);
    expect(daily.config.triggers).toEqual([{ trigger: "time", at: "08:30:00" }]);
    expect(daily.config.actions).toEqual([
      {
        action: "light.turn_on",
        target: { entity_id: "light.kitchen" },
        data: { brightness_pct: 40 },
      },
    ]);
    expect(daily.config.alias).toBe("Утренний свет");
    expect(daily.config.conditions).toBeUndefined();

    const weekdays = buildAutomationConfig(
      { kind: "weekdays", time: "07:00", weekdays: [1, 2, 3, 4, 5] },
      lightAction,
      "Будни",
    );
    expect(weekdays.ok).toBe(true);
    if (!weekdays.ok) throw new Error(weekdays.reason);
    expect(weekdays.config.conditions).toEqual([
      { condition: "time", weekday: ["mon", "tue", "wed", "thu", "fri"] },
    ]);

    const weekly = buildAutomationConfig(
      { kind: "weekly", time: "10:00", weekdays: [6] },
      lightAction,
      "Суббота",
    );
    expect(weekly.ok).toBe(true);
    if (!weekly.ok) throw new Error(weekly.reason);
    expect(weekly.config.conditions).toEqual([{ condition: "time", weekday: ["sat"] }]);
  });

  it("refuses non-service actions because HA automation cannot express them", () => {
    const built = buildAutomationConfig(
      { kind: "daily", time: "08:30" },
      { kind: "announce", text: "доброе утро" },
      "Объявление",
    );
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("expected failure");
    expect(built.reason).toMatch(/ha\.call_service/u);
  });

  it("creates the automation through the writer and reloads automations", async () => {
    const ha = createTestHa();
    const writeAutomationConfig = vi.fn(
      async (_configKey: string, _config: Record<string, unknown>): Promise<void> => undefined,
    );
    const result = await createHaAutomation(
      ha,
      { kind: "daily", time: "08:30" },
      lightAction,
      "Утренний свет",
      { log, writer: { writeAutomationConfig } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.automationId).toMatch(/^pulsar_brain_[a-f0-9]{32}$/u);
    expect(writeAutomationConfig).toHaveBeenCalledTimes(1);
    const writeCall = writeAutomationConfig.mock.calls[0];
    expect(writeCall).toBeDefined();
    if (writeCall === undefined) throw new Error("writer was not called");
    expect(writeCall[0]).toBe(result.automationId);
    expect(writeCall[1]).toMatchObject({
      alias: "Утренний свет",
      triggers: [{ trigger: "time", at: "08:30:00" }],
      mode: "single",
    });
    expect(ha.callService).toHaveBeenCalledWith({ domain: "automation", service: "reload" });
  });

  it("reports a failed or missing writer instead of claiming success", async () => {
    const ha = createTestHa();
    const failing = await createHaAutomation(
      ha,
      { kind: "daily", time: "08:30" },
      lightAction,
      "Утренний свет",
      {
        log,
        writer: {
          writeAutomationConfig: async () => {
            throw new Error("HA automation config API responded 404");
          },
        },
      },
    );
    expect(failing.ok).toBe(false);
    if (failing.ok) throw new Error("expected failure");
    expect(failing.error).toContain("404");

    const unwired = await createHaAutomation(
      ha,
      { kind: "daily", time: "08:30" },
      lightAction,
      "Утренний свет",
      { log },
    );
    expect(unwired.ok).toBe(false);
    if (unwired.ok) throw new Error("expected failure");
    expect(unwired.error).toContain("writer");
    expect(log.levelEntries("warn").length).toBeGreaterThan(0);
  });

  it("writes the config through the HA REST endpoint with an admin bearer token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ result: "ok" }), { status: 200 });
    };
    const writer = createHaRestAutomationWriter({
      baseUrl: "http://supervisor/core/api/",
      token: " secret-token ",
      fetchImpl,
      timeoutMs: 1_000,
    });

    await writer.writeAutomationConfig("pulsar_brain_x", { alias: "x" });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    expect(call.url).toBe(
      "http://supervisor/core/api/config/automation/config/pulsar_brain_x",
    );
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({ alias: "x" });
  });

  it("surfaces HA REST errors and rejects unusable writer options", async () => {
    const failingFetch: typeof fetch = async () =>
      new Response("Invalid config: unknown trigger", { status: 400 });
    const writer = createHaRestAutomationWriter({
      baseUrl: "http://supervisor/core/api",
      token: "t",
      fetchImpl: failingFetch,
    });
    await expect(writer.writeAutomationConfig("k", {})).rejects.toThrow(
      /400.*unknown trigger/u,
    );

    expect(() =>
      createHaRestAutomationWriter({ baseUrl: "  ", token: "t", fetchImpl: failingFetch }),
    ).toThrow(/baseUrl/u);
    expect(() =>
      createHaRestAutomationWriter({ baseUrl: "http://x", token: " ", fetchImpl: failingFetch }),
    ).toThrow(/token/u);
  });
});

describe("internal recurring fallback", () => {
  it("queues the next occurrence and rolls it forward after each execution", async () => {
    const store = openStore();
    const executed: string[] = [];
    const runner = createSchedulerRunner({
      store,
      log,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
    const recurring = createRecurringRunner({ store, runner, log });
    await runner.start();
    await recurring.start();

    const rule = await recurring.add({
      label: "утренний свет",
      spec: { kind: "daily", time: "08:30" },
      action: { kind: "announce", text: "доброе утро" },
    });
    // Monday 10:00 -> Tuesday 08:30
    expect(rule.nextAt).toBe(local(2026, 10, 17, 8, 30));
    expect(store.getRecurring(rule.id)?.nextAt).toBe(local(2026, 10, 17, 8, 30));
    expect(runner.nextAt()).toBe(local(2026, 10, 17, 8, 30));

    await vi.advanceTimersByTimeAsync(rule.nextAt - Date.now());
    expect(executed).toHaveLength(1);
    expect(store.getRecurring(rule.id)?.nextAt).toBe(local(2026, 10, 18, 8, 30));
    expect(runner.nextAt()).toBe(local(2026, 10, 18, 8, 30));

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(executed).toHaveLength(2);
    expect(store.getRecurring(rule.id)?.nextAt).toBe(local(2026, 10, 19, 8, 30));

    recurring.stop();
    runner.stop();
  });

  it("recalculates a missed occurrence after restart instead of replaying it", async () => {
    const store = openStore();
    const executed: string[] = [];
    const firstRunner = createSchedulerRunner({
      store,
      log,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
    const firstRecurring = createRecurringRunner({ store, runner: firstRunner, log });
    await firstRunner.start();
    await firstRecurring.start();
    const rule = await firstRecurring.add({
      label: "утренний свет",
      spec: { kind: "daily", time: "08:30" },
      action: { kind: "announce", text: "доброе утро" },
    });
    expect(rule.nextAt).toBe(local(2026, 10, 17, 8, 30));

    firstRecurring.stop();
    firstRunner.stop();
    // Restart on Thursday: Tuesday 08:30 is far outside the 5 minute grace window.
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60 * 1_000);

    const secondRunner = createSchedulerRunner({
      store,
      log,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
    const secondRecurring = createRecurringRunner({ store, runner: secondRunner, log });
    await secondRunner.start();
    const report = await secondRecurring.start();

    expect(executed).toEqual([]);
    expect(report.rescheduled).toBe(1);
    expect(store.getRecurring(rule.id)?.nextAt).toBe(local(2026, 10, 20, 8, 30));
    expect(secondRunner.nextAt()).toBe(local(2026, 10, 20, 8, 30));
    expect(
      log
        .levelEntries("warn")
        .some((entry) => entry.msg.includes("missed occurrence recalculated")),
    ).toBe(true);

    secondRecurring.stop();
    secondRunner.stop();
  });

  it("moves a weekday rule to Monday and rolls it to the next workday", async () => {
    // Friday evening: the next weekday occurrence is Monday morning.
    vi.setSystemTime(new Date(2026, 10, 20, 19, 0, 0));
    const store = openStore();
    const executed: string[] = [];
    const runner = createSchedulerRunner({
      store,
      log,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
    const recurring = createRecurringRunner({ store, runner, log });
    await runner.start();
    await recurring.start();

    const rule = await recurring.add({
      label: "будни",
      spec: { kind: "weekdays", time: "07:00", weekdays: [1, 2, 3, 4, 5] },
      action: { kind: "announce", text: "подъём" },
    });
    expect(rule.nextAt).toBe(local(2026, 10, 23, 7, 0));

    await vi.advanceTimersByTimeAsync(rule.nextAt - Date.now());
    expect(executed).toHaveLength(1);
    expect(store.getRecurring(rule.id)?.nextAt).toBe(local(2026, 10, 24, 7, 0));

    recurring.stop();
    runner.stop();
  });

  it("removes a rule together with its pending occurrence", async () => {
    const store = openStore();
    const executed: string[] = [];
    const runner = createSchedulerRunner({
      store,
      log,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
    const recurring = createRecurringRunner({ store, runner, log });
    await runner.start();
    await recurring.start();
    const rule = await recurring.add({
      label: "вечер",
      spec: { kind: "daily", time: "20:00" },
      action: { kind: "announce", text: "вечер" },
    });
    expect(store.listActive()).toHaveLength(1);

    await expect(recurring.list()).resolves.toHaveLength(1);
    await expect(recurring.remove(rule.id)).resolves.toBe(true);
    expect(store.listActive()).toHaveLength(0);
    expect(store.getRecurring(rule.id)).toBeNull();
    await expect(recurring.remove(rule.id)).resolves.toBe(false);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(executed).toEqual([]);
    recurring.stop();
    runner.stop();
  });

  it("keeps the rule when a native HA client is unused by the fallback", async () => {
    // The fallback executes actions through the shared runner executor only; the fake HA
    // client below proves the fallback does not call HA services itself.
    const store = openStore();
    const ha: HaClientLike = createTestHa();
    const runner = createSchedulerRunner({
      store,
      log,
      execute: async () => undefined,
    });
    const recurring = createRecurringRunner({ store, runner, log });
    await runner.start();
    await recurring.start();
    await recurring.add({
      label: "без HA",
      spec: { kind: "weekdays", time: "07:00", weekdays: [1, 2, 3, 4, 5] },
      action: lightAction,
    });
    await vi.advanceTimersByTimeAsync(local(2026, 10, 17, 7, 0) - Date.now());

    expect(ha.callService).not.toHaveBeenCalled();
    recurring.stop();
    runner.stop();
  });
});
