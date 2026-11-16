import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createActionExecutor, createSchedulerRunner } from "../src/scheduler/runner.js";
import { createSchedulerService } from "../src/scheduler/service.js";
import { createSchedulerStore, type SchedulerStore } from "../src/scheduler/store.js";
import type { SchedulerAction, SchedulerEntry } from "../src/shared/types.js";
import {
  createTempDir,
  createTestHa,
  createTestLogger,
  createTestMcp,
  makeEntry,
  type TempDir,
  type TestLogger,
} from "./scheduler-support.js";

// 2026-11-16 is a Monday.
const BASE = new Date(2026, 10, 16, 10, 0, 0);

let temp: TempDir;
let stores: SchedulerStore[];
let log: TestLogger;

function openStore(): SchedulerStore {
  const store = createSchedulerStore(join(temp.path, "scheduler.db"), log);
  stores.push(store);
  return store;
}

function announcement(text: string): SchedulerAction {
  return { kind: "announce", text };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  temp = createTempDir("pulsar-scheduler-runner-");
  stores = [];
  log = createTestLogger();
});

afterEach(() => {
  for (const store of stores) store.close();
  temp.cleanup();
  vi.useRealTimers();
});

describe("scheduler runner", () => {
  it("executes an entry at its scheduled time and consumes it", async () => {
    const store = openStore();
    const executed: string[] = [];
    const runner = createSchedulerRunner({
      store,
      log,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
    const at = Date.now() + 5_000;
    store.insert(makeEntry("a", at));

    await runner.start();
    expect(executed).toEqual([]);
    expect(runner.nextAt()).toBe(at);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(executed).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(executed).toEqual(["a"]);
    expect(store.get("a")?.status).toBe("executed");
    expect(store.get("a")?.executedAt).toBe(at);
    expect(runner.nextAt()).toBeNull();
    runner.stop();
  });

  it("re-arms the timer for the following entry", async () => {
    const store = openStore();
    const executed: string[] = [];
    const runner = createSchedulerRunner({
      store,
      log,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
    const firstAt = Date.now() + 2_000;
    const secondAt = firstAt + 3_000;
    store.insert(makeEntry("a", firstAt));
    store.insert(makeEntry("b", secondAt));

    await runner.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(executed).toEqual(["a"]);
    expect(runner.nextAt()).toBe(secondAt);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(executed).toEqual(["a", "b"]);
    runner.stop();
  });

  it("runs overdue entries inside the grace window and skips missed ones", async () => {
    const store = openStore();
    const now = Date.now();
    const executed: string[] = [];
    const runner = createSchedulerRunner({
      store,
      log,
      graceMs: 5 * 60_000,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
    store.insert(makeEntry("due", now - 60_000));
    store.insert(makeEntry("late", now - 10 * 60_000));
    store.insert(makeEntry("future", now + 60_000));

    const report = await runner.start();
    expect(report).toEqual({ due: 1, missed: 1 });
    expect(executed).toEqual(["due"]);
    expect(store.get("due")?.status).toBe("executed");
    expect(store.get("late")?.status).toBe("missed");
    expect(store.get("future")?.status).toBe("pending");
    expect(log.levelEntries("warn").some((entry) => entry.msg.includes("missed entry"))).toBe(true);
    runner.stop();
  });

  it("consumes an entry even when the executor throws", async () => {
    const store = openStore();
    const runner = createSchedulerRunner({
      store,
      log,
      execute: async () => {
        throw new Error("executor boom");
      },
    });
    store.insert(makeEntry("a", Date.now() + 1_000));

    await runner.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(store.get("a")?.status).toBe("executed");
    expect(
      log.levelEntries("error").some((entry) => entry.msg.includes("scheduler: action failed")),
    ).toBe(true);
    runner.stop();
  });

  it("stops firing after stop()", async () => {
    const store = openStore();
    const executed: string[] = [];
    const runner = createSchedulerRunner({
      store,
      log,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
    store.insert(makeEntry("a", Date.now() + 1_000));
    await runner.start();
    runner.stop();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(executed).toEqual([]);
    expect(runner.running()).toBe(false);
  });

  it("runs an entry immediately via runNow and notifies listeners", async () => {
    const store = openStore();
    const executed: string[] = [];
    const notified: string[] = [];
    const runner = createSchedulerRunner({
      store,
      log,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
    runner.onExecuted((entry) => {
      notified.push(entry.id);
    });
    store.insert(makeEntry("a", Date.now() + 60_000));
    await runner.start();

    await expect(runner.runNow("a")).resolves.toBe(true);
    expect(executed).toEqual(["a"]);
    expect(notified).toEqual(["a"]);
    expect(store.get("a")?.status).toBe("executed");
    await expect(runner.runNow("a")).resolves.toBe(false);
    runner.stop();
  });
});

describe("scheduler service", () => {
  function createService(store: SchedulerStore, executed: string[], maxActive = 4) {
    return createSchedulerService({
      store,
      log,
      maxActive,
      execute: async (entry) => {
        executed.push(entry.id);
      },
    });
  }

  it("schedules a one-shot entry and cancels it idempotently", async () => {
    const store = openStore();
    const executed: string[] = [];
    const service = createService(store, executed);
    await service.start();

    const created = await service.addOnce({
      at: Date.now() + 10_000,
      action: announcement("выключить свет"),
      label: "выключить свет",
      runId: "run-1",
    });
    expect(created.id).toMatch(/^sched_/u);
    expect(service.activeCount()).toBe(1);
    expect(service.nextAt()).toBe(created.at);
    expect(await service.list()).toEqual([
      {
        id: created.id,
        at: created.at,
        label: "выключить свет",
        action: announcement("выключить свет"),
        createdAt: Date.now(),
        runId: "run-1",
      },
    ]);

    await expect(service.cancel(created.id)).resolves.toEqual({ cancelled: 1 });
    await expect(service.cancel(created.id)).resolves.toEqual({ cancelled: 0 });
    expect(service.activeCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(executed).toEqual([]);
    await service.stop();
  });

  it("fires at the scheduled moment", async () => {
    const store = openStore();
    const executed: string[] = [];
    const service = createService(store, executed);
    await service.start();

    const created = await service.addOnce({
      at: Date.now() + 3_000,
      action: announcement("tea"),
      label: "tea",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(executed).toEqual([created.id]);
    expect(store.get(created.id)?.status).toBe("executed");
    await service.stop();
  });

  it("cancels all pending entries", async () => {
    const store = openStore();
    const service = createService(store, []);
    await service.start();
    await service.addOnce({ at: Date.now() + 1_000, action: announcement("a"), label: "a" });
    await service.addOnce({ at: Date.now() + 2_000, action: announcement("b"), label: "b" });

    await expect(service.cancel("all")).resolves.toEqual({ cancelled: 2 });
    expect(service.activeCount()).toBe(0);
    await service.stop();
  });

  it("enforces maxActive and rejects past timestamps", async () => {
    const store = openStore();
    const service = createService(store, [], 2);
    await service.start();
    await service.addOnce({ at: Date.now() + 1_000, action: announcement("a"), label: "a" });
    await service.addOnce({ at: Date.now() + 2_000, action: announcement("b"), label: "b" });

    await expect(
      service.addOnce({ at: Date.now() + 3_000, action: announcement("c"), label: "c" }),
    ).rejects.toThrow(/слишком много активных задач/u);
    await expect(
      service.addOnce({ at: Date.now() - 1_000, action: announcement("c"), label: "c" }),
    ).rejects.toThrow(/время уже прошло/u);
    await expect(
      service.addOnce({ at: Date.now() + 4_000, action: announcement("c"), label: "  " }),
    ).rejects.toThrow(/label обязателен/u);
    await service.stop();
  });

  it("runs an entry immediately through runNow", async () => {
    const store = openStore();
    const executed: string[] = [];
    const service = createService(store, executed);
    await service.start();
    const created = await service.addOnce({
      at: Date.now() + 60_000,
      action: announcement("now"),
      label: "now",
    });

    await expect(service.runNow(created.id)).resolves.toEqual({ ok: true });
    expect(executed).toEqual([created.id]);
    const again = await service.runNow(created.id);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("не найдена");
    await service.stop();
  });

  it("executes recovered overdue entries on start", async () => {
    const store = openStore();
    const executed: string[] = [];
    store.insert(makeEntry("due", Date.now() - 30_000));
    store.insert(makeEntry("late", Date.now() - 15 * 60_000));
    const service = createService(store, executed);

    await service.start();
    expect(executed).toEqual(["due"]);
    expect(store.get("late")?.status).toBe("missed");
    await service.stop();
  });

  it("hides internal recurring chain entries from the user API", async () => {
    const store = openStore();
    const service = createService(store, []);
    await service.start();
    const now = Date.now();
    store.insert(makeEntry("recurring:rec-1:1", now + 5_000));
    store.insert(makeEntry("user", now + 10_000));
    service.runner().refresh();

    expect(service.activeCount()).toBe(1);
    await expect(service.list()).resolves.toEqual([
      {
        id: "user",
        at: now + 10_000,
        label: "task user",
        action: announcement("user"),
        createdAt: now + 9_000,
      },
    ]);
    expect(service.nextAt()).toBe(now + 10_000);

    await expect(service.cancel("all")).resolves.toEqual({ cancelled: 1 });
    expect(store.get("recurring:rec-1:1")?.status).toBe("pending");
    await service.stop();
  });

  it("does not count internal recurring entries towards maxActive", async () => {
    const store = openStore();
    const service = createService(store, [], 1);
    store.insert(makeEntry("recurring:rec-1:1", Date.now() + 5_000));
    await service.start();

    const created = await service.addOnce({
      at: Date.now() + 10_000,
      action: announcement("user"),
      label: "user",
    });
    expect(created.id).toMatch(/^sched_/u);
    await service.stop();
  });
});

describe("action executor", () => {
  function makeScheduledEntry(action: SchedulerAction): SchedulerEntry {
    return makeEntry("e1", Date.now(), action);
  }

  it("retries a failed HA call once after the retry delay", async () => {
    const ha = createTestHa();
    ha.callService.mockRejectedValueOnce(new Error("ha down")).mockResolvedValueOnce(undefined);
    const executor = createActionExecutor({
      ha,
      mcp: createTestMcp(),
      announce: async () => undefined,
      log,
      retryDelayMs: 2_000,
    });

    const haPromise = executor(
      makeScheduledEntry({
        kind: "ha.call_service",
        request: { domain: "light", service: "turn_on" },
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(haPromise).resolves.toBeUndefined();
    expect(ha.callService).toHaveBeenCalledTimes(2);
    expect(
      log.levelEntries("warn").some((entry) => entry.msg.includes("retrying once")),
    ).toBe(true);
  });

  it("reports the error after the retry also fails", async () => {
    const ha = createTestHa();
    ha.callService.mockRejectedValue(new Error("ha down"));
    const executor = createActionExecutor({
      ha,
      mcp: createTestMcp(),
      announce: async () => undefined,
      log,
      retryDelayMs: 500,
    });

    const expectation = expect(
      executor(
        makeScheduledEntry({
          kind: "ha.call_service",
          request: { domain: "light", service: "turn_on" },
        }),
      ),
    ).rejects.toThrow("ha down");
    await vi.advanceTimersByTimeAsync(500);
    await expectation;
    expect(ha.callService).toHaveBeenCalledTimes(2);
    expect(
      log.levelEntries("error").some((entry) => entry.msg.includes("failed after retry")),
    ).toBe(true);
  });

  it("performs announce actions through the injected callback", async () => {
    const ha = createTestHa();
    const announced: string[] = [];
    const executor = createActionExecutor({
      ha,
      mcp: createTestMcp(),
      announce: async (text) => {
        announced.push(text);
      },
      log,
    });

    await executor(makeScheduledEntry({ kind: "announce", text: "готово" }));
    expect(announced).toEqual(["готово"]);
    expect(ha.callService).not.toHaveBeenCalled();
  });

  it("raises when announce or MCP tool fails", async () => {
    const executor = createActionExecutor({
      ha: createTestHa(),
      mcp: {
        callTool: async () => ({ ok: false, error: "mcp nope" }),
      },
      announce: async () => {
        throw new Error("announce boom");
      },
      log,
    });

    await expect(
      executor(makeScheduledEntry({ kind: "announce", text: "x" })),
    ).rejects.toThrow("announce boom");
    await expect(
      executor(makeScheduledEntry({ kind: "mcp.tool", name: "mcp.s.t", args: {} })),
    ).rejects.toThrow("mcp nope");
  });
});
