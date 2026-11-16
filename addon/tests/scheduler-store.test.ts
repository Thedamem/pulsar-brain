import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSchedulerStore,
  DEFAULT_RECOVERY_GRACE_MS,
  defaultSchedulerDbPath,
  type SchedulerStore,
} from "../src/scheduler/store.js";
import type { SchedulerAction } from "../src/shared/types.js";
import { createTempDir, createTestLogger, makeEntry, type TempDir } from "./scheduler-support.js";

let temp: TempDir;
let stores: SchedulerStore[];

function openStore(file = "scheduler.db"): SchedulerStore {
  const store = createSchedulerStore(join(temp.path, file), createTestLogger());
  stores.push(store);
  return store;
}

beforeEach(() => {
  temp = createTempDir("pulsar-scheduler-store-");
  stores = [];
});

afterEach(() => {
  for (const store of stores) store.close();
  temp.cleanup();
});

describe("scheduler store: entries", () => {
  it("creates the schema idempotently and persists entries across reopen", () => {
    const at = Date.now() + 60_000;
    const first = openStore();
    first.insert(makeEntry("a", at));
    first.close();

    const second = openStore();
    const active = second.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe("a");
    expect(active[0]?.at).toBe(at);
    expect(active[0]?.status).toBe("pending");
    expect(active[0]?.executedAt).toBeNull();
  });

  it("stores and reads back every action kind without losing structure", () => {
    const store = openStore();
    const at = Date.now() + 60_000;
    store.insert(
      makeEntry("ha", at, {
        kind: "ha.call_service",
        request: {
          domain: "light",
          service: "turn_on",
          target: { entity_id: ["light.kitchen", "light.hall"] },
          data: { brightness_pct: 40 },
        },
      }),
    );
    store.insert(makeEntry("announce", at + 1, { kind: "announce", text: "привет" }));
    store.insert(
      makeEntry("mcp", at + 2, { kind: "mcp.tool", name: "mcp.server.ping", args: { host: "x" } }),
    );

    expect(store.get("ha")?.action).toEqual({
      kind: "ha.call_service",
      request: {
        domain: "light",
        service: "turn_on",
        target: { entity_id: ["light.kitchen", "light.hall"] },
        data: { brightness_pct: 40 },
      },
    });
    expect(store.get("announce")?.action).toEqual({ kind: "announce", text: "привет" });
    expect(store.get("mcp")?.action).toEqual({
      kind: "mcp.tool",
      name: "mcp.server.ping",
      args: { host: "x" },
    });
  });

  it("orders active entries by time and applies listAll limit", () => {
    const store = openStore();
    const now = Date.now();
    store.insert(makeEntry("late", now + 30_000));
    store.insert(makeEntry("soon", now + 1_000));
    store.insert(makeEntry("middle", now + 10_000));

    expect(store.listActive().map((entry) => entry.id)).toEqual(["soon", "middle", "late"]);
    expect(store.listAll(2)).toHaveLength(2);
  });

  it("marks executed once and keeps the row for history", () => {
    const store = openStore();
    const at = Date.now() + 1_000;
    store.insert(makeEntry("a", at));

    expect(store.markExecuted("a", at)).toBe(true);
    expect(store.markExecuted("a", at)).toBe(false);

    const stored = store.get("a");
    expect(stored?.status).toBe("executed");
    expect(stored?.executedAt).toBe(at);
    expect(store.listActive()).toHaveLength(0);
    expect(store.listAll()).toHaveLength(1);
  });

  it("removes pending entries idempotently and cancels everything", () => {
    const store = openStore();
    const now = Date.now();
    store.insert(makeEntry("a", now + 1_000));
    store.insert(makeEntry("b", now + 2_000));

    expect(store.remove("a")).toBe(true);
    expect(store.remove("a")).toBe(false);
    store.insert(makeEntry("c", now + 3_000));
    expect(store.cancelAll()).toBe(2);
    expect(store.listActive()).toHaveLength(0);
  });

  it("keeps internal recurring chain entries when cancelling everything", () => {
    const store = openStore();
    const now = Date.now();
    store.insert(makeEntry("recurring:rec-1:1", now + 1_000));
    store.insert(makeEntry("user", now + 2_000));

    expect(store.cancelAll("recurring:")).toBe(1);
    expect(store.get("recurring:rec-1:1")?.status).toBe("pending");
    expect(store.get("user")).toBeNull();
  });

  it("rejects corrupted action JSON instead of returning garbage", () => {
    const dbPath = join(temp.path, "scheduler.db");
    const store = openStore();
    store.insert(makeEntry("a", Date.now() + 1_000));
    store.close();

    const raw = new Database(dbPath);
    raw.prepare("UPDATE entries SET action_json = ? WHERE id = ?").run('{"kind":"bogus"}', "a");
    raw.close();

    const reopened = openStore();
    expect(() => reopened.get("a")).toThrow(/unknown action kind/u);
  });
});

describe("scheduler store: restart recovery", () => {
  it("classifies due and missed entries and persists the missed status", () => {
    const store = openStore();
    const now = Date.now();
    store.insert(makeEntry("due", now - 60_000));
    store.insert(makeEntry("late", now - 10 * 60_000));
    store.insert(makeEntry("future", now + 60_000));

    const recovery = store.recoverAfterRestart(now, DEFAULT_RECOVERY_GRACE_MS);
    expect(recovery.due.map((entry) => entry.id)).toEqual(["due"]);
    expect(recovery.missed.map((entry) => entry.id)).toEqual(["late"]);
    expect(store.get("due")?.status).toBe("pending");
    expect(store.get("late")?.status).toBe("missed");
    expect(store.get("future")?.status).toBe("pending");

    store.close();
    const reopened = openStore();
    expect(reopened.get("late")?.status).toBe("missed");
  });

  it("honours a custom grace window", () => {
    const store = openStore();
    const now = Date.now();
    store.insert(makeEntry("a", now - 30_000));

    const recovery = store.recoverAfterRestart(now, 10_000);
    expect(recovery.due).toHaveLength(0);
    expect(recovery.missed.map((entry) => entry.id)).toEqual(["a"]);
  });
});

describe("scheduler store: recurring rules", () => {
  const action: SchedulerAction = { kind: "announce", text: "доброе утро" };

  it("inserts, lists, updates and removes recurring rules", () => {
    const store = openStore();
    const now = Date.now();
    store.insertRecurring({
      id: "rec-1",
      label: "Утренний свет",
      specJson: JSON.stringify({ kind: "daily", time: "08:30" }),
      action,
      nextAt: now + 86_400_000,
      createdAt: now,
    });

    const listed = store.listRecurring();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.specJson).toBe('{"kind":"daily","time":"08:30"}');
    expect(listed[0]?.action).toEqual(action);

    expect(store.updateRecurringNext("rec-1", now + 172_800_000)).toBe(true);
    expect(store.getRecurring("rec-1")?.nextAt).toBe(now + 172_800_000);
    expect(store.updateRecurringNext("missing", now)).toBe(false);

    expect(store.removeRecurring("rec-1")).toBe(true);
    expect(store.removeRecurring("rec-1")).toBe(false);
    expect(store.listRecurring()).toHaveLength(0);
  });
});

describe("defaultSchedulerDbPath", () => {
  it("uses PULSAR_BRAIN_DATA_DIR and falls back to ./data", () => {
    expect(defaultSchedulerDbPath({})).toBe(join("data", "scheduler.db"));
    expect(defaultSchedulerDbPath({ PULSAR_BRAIN_DATA_DIR: "/tmp/pulsar-data" })).toBe(
      join("/tmp/pulsar-data", "scheduler.db"),
    );
    expect(defaultSchedulerDbPath({ PULSAR_BRAIN_DATA_DIR: "   " })).toBe(
      join("data", "scheduler.db"),
    );
  });
});
