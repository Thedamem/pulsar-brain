/**
 * SchedulerServiceLike implementation: the API the tools and HTTP layer consume.
 * Wraps the store + runner, enforces maxActive and keeps cancel idempotent.
 */

import { randomUUID } from "node:crypto";

import type {
  LoggerLike,
  SchedulerAction,
  SchedulerEntry,
  SchedulerServiceLike,
} from "../shared/types.js";
import type { SchedulerActionExecutor, SchedulerRunner } from "./runner.js";
import { createSchedulerRunner } from "./runner.js";
import { RECURRING_CHAIN_ENTRY_PREFIX } from "./store.js";
import type { SchedulerStore, StoredSchedulerEntry } from "./store.js";

/** Internal recurring fallback lifecycle (schedule/recurring-runner.ts satisfies it). */
export interface SchedulerRecurringLifecycle {
  start(): Promise<unknown>;
  stop(): void;
}

export interface SchedulerServiceDeps {
  store: SchedulerStore;
  execute: SchedulerActionExecutor;
  log: LoggerLike;
  /** Live config read: config.tools.scheduler.maxActive. */
  maxActive: number | (() => number);
  now?: () => number;
  graceMs?: number;
  idFactory?: () => string;
}

export interface RunNowResult {
  ok: boolean;
  error?: string;
}

export interface SchedulerService extends SchedulerServiceLike {
  /** Earliest pending timestamp, null when nothing is scheduled. */
  nextAt(): number | null;
  activeCount(): number;
  /** The underlying runner; needed to attach the recurring fallback. */
  runner(): SchedulerRunner;
  attachRecurring(lifecycle: SchedulerRecurringLifecycle): void;
  /** Start the attached recurring fallback (no-op when none is attached). */
  syncRecurring(): Promise<void>;
  runNow(id: string): Promise<RunNowResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function toPublicEntry(entry: StoredSchedulerEntry): SchedulerEntry {
  const result: SchedulerEntry = {
    id: entry.id,
    at: entry.at,
    label: entry.label,
    action: entry.action,
    createdAt: entry.createdAt,
  };
  if (entry.runId !== undefined) result.runId = entry.runId;
  return result;
}

function describeAction(action: SchedulerAction): string {
  switch (action.kind) {
    case "ha.call_service":
      return `${action.request.domain}.${action.request.service}`;
    case "announce":
      return `announce: ${action.text}`;
    case "mcp.tool":
      return `mcp.tool: ${action.name}`;
  }
}

export function createSchedulerService(deps: SchedulerServiceDeps): SchedulerService {
  const { store, log } = deps;
  const now = deps.now ?? Date.now;
  const idFactory = deps.idFactory ?? (() => `sched_${randomUUID()}`);
  const resolveMaxActive = (): number =>
    typeof deps.maxActive === "function" ? deps.maxActive() : deps.maxActive;

  const runnerDeps = {
    store,
    execute: deps.execute,
    log,
    now,
    ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
  };
  const runner = createSchedulerRunner(runnerDeps);

  let recurring: SchedulerRecurringLifecycle | null = null;
  let started = false;

  function listUserEntries(): StoredSchedulerEntry[] {
    return store
      .listActive()
      .filter((entry) => !entry.id.startsWith(RECURRING_CHAIN_ENTRY_PREFIX));
  }

  async function start(): Promise<void> {
    if (started) return;
    const report = await runner.start();
    if (recurring !== null) await recurring.start();
    started = true;
    log.info("scheduler: service started", {
      dueAfterRestart: report.due,
      missedAfterRestart: report.missed,
      active: listUserEntries().length,
    });
  }

  async function stop(): Promise<void> {
    if (!started) return;
    if (recurring !== null) recurring.stop();
    runner.stop();
    started = false;
    log.info("scheduler: service stopped");
  }

  async function addOnce(input: {
    at: number;
    action: SchedulerAction;
    label: string;
    runId?: string;
  }): Promise<{ id: string; at: number }> {
    const at = input.at;
    if (!Number.isFinite(at)) {
      throw new Error("время выполнения должно быть числом (ms эпохи)");
    }
    if (at <= now()) {
      throw new Error("время уже прошло");
    }
    const label = input.label.trim();
    if (label.length === 0) {
      throw new Error("label обязателен");
    }
    const maxActive = resolveMaxActive();
    if (!Number.isFinite(maxActive) || maxActive < 1) {
      throw new Error("scheduler.maxActive должен быть >= 1");
    }
    const active = listUserEntries();
    if (active.length >= maxActive) {
      throw new Error(`слишком много активных задач (лимит ${maxActive})`);
    }

    const entry: SchedulerEntry = {
      id: idFactory(),
      at,
      label,
      action: input.action,
      createdAt: now(),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    };
    store.insert(entry);
    runner.refresh();
    log.info("scheduler: entry added", {
      id: entry.id,
      at: iso(entry.at),
      label: entry.label,
      action: describeAction(entry.action),
    });
    return { id: entry.id, at: entry.at };
  }

  async function cancel(idOrAll: string): Promise<{ cancelled: number }> {
    const cancelled =
      idOrAll === "all"
        ? store.cancelAll(RECURRING_CHAIN_ENTRY_PREFIX)
        : store.remove(idOrAll)
          ? 1
          : 0;
    runner.refresh();
    log.info("scheduler: cancel requested", {
      target: idOrAll === "all" ? "all" : idOrAll,
      cancelled,
    });
    return { cancelled };
  }

  async function list(): Promise<SchedulerEntry[]> {
    return listUserEntries().map(toPublicEntry);
  }

  function nextAt(): number | null {
    const next = listUserEntries()[0];
    return next === undefined ? null : next.at;
  }

  function activeCount(): number {
    return listUserEntries().length;
  }

  async function runNow(id: string): Promise<RunNowResult> {
    try {
      const executed = await runner.runNow(id);
      if (!executed) return { ok: false, error: "Задача не найдена или уже выполнена" };
      return { ok: true };
    } catch (error) {
      log.error("scheduler: run-now failed", { id, error: errorMessage(error) });
      return { ok: false, error: errorMessage(error) };
    }
  }

  function attachRecurring(lifecycle: SchedulerRecurringLifecycle): void {
    recurring = lifecycle;
    if (started) {
      void lifecycle.start().catch((error: unknown) => {
        log.error("scheduler: recurring fallback failed to start", {
          error: errorMessage(error),
        });
      });
    }
  }

  async function syncRecurring(): Promise<void> {
    if (recurring === null) {
      log.debug("scheduler: no recurring fallback attached");
      return;
    }
    await recurring.start();
  }

  return {
    start,
    stop,
    addOnce,
    cancel,
    list,
    runNow,
    syncRecurring,
    nextAt,
    activeCount,
    runner: () => runner,
    attachRecurring,
  };
}
