import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecurringRunner } from "../src/schedule/recurring-runner.js";
import { createSchedulerRunner } from "../src/scheduler/runner.js";
import { createSchedulerStore, type SchedulerStore } from "../src/scheduler/store.js";
import type { Tool } from "../src/shared/types.js";
import {
  createAllSchedulerTools,
  createRecurringTool,
  createSchedulerTools,
} from "../src/tools/scheduler.js";
import {
  createTempDir,
  createTestConfig,
  createTestContext,
  createTestHa,
  createTestLogger,
  createTestSchedulerApi,
  makeEntry,
  type TempDir,
  type TestLogger,
} from "./scheduler-support.js";

const LIGHT_ON = {
  kind: "ha.call_service" as const,
  request: {
    domain: "light",
    service: "turn_on",
    entity_id: "light.kitchen",
    data: { brightness_pct: 30 },
  },
};

function toolByName(tools: Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`tool ${name} is not registered`);
  return tool;
}

let temp: TempDir;
let stores: SchedulerStore[];
let log: TestLogger;

function openStore(): SchedulerStore {
  const store = createSchedulerStore(join(temp.path, "scheduler.db"), log);
  stores.push(store);
  return store;
}

function setupRecurring() {
  const store = openStore();
  const runner = createSchedulerRunner({
    store,
    log,
    execute: async () => undefined,
  });
  const recurring = createRecurringRunner({ store, runner, log });
  return { store, runner, recurring };
}

beforeEach(() => {
  temp = createTempDir("pulsar-scheduler-tools-");
  stores = [];
  log = createTestLogger();
});

afterEach(() => {
  for (const store of stores) store.close();
  temp.cleanup();
});

describe("canonical scheduler tools", () => {
  it("registers add_once, cancel and list", () => {
    expect(createSchedulerTools().map((tool) => tool.name)).toEqual([
      "scheduler.add_once",
      "scheduler.cancel",
      "scheduler.list",
    ]);
  });

  it("schedules in_seconds and converts the flat request into a nested target", async () => {
    const scheduler = createTestSchedulerApi();
    const ctx = createTestContext({ scheduler, runId: "run-42" });
    const tool = toolByName(createSchedulerTools(), "scheduler.add_once");

    const result = await tool.execute(
      { in_seconds: 600, label: "выключить свет", action: LIGHT_ON },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(scheduler.addOnce).toHaveBeenCalledTimes(1);
    const input = scheduler.addOnce.mock.calls[0]?.[0];
    expect(input).toBeDefined();
    if (input === undefined) throw new Error("addOnce was not called");
    expect(input.label).toBe("выключить свет");
    expect(input.runId).toBe("run-42");
    expect(input.at).toBeGreaterThan(Date.now() + 599_000);
    expect(input.at).toBeLessThanOrEqual(Date.now() + 601_000);
    expect(input.action).toEqual({
      kind: "ha.call_service",
      request: {
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.kitchen" },
        data: { brightness_pct: 30 },
      },
    });
    expect(result.data).toEqual({ id: "sched_test", at: input.at, label: "выключить свет" });
    expect(result.speech).toMatch(/Выполню/u);
  });

  it("schedules an absolute ISO timestamp", async () => {
    const scheduler = createTestSchedulerApi();
    const ctx = createTestContext({ scheduler });
    const tool = toolByName(createSchedulerTools(), "scheduler.add_once");
    const at = new Date(Date.now() + 3_600_000);

    const result = await tool.execute(
      {
        at: at.toISOString(),
        label: "выключить телевизор",
        action: { kind: "announce", text: "пора спать" },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const input = scheduler.addOnce.mock.calls[0]?.[0];
    expect(input?.at).toBe(at.getTime());
    expect(input?.action).toEqual({ kind: "announce", text: "пора спать" });
  });

  it("rejects invalid arguments with a clear message", async () => {
    const scheduler = createTestSchedulerApi();
    const ctx = createTestContext({ scheduler });
    const tool = toolByName(createSchedulerTools(), "scheduler.add_once");
    const past = new Date(Date.now() - 60_000).toISOString();

    const cases: Array<{ args: Record<string, unknown>; error: RegExp }> = [
      { args: {}, error: /label/u },
      { args: { label: "x", action: LIGHT_ON }, error: /ровно одно/u },
      { args: { label: "x", in_seconds: 5, at: past, action: LIGHT_ON }, error: /ровно одно/u },
      { args: { label: "x", in_seconds: -5, action: LIGHT_ON }, error: /in_seconds/u },
      { args: { label: "x", at: "not-a-date", action: LIGHT_ON }, error: /Не понял время/u },
      { args: { label: "x", at: past, action: LIGHT_ON }, error: /Время уже прошло/u },
      { args: { label: "x", action: { kind: "bogus" } }, error: /action/u },
      { args: { label: "x", at: "2026-12-01T10:00:00Z" }, error: /action/u },
    ];
    for (const { args, error } of cases) {
      const result = await tool.execute(args, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(error);
    }
    expect(scheduler.addOnce).not.toHaveBeenCalled();
  });

  it("enforces the configured maxActive limit", async () => {
    const scheduler = createTestSchedulerApi();
    scheduler.list.mockResolvedValue([makeEntry("existing", Date.now() + 60_000)]);
    const ctx = createTestContext({
      scheduler,
      config: createTestConfig({ maxActive: 1 }),
    });
    const tool = toolByName(createSchedulerTools(), "scheduler.add_once");

    const result = await tool.execute(
      { in_seconds: 60, label: "ещё одно", action: LIGHT_ON },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/слишком много активных задач \(лимит 1\)/u);
    expect(scheduler.addOnce).not.toHaveBeenCalled();
  });

  it("refuses to schedule when the scheduler is disabled", async () => {
    const ctx = createTestContext({
      config: createTestConfig({ schedulerEnabled: false }),
    });
    const tool = toolByName(createSchedulerTools(), "scheduler.add_once");
    const result = await tool.execute(
      { in_seconds: 60, label: "x", action: LIGHT_ON },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/выключен/u);
  });

  it("propagates scheduler errors", async () => {
    const scheduler = createTestSchedulerApi();
    scheduler.addOnce.mockRejectedValue(new Error("storage is locked"));
    const ctx = createTestContext({ scheduler, log });
    const tool = toolByName(createSchedulerTools(), "scheduler.add_once");

    const result = await tool.execute(
      { in_seconds: 60, label: "x", action: LIGHT_ON },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("storage is locked");
    expect(log.levelEntries("error")).toHaveLength(1);
  });

  it("cancels by id and all, and reports the idempotent result", async () => {
    const scheduler = createTestSchedulerApi();
    const ctx = createTestContext({ scheduler });
    const tool = toolByName(createSchedulerTools(), "scheduler.cancel");

    scheduler.cancel.mockResolvedValue({ cancelled: 3 });
    const all = await tool.execute({ id: "all" }, ctx);
    expect(all.ok).toBe(true);
    expect(all.data).toEqual({ cancelled: 3 });
    expect(all.speech).toContain("3");
    expect(scheduler.cancel).toHaveBeenLastCalledWith("all");

    scheduler.cancel.mockResolvedValue({ cancelled: 0 });
    const none = await tool.execute({ id: "all" }, ctx);
    expect(none.ok).toBe(true);
    expect(none.speech).toBe("Нет задач для отмены");
    const missing = await tool.execute({ id: "sched_missing" }, ctx);
    expect(missing.speech).toBe("Такой задачи нет");

    const invalid = await tool.execute({}, ctx);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/id/u);
  });

  it("lists scheduled entries with a spoken summary", async () => {
    const scheduler = createTestSchedulerApi();
    const now = Date.now();
    scheduler.list.mockResolvedValue([
      makeEntry("a", now + 60_000, { kind: "announce", text: "a" }, "полить цветы"),
      makeEntry("b", now + 120_000),
    ]);
    const ctx = createTestContext({ scheduler });
    const tool = toolByName(createSchedulerTools(), "scheduler.list");

    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(true);
    const data = result.data as { count: number; entries: Array<{ id: string; action: string }> };
    expect(data.count).toBe(2);
    expect(data.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(data.entries[0]?.action).toBe("announce");
    expect(result.speech).toContain("полить цветы");

    scheduler.list.mockResolvedValue([]);
    const empty = await tool.execute({}, ctx);
    expect(empty.speech).toBe("Нет запланированных задач");
  });
});

describe("scheduler.add_recurring tool", () => {
  const nativeAction = {
    kind: "ha.call_service" as const,
    request: { domain: "light", service: "turn_on", entity_id: "light.kitchen" },
  };

  it("creates a native HA automation when the writer is available", async () => {
    const { recurring } = setupRecurring();
    const ha = createTestHa();
    const writeAutomationConfig = vi.fn(
      async (_configKey: string, _config: Record<string, unknown>): Promise<void> => undefined,
    );
    const tool = createRecurringTool({
      ha,
      log,
      recurring,
      writer: { writeAutomationConfig },
    });
    const ctx = createTestContext();

    const result = await tool.execute(
      { phrase: "каждый день в 8:30", action: nativeAction, label: "Утренний свет" },
      ctx,
    );
    expect(result.ok).toBe(true);
    const data = result.data as { method: string; automation_id: string };
    expect(data.method).toBe("ha_automation");
    expect(data.automation_id).toMatch(/^pulsar_brain_/u);
    const config = writeAutomationConfig.mock.calls[0]?.[1];
    expect(config).toMatchObject({
      alias: "Утренний свет",
      triggers: [{ trigger: "time", at: "08:30:00" }],
    });
    expect(ha.callService).toHaveBeenCalledWith({ domain: "automation", service: "reload" });
    expect(result.speech).toContain("каждый день в 08:30");
  });

  it("falls back to the internal runner and reports the fallback path", async () => {
    const { store, recurring } = setupRecurring();
    const tool = createRecurringTool({ ha: createTestHa(), log, recurring });
    const ctx = createTestContext();

    const result = await tool.execute(
      { phrase: "каждый день в 8:30", action: nativeAction, label: "Утренний свет" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Автоматизация в HA не создана/u);
    const data = result.data as { method: string; id: string; native_error: string };
    expect(data.method).toBe("internal_fallback");
    expect(data.id).toMatch(/^rec_/u);
    expect(data.native_error).toContain("writer");
    expect(store.listRecurring()).toHaveLength(1);
    expect(store.listActive()).toHaveLength(1);
  });

  it("falls back when the writer rejects", async () => {
    const { store, recurring } = setupRecurring();
    const tool = createRecurringTool({
      ha: createTestHa(),
      log,
      recurring,
      writer: {
        writeAutomationConfig: async () => {
          throw new Error("HA automation config API responded 401");
        },
      },
    });
    const ctx = createTestContext();

    const result = await tool.execute(
      { phrase: "по будням в 7", action: nativeAction },
      ctx,
    );
    expect(result.ok).toBe(false);
    const data = result.data as { method: string; native_error: string };
    expect(data.method).toBe("internal_fallback");
    expect(data.native_error).toContain("401");
    expect(store.listRecurring()).toHaveLength(1);
  });

  it("rejects unsupported actions and unparsable phrases", async () => {
    const { recurring } = setupRecurring();
    const tool = createRecurringTool({ ha: createTestHa(), log, recurring });
    const ctx = createTestContext();

    const announce = await tool.execute(
      { phrase: "каждый день в 8:30", action: { kind: "announce", text: "доброе утро" } },
      ctx,
    );
    expect(announce.ok).toBe(false);
    const announceData = announce.data as { method?: string };
    expect(announceData.method).toBe("internal_fallback");

    const unparsed = await tool.execute(
      { phrase: "включи свет", action: nativeAction },
      ctx,
    );
    expect(unparsed.ok).toBe(false);
    expect(unparsed.error).toMatch(/не понял расписание/u);

    const invalid = await tool.execute({ action: nativeAction }, ctx);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/phrase/u);
  });

  it("refuses to schedule when the scheduler is disabled", async () => {
    const { recurring } = setupRecurring();
    const tool = createRecurringTool({ ha: createTestHa(), log, recurring });
    const ctx = createTestContext({ config: createTestConfig({ schedulerEnabled: false }) });

    const result = await tool.execute(
      { phrase: "каждый день в 8:30", action: nativeAction },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/выключен/u);
  });

  it("is exposed together with the canonical tools", () => {
    const { recurring } = setupRecurring();
    const tools = createAllSchedulerTools({ ha: createTestHa(), log, recurring });
    expect(tools.map((tool) => tool.name)).toEqual([
      "scheduler.add_once",
      "scheduler.cancel",
      "scheduler.list",
      "scheduler.add_recurring",
    ]);
  });
});
